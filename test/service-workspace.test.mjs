import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NoteService } from '../lib/service.js'
import { workspaceKeyOf } from '../lib/notes.js'

/**
 * 工作区切换(笔记区域可以看别的已登记工作区)。
 *
 * 关键约束:显式 workspaceKey **只认已登记的**;用户侧写入的**模式**仍来自会话
 * (read-only 依旧只读),但**边界根**换成目标工作区。
 */

function realContext(roots) {
  return {
    // 两个会话,各自的 cwd 不同
    sessions: { get: (id) => (roots[id] === undefined ? undefined : { header: { cwd: roots[id] } }) },
    sandboxPolicy: {
      resolve: ({ session }) => ({
        mode: 'workspace-write',
        workspaceRoot: session?.header?.cwd ?? '',
        sessionId: 'stub',
      }),
    },
    fs: {
      resolve: async (path) => ({ path }),
      processPath: (target) => String(target?.path ?? target),
      stat: async (target) => {
        try {
          const value = await stat(target.path)
          return { type: value.isDirectory() ? 'directory' : 'file', version: String(value.mtimeMs) }
        } catch {
          return undefined
        }
      },
      readText: async (target) => readFile(target.path, 'utf8'),
      writeText: async (target, text) => {
        await writeFile(target.path, text, 'utf8')
        return { version: String((await stat(target.path)).mtimeMs) }
      },
      listDir: async (target) => {
        const { readdir } = await import('node:fs/promises')
        return (await readdir(target.path, { withFileTypes: true })).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          target: { path: join(target.path, entry.name) },
        }))
      },
      watch: async () => async () => {},
    },
    logger: undefined,
    inject: () => () => {},
  }
}

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-ws-'))
  const rootA = join(base, 'ws-a')
  const rootB = join(base, 'ws-b')
  await mkdir(join(rootA, 'notes'), { recursive: true })
  await mkdir(join(rootB, 'notes'), { recursive: true })
  await writeFile(join(rootB, 'notes', '乙.md'), '---\ndsh-note-id: n_yi\n---\n\n# 乙\n', 'utf8')
  const service = new NoteService(realContext({ 'session-1': rootA, 'session-2': rootB }), {
    notesDir: 'notes',
    assetsDir: '.dsh-assets',
    storeDir: join(base, 'store'),
    scanTtlMs: 8000,
    unfiledMax: 200,
    autosaveMs: 800,
    pasteImage: 'copy',
    watch: false,
  })
  return { base, rootA, rootB, service }
}

test('workspaceOf:显式 workspaceKey 只看已登记的;未知 key 直接报错', async () => {
  const { base, rootA, rootB, service } = await setup()
  try {
    const a = await service.workspaceOf('session-1')
    assert.equal(a.root, rootA)
    const keyB = workspaceKeyOf(rootB)
    await service.openWorkspace({ sessionId: 'session-1', root: rootB })

    const viaKey = await service.workspaceOf('session-1', keyB)
    assert.equal(viaKey.root, rootB, '显式 key 优先于会话 cwd')
    assert.equal(viaKey.notesRoot, join(rootB, 'notes'))

    await assert.rejects(() => service.workspaceOf('session-1', 'nope'), /未登记的工作区/)
  } finally {
    service.dispose()
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('listWorkspaces / openWorkspace:列已登记 + 标出会话自己的工作区', async () => {
  const { base, rootA, rootB, service } = await setup()
  try {
    await service.workspaceOf('session-1') // 登记 A
    await service.openWorkspace({ sessionId: 'session-1', root: rootB })

    const list = await service.listWorkspaces({ sessionId: 'session-1' })
    assert.equal(list.current, workspaceKeyOf(rootA))
    assert.deepEqual(list.workspaces.map((item) => item.root).sort(), [rootA, rootB].sort())
    assert.equal(list.workspaces.find((item) => item.root === rootA).isSession, true)
    assert.equal(list.workspaces.find((item) => item.root === rootB).isSession, false)

    await assert.rejects(() => service.openWorkspace({ sessionId: 'session-1', root: join(base, 'nope') }), /目录不存在/)
    await assert.rejects(() => service.openWorkspace({ sessionId: 'session-1', root: 'relative/path' }), /绝对路径/)
  } finally {
    service.dispose()
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('跨工作区读写:内容路由带 workspaceKey 就能操作那边的文件', async () => {
  const { base, rootB, service } = await setup()
  try {
    const keyB = (await service.openWorkspace({ sessionId: 'session-1', root: rootB })).key
    const file = join(rootB, 'notes', '乙.md')

    await service.register({ sessionId: 'session-1', workspaceKey: keyB, path: file })
    const tree = await service.tree({ sessionId: 'session-1', workspaceKey: keyB, force: true })
    assert.deepEqual(tree.notes.map((note) => note.title), ['乙'], '取到的是 B 的树')

    const read = await service.readNote({ sessionId: 'session-1', workspaceKey: keyB, path: file })
    assert.match(read.text, /# 乙/)

    const info = await service.ctx.fs.stat({ path: file })
    await service.save({
      sessionId: 'session-1',
      workspaceKey: keyB,
      path: file,
      text: '---\ndsh-note-id: n_yi\n---\n\n# 乙 改过\n',
      expectedVersion: info.version,
    })
    assert.match(await readFile(file, 'utf8'), /乙 改过/, '写到 B 的文件里了')
  } finally {
    service.dispose()
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('policyFor:模式来自会话(read-only 仍只读),边界根换成目标工作区', async () => {
  const { base, rootA, rootB, service } = await setup()
  try {
    const basePolicy = service.policyOf('session-1')
    assert.equal(basePolicy.workspaceRoot, rootA)
    assert.equal(basePolicy.mode, 'workspace-write')
    const swapped = service.policyFor('session-1', rootB)
    assert.equal(swapped.mode, 'workspace-write', '模式没变')
    assert.equal(swapped.workspaceRoot, rootB, '边界根换成了目标工作区')
    // 同一个根时原样返回(不做无谓的对象创建)
    assert.deepEqual(service.policyFor('session-1', rootA), basePolicy, '同一个根:字段一致(不动它)')
  } finally {
    service.dispose()
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
