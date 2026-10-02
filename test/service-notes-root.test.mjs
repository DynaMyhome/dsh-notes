import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NoteService } from '../lib/service.js'
import { toPosix } from '../lib/notes.js'

/**
 * 「工作区没有笔记根目录」与「给工作区换一个笔记根」。
 *
 * 兜的是用户实测的两个问题:
 *   1. 切到没有 notes/ 的工作区时,已登记的笔记被当成"文件没了"从树里删掉;
 *   2. 报错直接透传 provider 的英文原文(`cannot list "…/notes": not found`)。
 */

function realContext(root) {
  const session = { header: { cwd: root } }
  return {
    sessions: { get: (id) => (String(id) === 'session-1' ? session : undefined) },
    sandboxPolicy: { resolve: () => undefined },
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
      readByteRange: async (target, range) => (await readFile(target.path)).subarray(range.offset, range.offset + range.length),
      writeText: async (target, text) => {
        await writeFile(target.path, text, 'utf8')
        return { version: 'v1' }
      },
      listDir: async (target) => {
        const entries = await readdir(target.path, { withFileTypes: true })
        return Promise.all(
          entries.map(async (entry) => {
            let version
            let size
            try {
              const info = await stat(join(target.path, entry.name))
              version = String(info.mtimeMs)
              size = info.size
            } catch {
              version = ''
            }
            return {
              name: entry.name,
              type: entry.isDirectory() ? 'directory' : 'file',
              target: { path: join(target.path, entry.name) },
              version,
              size,
            }
          }),
        )
      },
      watch: async () => async () => {},
    },
    logger: undefined,
    inject: () => () => {},
  }
}

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-root-'))
  const root = join(base, 'ws')
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'docs', '指南.md'), '---\ndsh-note-id: n_guide\n---\n\n# 指南\n', 'utf8')
  // 故意**不建** notes/
  const service = new NoteService(realContext(root), {
    notesDir: 'notes',
    assetsDir: '.dsh-assets',
    storeDir: join(base, 'store'),
    scanTtlMs: 8000,
    unfiledMax: 200,
    autosaveMs: 800,
    pasteImage: 'copy',
    watch: false,
  })
  return { base, root, service }
}

async function cleanup(base, service) {
  service.dispose()
  await new Promise((resolve) => setTimeout(resolve, 300))
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

test('没有 notes/ 的工作区:笔记不会被当"文件没了"删掉,并标记 notesDirMissing', async () => {
  const { base, root, service } = await setup()
  try {
    const note = await service.register({ sessionId: 'session-1', path: join(root, 'docs', '指南.md') })

    const tree = await service.tree({ sessionId: 'session-1', force: true })
    assert.equal(tree.notesDirMissing, true, '要如实告诉界面"还没有笔记根"')
    assert.equal(tree.notes.some((item) => item.id === note.id), true, '工作区里的笔记必须还在')
    assert.equal((await service.noteById(note.id)) !== undefined, true, '索引条目不能被删')
    assert.equal(tree.scanReport.incomplete, true, '这次扫描是不完整的')
  } finally {
    await cleanup(base, service)
  }
})

test('createNotesDir:创建笔记根、幂等、只允许工作区内', async () => {
  const { base, root, service } = await setup()
  try {
    const first = await service.createNotesDir({ sessionId: 'session-1' })
    assert.equal(first.created, true)
    assert.equal(first.path, toPosix(join(root, 'notes')))
    assert.equal((await stat(join(root, 'notes'))).isDirectory(), true)

    const again = await service.createNotesDir({ sessionId: 'session-1' })
    assert.equal(again.created, false, '已存在就别再动它')

    // 建完再取树:不再缺根,而且能看到 notes/ 里的内容(现在是空的)
    const tree = await service.tree({ sessionId: 'session-1', force: true })
    assert.equal(tree.notesDirMissing, false)

    // 工作区之外一律拒绝
    await assert.rejects(
      () => service.createNotesDir({ sessionId: 'session-1', path: join(base, 'outside') }),
      /工作区之内/,
    )
    // 工作区内的嵌套目录可以建
    const nested = await service.createNotesDir({ sessionId: 'session-1', path: 'sub/deep' })
    assert.equal(nested.created, true)
    assert.equal((await stat(join(root, 'sub', 'deep'))).isDirectory(), true)
  } finally {
    await cleanup(base, service)
  }
})

test('setNotesRoot:把已有目录设为该工作区的笔记根,并按它扫描', async () => {
  const { base, root, service } = await setup()
  try {
    const note = await service.register({ sessionId: 'session-1', path: join(root, 'docs', '指南.md') })
    const result = await service.setNotesRoot({ sessionId: 'session-1', path: 'docs' })
    assert.equal(result.notesRoot, toPosix(join(root, 'docs')))

    const tree = await service.tree({ sessionId: 'session-1', force: true })
    assert.equal(tree.workspace.notesRoot, toPosix(join(root, 'docs')), '树要用新的笔记根')
    assert.equal(tree.notesDirMissing, false)
    assert.equal(tree.notes.some((item) => item.id === note.id), true)

    // 不存在 / 越界 都要拒绝
    await assert.rejects(() => service.setNotesRoot({ sessionId: 'session-1', path: 'nope' }), /目录不存在/)
    await assert.rejects(() => service.setNotesRoot({ sessionId: 'session-1', path: join(base, 'outside') }), /工作区之内/)
  } finally {
    await cleanup(base, service)
  }
})
