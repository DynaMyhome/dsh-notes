import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NoteService } from '../lib/service.js'

/**
 * 版本探针(`statNotes`)—— 客户端 1.5s 轮询的 Host 侧。
 *
 * 这条接口的**唯一职责**是回答"打开着的笔记,磁盘版本变了没有",所以:
 *   - 只 `stat`,不读正文(1.5s 一次的接口不能贵);
 *   - 逐条独立:`null` = 文件不存在 / 不在本工作区 / 不是 markdown,
 *     客户端据此显示"已被移动或删除",而不是当成冲突;
 *   - 键与入参字符串**一一对应**(客户端要按路径取回来)。
 */

/** 内容哈希当版本号:内容不变则版本不变(与真 provider 的守卫语义一致)。 */
function versionOf(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 12)
}

function realContext(root) {
  const session = { header: { cwd: root } }
  return {
    sessions: { get: (id) => (String(id) === 'session-1' ? session : undefined) },
    sandboxPolicy: { resolve: () => undefined },
    fs: {
      resolve: async (path, options) => ({ path: String(path) }),
      processPath: (target) => String(target?.path ?? target),
      stat: async (target) => {
        try {
          const value = await stat(target.path)
          if (value.isDirectory()) return { type: 'directory', version: 'dir' }
          return { type: 'file', version: versionOf(await readFile(target.path, 'utf8')) }
        } catch {
          return undefined
        }
      },
      readText: async (target) => readFile(target.path, 'utf8'),
      readByteRange: async (target, range) => {
        const value = await readFile(target.path)
        return value.subarray(range.offset, range.offset + range.length)
      },
      writeText: async (target, text) => {
        await writeFile(target.path, text, 'utf8')
        return { version: versionOf(text) }
      },
      listDir: async () => [],
      watch: async () => async () => {},
    },
    logger: undefined,
    inject: () => () => {},
  }
}

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-stat-'))
  const root = join(base, 'ws')
  await mkdir(join(root, 'notes'), { recursive: true })
  const file = join(root, 'notes', '甲.md')
  await writeFile(file, '---\ndsh-note-id: n_jia\n---\n\n# 甲\n', 'utf8')
  const outside = join(base, 'outside.md')
  await writeFile(outside, '# 外面\n', 'utf8')
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
  await service.register({ sessionId: 'session-1', path: file })
  return { base, root, file, outside, service }
}

test('探针:回的是磁盘当前版本,键与入参一一对应', async () => {
  const { base, file, service } = await setup()
  try {
    const before = versionOf(await readFile(file, 'utf8'))
    const first = await service.statNotes({ sessionId: 'session-1', paths: [file] })
    assert.deepEqual(first.versions, { [file]: before })
    // 外部改动 → 版本必须跟着变(这就是"用户这边立刻看到"的判据)
    await writeFile(file, '---\ndsh-note-id: n_jia\n---\n\n# 甲\n\n外部改的\n', 'utf8')
    const second = await service.statNotes({ sessionId: 'session-1', paths: [file] })
    assert.notEqual(second.versions[file], before, '内容变了版本号必须变')
    assert.equal(second.versions[file], versionOf(await readFile(file, 'utf8')))
  } finally {
    service.dispose()
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('探针:不存在的文件 / 工作区外的文件 / 非 markdown 一律回 null,不抛', async () => {
  const { base, root, outside, service } = await setup()
  try {
    const missing = join(root, 'notes', '没有这篇.md')
    const notMarkdown = join(root, 'notes', '说明.txt')
    await writeFile(notMarkdown, 'x', 'utf8')
    const result = await service.statNotes({ sessionId: 'session-1', paths: [missing, outside, notMarkdown, ''] })
    assert.equal(result.versions[missing], null, '文件不存在 → null')
    assert.equal(result.versions[outside], null, '工作区外 → null(不能把别人的文件算进笔记)')
    assert.equal(result.versions[notMarkdown], null, '非 markdown → null')
    assert.equal('' in result.versions, false, '空路径直接跳过')
  } finally {
    service.dispose()
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
