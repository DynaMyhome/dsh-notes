import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NoteService } from '../lib/service.js'

/**
 * 索引落盘的两条硬要求(用户审计里的一条是高危):
 *
 *   1. **内容没变就不写**。对账每 8s 后台跑一次(TTL),旧实现无条件 `persist()` ——
 *      本机实测 `registry.json` 每 ~8.4s 整份重写一次(tmp + rename),零变化也写。
 *   2. **一次失败不能毒化后续**。旧实现 `this.persistChain = this.persistChain.then(...)`,
 *      写失败后链变成 rejected,后面每次 `.then` 都被跳过 → 索引从此只活在内存里,
 *      重启即丢,而且**没有任何提示**。
 */

/** 最小 ctx:不需要真文件系统(这一组只测落盘)。 */
function stubContext(root) {
  const session = { header: { cwd: root } }
  return {
    sessions: { get: (id) => (String(id) === 'session-1' ? session : undefined) },
    sandboxPolicy: { resolve: () => undefined },
    fs: {
      resolve: async (path) => ({ path }),
      processPath: (target) => String(target?.path ?? target),
      stat: async () => undefined,
      readText: async (target) => readFile(target.path, 'utf8'),
      writeText: async () => ({ version: 'v1' }),
      listDir: async () => [],
      watch: async () => async () => {},
    },
    logger: undefined,
    inject: () => () => {},
  }
}

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-persist-'))
  const root = join(base, 'ws')
  await mkdir(root, { recursive: true })
  const store = join(base, 'store')
  const service = new NoteService(stubContext(root), {
    notesDir: 'notes',
    assetsDir: '.dsh-assets',
    storeDir: store,
    scanTtlMs: 8000,
    unfiledMax: 200,
  })
  await service.ensureLoaded()
  return { base, service, store, file: join(store, 'registry.json') }
}

const exists = async (path) => {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

test('persist:内容没变时不重写(消掉每 8s 的整份重写)', async () => {
  const { base, service, file } = await setup()
  try {
    service.registry.workspace('ws-A', { name: 'A', root: '/tmp/A', notesRoot: '/tmp/A/notes' })
    await service.persist()
    const first = await exists(file)
    assert.notEqual(first, null, '第一次必须真的落盘')

    // 再落两次:内容没变 → 不该动文件(inode/mtime 都不变)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await service.persist()
    await service.persist()
    const second = await exists(file)
    assert.equal(second.ino, first.ino, 'inode 变了说明文件被重写了')
    assert.equal(second.mtimeMs, first.mtimeMs, 'mtime 变了说明文件被重写了')

    // 真变了才写
    service.registry.workspace('ws-B', { name: 'B', root: '/tmp/B', notesRoot: '/tmp/B/notes' })
    await service.persist()
    const third = await exists(file)
    assert.notEqual(third.mtimeMs, first.mtimeMs, '内容变了必须落盘')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(Object.keys(saved.workspaces).includes('ws-B'), true, '新状态要写进去')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('workspaceOf:同一会话重复读**不**刷新 lastUsedAt(否则索引每 8s 变一次)', async () => {
  const { base, service } = await setup()
  try {
    service.registry.workspace('ws-A', { name: 'A', root: '/tmp/A', notesRoot: '/tmp/A/notes' })
    service.registry.workspace('ws-B', { name: 'B', root: '/tmp/B', notesRoot: '/tmp/B/notes' })
    const first = await service.workspaceOf('session-1', 'ws-A')
    const stamp = first.node.lastUsedAt
    assert.equal(typeof stamp, 'number')
    await new Promise((resolve) => setTimeout(resolve, 20))
    // 4s 轮询就是不停地用同一个 key 读 —— 不能刷新时间戳
    await service.workspaceOf('session-1', 'ws-A')
    await service.workspaceOf('session-1', 'ws-A')
    assert.equal(service.registry.workspaceOf('ws-A').lastUsedAt, stamp, '重复读不该改 lastUsedAt')
    // 真换了工作区才更新
    await new Promise((resolve) => setTimeout(resolve, 20))
    const switched = await service.workspaceOf('session-1', 'ws-B')
    assert.notEqual(switched.node.lastUsedAt, stamp, '换工作区要更新 lastUsedAt')
    // 另一个会话选同一个工作区 → 也算一次使用(它是"这个会话"的选择)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const other = await service.workspaceOf('session-2', 'ws-A')
    assert.notEqual(other.node.lastUsedAt, stamp, '别的会话选它也算一次使用')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('persist:一次写失败之后,后续落盘仍然有效(链不会中毒)', async () => {
  const { base, service, file } = await setup()
  try {
    const good = service.storeFile()
    // 让 storeFile() 指到一个"必失败"的位置:父路径是个**文件**,mkdir 会 ENOTDIR
    const blocker = join(base, 'blocker')
    await writeFile(blocker, 'x', 'utf8')
    service.config.storeDir = blocker

    service.registry.workspace('ws-A', { name: 'A', root: '/tmp/A', notesRoot: '/tmp/A/notes' })
    // 这两次写不进去:**允许 reject**(调用方该知道索引没落盘,旧行为也是这样),
    // 关键是**不能毒化链** —— 所以这里只吞掉,后面证明"再写还能成"。
    await service.persist().catch(() => {})
    await service.persist().catch(() => {})
    assert.equal(await exists(join(blocker, 'registry.json')), null, '坏路径当然写不进去')

    // 换回好路径:如果链被毒化,这一次会被跳过 → 文件不存在
    service.config.storeDir = join(base, 'store')
    service.registry.workspace('ws-B', { name: 'B', root: '/tmp/B', notesRoot: '/tmp/B/notes' })
    await service.persist()
    const saved = await exists(good)
    assert.notEqual(saved, null, '失败过之后必须还能落盘(链没中毒)')
    const state = JSON.parse(await readFile(good, 'utf8'))
    assert.equal(Object.keys(state.workspaces).includes('ws-B'), true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
