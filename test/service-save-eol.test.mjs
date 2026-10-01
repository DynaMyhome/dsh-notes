import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NoteService } from '../lib/service.js'

/**
 * 保存**必须保住原文件的行尾**。
 *
 * 编辑器(CM6)里的文本恒为 LF(`EditorState.create` 用 `/\r\n?|\n/` 切分重建),
 * 而 `fs.writeText` 是**原样写** —— 与官方 `editText` 不同,后者会 `restoreLineEndings`。
 * 所以插件不自己转的话,打开一篇 CRLF 笔记随手保存一次,整份文件的行尾就被静默改写成 LF
 * (用户实测的笔记:123KB 里有 1244 个 CR)。
 *
 * 顺带锁住另一半:`FS_STALE_VERSION` 交出去的 `currentText` 必须是 **LF 归一**的,
 * 否则客户端那条"磁盘内容 == 我正要写的内容 → 自愈"的分支在 CRLF 笔记上永远不成立,
 * 会误报"文件已被外部修改"。
 */

/** 内容哈希当版本号:内容不变则版本不变 —— 守卫语义与真 provider 一致。 */
function versionOf(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 12)
}

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

async function cleanup(base, service) {
  service.dispose()
  await new Promise((resolve) => setTimeout(resolve, 300))
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

async function setup(initial) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-eol-'))
  const root = join(base, 'ws')
  await mkdir(join(root, 'notes'), { recursive: true })
  const file = join(root, 'notes', '甲.md')
  await writeFile(file, initial, 'utf8')
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
  return { base, root, file, service }
}

/** 读当前版本(模拟客户端打开时拿到的那个)。 */
async function versionOfFile(service, file) {
  const info = await service.ctx.fs.stat({ path: file })
  return String(info.version)
}

test('CRLF 笔记:保存后仍是 CRLF,正文照常更新', async () => {
  const { base, file, service } = await setup('---\ndsh-note-id: n_jia\n---\r\n\r\n# 甲\r\n\r\nold\r\n')
  try {
    const version = await versionOfFile(service, file)
    // 编辑器给的是 LF(CM6 归一后的形态)
    const edited = '---\ndsh-note-id: n_jia\n---\n\n# 甲\n\nnew\n'
    await service.save({ sessionId: 'session-1', path: file, text: edited, expectedVersion: version })
    const onDisk = await readFile(file, 'utf8')
    assert.equal(onDisk, '---\r\ndsh-note-id: n_jia\r\n---\r\n\r\n# 甲\r\n\r\nnew\r\n', '行尾必须原样保住')
    assert.equal(onDisk.includes('\n\n# 甲\n\n'), false, '不应出现裸 LF')
  } finally {
    await cleanup(base, service)
  }
})

test('LF 笔记:保存后仍是 LF(不要好心办坏事)', async () => {
  const { base, file, service } = await setup('---\ndsh-note-id: n_jia\n---\n\n# 甲\n\nold\n')
  try {
    const version = await versionOfFile(service, file)
    await service.save({
      sessionId: 'session-1',
      path: file,
      text: '---\ndsh-note-id: n_jia\n---\n\n# 甲\n\nnew\n',
      expectedVersion: version,
    })
    const onDisk = await readFile(file, 'utf8')
    assert.equal(onDisk.includes('\r'), false, 'LF 文件不能被写成 CRLF')
    assert.equal(onDisk, '---\ndsh-note-id: n_jia\n---\n\n# 甲\n\nnew\n')
  } finally {
    await cleanup(base, service)
  }
})

test('身份自愈(id 被删)走的也是同一条行尾保真路径', async () => {
  const { base, file, service } = await setup('---\r\ndsh-note-id: n_jia\r\n---\r\n\r\n# 甲\r\n')
  try {
    const version = await versionOfFile(service, file)
    // 用户把 frontmatter 整段删了(预览模式里它是个 chip,很容易整块没了)
    const result = await service.save({
      sessionId: 'session-1',
      path: file,
      text: '# 甲\n\n正文\n',
      expectedVersion: version,
    })
    assert.equal(result.restoredId, true)
    assert.equal(String(result.text).includes('\r'), false, '响应里的 text 是给编辑器用的,必须是 LF')
    const onDisk = await readFile(file, 'utf8')
    assert.match(onDisk, /^---\r\ndsh-note-id: n_jia\r\n---\r\n/)
    assert.equal(onDisk.includes('\n\n正文\n'), false)
  } finally {
    await cleanup(base, service)
  }
})

test('FS_STALE_VERSION 交出的 currentText 必须 LF 归一(否则 CRLF 笔记上自愈分支失效)', async () => {
  const { base, file, service } = await setup('---\r\ndsh-note-id: n_jia\r\n---\r\n\r\n# 甲\r\n')
  try {
    const edited = '---\ndsh-note-id: n_jia\n---\n\n# 甲\n\nchanged\n'
    // 用一个过期的版本号触发守卫失败
    await assert.rejects(
      () => service.save({ sessionId: 'session-1', path: file, text: edited, expectedVersion: 'stale-version' }),
      (error) => {
        assert.equal(error.code, 'FS_STALE_VERSION')
        assert.equal(
          String(error.currentText).includes('\r'),
          false,
          'currentText 带 \\r 的话,客户端 `currentText === payload` 永远不相等 → 误报外部修改',
        )
        return true
      },
    )
  } finally {
    await cleanup(base, service)
  }
})
