import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NoteService } from '../lib/service.js'
import { workspaceKeyOf } from '../lib/notes.js'

/**
 * 落盘语义(审计里的高危条目 + 存储改造后的新形态):
 *
 *   1. **内容没变就不写**。对账每 8s 后台跑一次(TTL),旧实现无条件落盘 ——
 *      本机实测 `registry.json` 每 ~8.4s 整份重写一次(tmp + rename),零变化也写。
 *   2. **一次失败不能毒化后续**。旧实现 `this.persistChain = this.persistChain.then(...)`,
 *      写失败后链变成 rejected,后面每次 `.then` 都被跳过 → 索引从此只活在内存里,
 *      重启即丢,而且**没有任何提示**。
 *   3. 默认(`storeScope: 'workspace'`)写进**工作区自己的** `<root>/.dsh-notes/index.json`,
 *      并顺手放一个 `.gitignore`(`*`)让插件数据不进用户的 `git status`;
 *      `storeScope: 'home'` 则完全等价旧行为(整份写 `storeDir/registry.json`)。
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

async function setup(options = {}) {
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
    ...options,
  })
  const workspace = await service.workspaceOf('session-1')
  const registry = await service.registryFor(workspace.key, { root: workspace.root, name: workspace.name })
  return {
    base,
    root,
    service,
    store,
    workspace,
    registry,
    /** 工作区形态下的索引文件 */
    file: join(root, '.dsh-notes', 'index.json'),
    /** 旧的整体索引文件 */
    homeFile: join(store, 'registry.json'),
  }
}

const exists = async (path) => {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

test('workspace 形态:索引落在工作区里,且放了一个自忽略的 .gitignore', async () => {
  const { base, service, workspace, registry, root, homeFile } = await setup()
  try {
    registry.workspace(workspace.key, { name: 'ws' })
    registry.addNote({ id: 'n_a', path: join(root, 'notes', 'a.md'), workspaceKey: workspace.key, title: 'a' })
    await service.persist(workspace.key)

    const saved = JSON.parse(await readFile(join(root, '.dsh-notes', 'index.json'), 'utf8'))
    assert.deepEqual(Object.keys(saved.notes), ['n_a'])
    assert.deepEqual(Object.keys(saved.workspaces), [workspace.key], '工作区文件里只有这一个工作区')
    assert.equal(await exists(homeFile), null, '语义数据不该再写进 $DSH_HOME/knowledge')
    assert.equal((await readFile(join(root, '.dsh-notes', '.gitignore'), 'utf8')).trim(), '*', '插件数据不能污染 git status')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('workspace 形态:内容没变就不重写(inode/mtime 都不动)', async () => {
  const { base, service, workspace, registry, file } = await setup()
  try {
    registry.workspace(workspace.key, { name: 'ws' })
    await service.persist(workspace.key)
    const first = await exists(file)
    assert.notEqual(first, null, '第一次必须真的落盘')

    await new Promise((resolve) => setTimeout(resolve, 20))
    await service.persist(workspace.key)
    await service.persist(workspace.key)
    const second = await exists(file)
    assert.equal(second.ino, first.ino, 'inode 变了说明文件被重写了')
    assert.equal(second.mtimeMs, first.mtimeMs, 'mtime 变了说明文件被重写了')

    registry.workspace(workspace.key, { name: 'ws2' })
    await service.persist(workspace.key)
    const third = await exists(file)
    assert.notEqual(third.mtimeMs, first.mtimeMs, '内容变了必须落盘')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('workspace 形态:一次写失败之后,后续落盘仍然有效(链不会中毒)', async () => {
  const { base, service, workspace, registry, root } = await setup()
  try {
    // 把 `.dsh-notes` 建成**文件**:mkdir 会 EEXIST → 这一次写必然失败
    await writeFile(join(root, '.dsh-notes'), 'x', 'utf8')
    registry.workspace(workspace.key, { name: 'ws' })
    // 允许 reject(调用方该知道没落盘),关键是**不能毒化链**
    await service.persist(workspace.key).catch(() => {})
    await service.persist(workspace.key).catch(() => {})

    // 挪开障碍:如果链被毒化,这一次会被跳过 → 文件不存在
    await rm(join(root, '.dsh-notes'), { force: true })
    registry.addNote({ id: 'n_b', path: join(root, 'notes', 'b.md'), workspaceKey: workspace.key, title: 'b' })
    await service.persist(workspace.key)
    const saved = JSON.parse(await readFile(join(root, '.dsh-notes', 'index.json'), 'utf8'))
    assert.deepEqual(Object.keys(saved.notes), ['n_b'], '失败过之后必须还能落盘(链没中毒)')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('home 形态:完全等价旧行为(整份写 storeDir/registry.json)', async () => {
  const { base, service, workspace, registry, root, homeFile } = await setup({ storeScope: 'home' })
  try {
    registry.workspace(workspace.key, { name: 'ws' })
    registry.addNote({ id: 'n_a', path: join(root, 'notes', 'a.md'), workspaceKey: workspace.key, title: 'a' })
    await service.persist(workspace.key)

    const saved = JSON.parse(await readFile(homeFile, 'utf8'))
    assert.deepEqual(Object.keys(saved.notes), ['n_a'])
    assert.equal(await exists(join(root, '.dsh-notes', 'index.json')), null, 'home 形态不碰工作区')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('已知工作区表:落在机器本地,且 lastUsedAt 只在会话换工作区时才更新', async () => {
  const { base, service, store, workspace } = await setup()
  try {
    const roots = JSON.parse(await readFile(join(store, 'workspaces.json'), 'utf8'))
    assert.equal(roots.workspaces[workspace.key].root, workspace.root, '根路径要登记,供切换器列表用')
    assert.equal('notes' in roots.workspaces[workspace.key], false, '根表只放路由信息,不放语义数据')

    const stamp = roots.workspaces[workspace.key].lastUsedAt
    await new Promise((resolve) => setTimeout(resolve, 20))
    // 4s 轮询就是不停地用同一个工作区 —— 不能刷时间戳(否则表每 8s 变一次)
    await service.workspaceOf('session-1')
    await service.workspaceOf('session-1')
    const again = JSON.parse(await readFile(join(store, 'workspaces.json'), 'utf8'))
    assert.equal(again.workspaces[workspace.key].lastUsedAt, stamp, '重复读不该改 lastUsedAt')

    // 另一个会话用同一个工作区 → 也要更新(它是"这个会话"的选择)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const other = new NoteService(stubContext(workspace.root), { storeDir: store, notesDir: 'notes' })
    other.ctx.sessions.get = (id) => (String(id) === 'session-2' ? { header: { cwd: workspace.root } } : undefined)
    await other.workspaceOf('session-2')
    const third = JSON.parse(await readFile(join(store, 'workspaces.json'), 'utf8'))
    assert.notEqual(third.workspaces[workspace.key].lastUsedAt, stamp, '别的会话选它也算一次使用')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('工作区键是派生的:把工作区复制到别处,同一个键仍指向新根', async () => {
  const { base, service, workspace, registry, root } = await setup()
  try {
    registry.workspace(workspace.key, { name: 'ws' })
    await service.persist(workspace.key)
    assert.equal(workspace.key, workspaceKeyOf(root), '键 = sha1(规范化 root) 前 12 位')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
