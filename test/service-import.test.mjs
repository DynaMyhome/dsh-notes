import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NoteService } from '../lib/service.js'

/**
 * 有状态的假 fs:写过的路径才认为存在,写进去的内容能读回来。
 * 这样 `importFile → register` 这条真实链路能在不碰用户文件的前提下跑通。
 */
function fakeFs() {
  const files = new Map()
  return {
    files,
    resolve: async (path) => ({ path }),
    processPath: (target) => (typeof target === 'string' ? target : target.path),
    stat: async (target) => {
      const path = typeof target === 'string' ? target : target.path
      return files.has(path) ? { type: 'file', version: `v${files.get(path).length}` } : undefined
    },
    readText: async (target) => {
      const path = typeof target === 'string' ? target : target.path
      const value = files.get(path)
      if (value === undefined) throw new Error(`ENOENT ${path}`)
      return value
    },
    writeText: async (target, text, intent) => {
      const path = typeof target === 'string' ? target : target.path
      if (intent?.kind === 'createIfAbsent' && files.has(path)) throw Object.assign(new Error('EXISTS'), { code: 'EXISTS' })
      files.set(path, text)
      return { version: `v${text.length}` }
    },
    listDir: async () => [],
    watch: async () => async () => {},
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-notes-import-'))
  const fs = fakeFs()
  const ctx = {
    sessions: { get: () => ({ header: { cwd: root } }) },
    sandboxPolicy: { resolve: () => undefined },
    fs,
    logger: undefined,
    inject: () => () => {},
  }
  const service = new NoteService(ctx, {
    notesDir: 'notes',
    assetsDir: '.dsh-assets',
    storeDir: join(root, 'store'),
    unfiledDepth: 3,
    scanTtlMs: 8000,
    unfiledMax: 200,
    autosaveMs: 800,
    pasteImage: 'copy',
    watch: false,
  })
  return { service, fs, root }
}

test('importFile: 外部 .md 导入成笔记(补 dsh-note-id、登记、标题取文件名)', async () => {
  const { service, fs, root } = await setup()
  try {
    const note = await service.importFile({
      sessionId: 'session-1',
      name: '外部笔记.md',
      text: '# 外部标题\n\n正文',
    })
    // 标题 = 文件名(H1 不再影响);正文原样保留
    assert.equal(note.title, '外部笔记')
    assert.match(note.path, /notes\/外部笔记\.md$/)
    const written = fs.files.get(note.path)
    assert.match(written, /dsh-note-id: n_/)
    assert.match(written, /# 外部标题/)

    // 重名 → 自动加序号,不覆盖已有文件
    const again = await service.importFile({ sessionId: 'session-1', name: '外部笔记.md', text: '第二份' })
    assert.notEqual(again.path, note.path)
    assert.match(again.path, /外部笔记 2\.md$/)

    // 非法名被拒
    await assert.rejects(() => service.importFile({ sessionId: 'session-1', name: '', text: 'x' }), /需要 name/)
    await assert.rejects(() => service.importFile({ sessionId: 'session-1', name: 'a.md' }), /需要 text/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pin: 置顶/取消置顶写进本工作区 pins', async () => {
  const { service, fs, root } = await setup()
  try {
    const note = await service.importFile({ sessionId: 'session-1', name: '甲.md', text: '# 甲' })
    const workspace = await service.workspaceOf('session-1')
    await service.pin({ sessionId: 'session-1', noteId: note.id, pinned: true })
    const registry = await service.ensureLoaded()
    assert.deepEqual(registry.toJSON().workspaces[workspace.key].pins, [note.id])

    await service.pin({ sessionId: 'session-1', noteId: note.id, pinned: false })
    assert.deepEqual(registry.toJSON().workspaces[workspace.key].pins, [])

    await assert.rejects(() => service.pin({ sessionId: 'session-1', noteId: 'n_nope' }), /笔记不存在/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
