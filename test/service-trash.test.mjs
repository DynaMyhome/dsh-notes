import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NoteService } from '../lib/service.js'
import { toPosix } from '../lib/notes.js'

/**
 * 回收站的服务层测试(**用真文件**,因为 trash/restore 走的是 node:fs 的 rename/copy)。
 *
 * 兜住的是"删了但没进回收站""恢复后文件没了""彻底删除没删干净"这三类:
 * 它们都只在真实文件系统上才暴露。
 */

/** 造一个够用的 ctx:`sessionId → 工作区 cwd`,fs 直接落到真目录。 */
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
      writeText: async (target, text) => {
        await writeFile(target.path, text, 'utf8')
        return { version: 'v1' }
      },
      listDir: async () => [],
      watch: async () => async () => {},
    },
    logger: undefined,
    inject: () => () => {},
  }
}

/** 建一个真实工作区 + 服务。 */
async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-trash-'))
  const root = join(base, 'ws')
  const storeDir = join(base, 'store')
  await mkdir(join(root, 'notes'), { recursive: true })
  const file = join(root, 'notes', '甲.md')
  await writeFile(file, '---\ndsh-note-id: n_jia\n---\n\n# 甲\n', 'utf8')
  const service = new NoteService(realContext(root), {
    notesDir: 'notes',
    assetsDir: '.dsh-assets',
    storeDir,
    unfiledDepth: 3,
    scanTtlMs: 8000,
    unfiledMax: 200,
    autosaveMs: 800,
    pasteImage: 'copy',
    watch: false,
  })
  const registered = await service.register({ sessionId: 'session-1', path: file })
  return { base, root, storeDir, service, file, noteId: registered.id }
}

/** 文件在不在。 */
const exists = (path) => stat(path).then(() => true, () => false)

test('回收站:删除 = 移入回收站(原文件消失、回收站里有一条、索引里没了)', async () => {
  const { base, service, file, noteId } = await setup()
  try {
    const result = await service.trashNote({ sessionId: 'session-1', noteId })
    assert.equal(result.title, '甲')
    assert.equal(await exists(file), false, '原路径的文件应该已经被挪走')
    assert.equal(await exists(result.file), true, '回收站里应该有这个文件')
    assert.equal(await service.noteById(noteId), undefined, '索引里不该还留着')
    const list = await service.listTrash({ sessionId: 'session-1' })
    assert.equal(list.entries.length, 1)
    assert.equal(list.entries[0].exists, true)
    assert.equal(list.entries[0].originalPath, toPosix(file))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('回收站:恢复 = 文件回到原路径并重新登记;原位置被占用时拒绝', async () => {
  const { base, service, file, noteId } = await setup()
  try {
    const trashed = await service.trashNote({ sessionId: 'session-1', noteId })
    const restored = await service.restoreTrash({ sessionId: 'session-1', id: trashed.id })
    assert.equal(restored.path, toPosix(file))
    assert.equal(await exists(file), true, '恢复后文件必须回到原路径')
    assert.equal(await exists(trashed.file), false, '回收站里的副本应该被挪走')
    assert.equal((await service.listTrash({ sessionId: 'session-1' })).entries.length, 0)
    assert.ok(await service.noteById(restored.note.id), '恢复后应该重新登记进索引')

    // 再删一次,然后人为在原路径放一个同名文件 → 恢复必须被拒绝
    const again = await service.trashNote({ sessionId: 'session-1', noteId: restored.note.id })
    await writeFile(file, '占位', 'utf8')
    await assert.rejects(
      () => service.restoreTrash({ sessionId: 'session-1', id: again.id }),
      /原位置已有同名文件/,
    )
    assert.equal(await readFile(file, 'utf8'), '占位', '被占用的文件不能被覆盖')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('回收站:彻底删除才真的 unlink,清空后清单为空', async () => {
  const { base, service, file, noteId } = await setup()
  try {
    const trashed = await service.trashNote({ sessionId: 'session-1', noteId })
    assert.equal(await exists(trashed.file), true)
    const purged = await service.purgeTrash({ sessionId: 'session-1', all: true })
    assert.equal(purged.removed, 1)
    assert.equal(await exists(trashed.file), false, '彻底删除后文件不该还在')
    assert.equal(await exists(file), false)
    assert.equal((await service.listTrash({ sessionId: 'session-1' })).entries.length, 0)
    await assert.rejects(() => service.purgeTrash({ sessionId: 'session-1', all: true }), /回收站是空的/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
