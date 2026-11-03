import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolveNative } from 'node:path'

import { NoteService } from '../lib/service.js'

/**
 * 网页演示的**只读**取数(`service.readEmbed`)。
 *
 * 安全边界是这条接口的全部意义,所以每条拒绝路径都要有靶子:
 *   - 工作区外(含 `..` 逃逸)→ EMBED_OUTSIDE;
 *   - 非 `.html/.htm` → INVALID;
 *   - 不存在 / 不是文件 → NOT_FOUND;
 *   - 太大 → FS_TOO_LARGE(由 fs provider 抛);
 *   - 配置关掉 → EMBED_DISABLED;
 *   - 换工作区(笔记面板切到别的工作区)→ 必须用 workspaceKey 命中另一个根。
 */

/** 内容哈希当版本号(与真 provider 的守卫语义一致)。 */
function versionOf(bytes) {
  return createHash('sha1').update(bytes).digest('hex').slice(0, 12)
}

/**
 * 假 fs:`resolve` 用 node:path 归一(等价于真 provider 的 realpath 派生的 targetKey),
 * `readBytes` 复刻"超过上限抛 FS_TOO_LARGE"。
 */
function realContext(root) {
  const session = { header: { cwd: root } }
  return {
    sessions: { get: (id) => (String(id) === 'session-1' ? session : undefined) },
    sandboxPolicy: { resolve: () => undefined },
    fs: {
      resolve: async (path, options) => ({ path: resolveNative(options?.cwd ?? root, String(path)) }),
      processPath: (target) => String(target?.path ?? target),
      stat: async (target) => {
        try {
          const value = await stat(target.path)
          if (value.isDirectory()) return { type: 'directory', version: 'dir', size: 0 }
          return { type: 'file', version: versionOf(await readFile(target.path)), size: value.size }
        } catch {
          return undefined
        }
      },
      readText: async (target) => readFile(target.path, 'utf8'),
      readBytes: async (target, signal, maxBytes) => {
        const value = await readFile(target.path)
        if (maxBytes !== undefined && value.length > maxBytes) {
          const error = new Error('file exceeds byte limit')
          error.code = 'FS_TOO_LARGE'
          throw error
        }
        return value
      },
      readByteRange: async (target, range) => {
        const value = await readFile(target.path)
        return value.subarray(range.offset, range.offset + range.length)
      },
      writeText: async (target, text) => {
        await writeFile(target.path, text, 'utf8')
        return { version: versionOf(Buffer.from(text, 'utf8')) }
      },
      listDir: async () => [],
      watch: async () => async () => {},
    },
    logger: undefined,
    inject: () => () => {},
  }
}

async function setup(config = {}) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-embed-'))
  const root = join(base, 'ws')
  const other = join(base, 'other')
  await mkdir(join(root, 'notes'), { recursive: true })
  await mkdir(join(root, '.dsh-assets', 'n1'), { recursive: true })
  await mkdir(other, { recursive: true })
  const demo = join(root, '.dsh-assets', 'n1', 'demo.html')
  const outside = join(base, 'outside.html')
  const otherDemo = join(other, 'other.html')
  await writeFile(demo, '<!doctype html><title>demo</title><script>1+1</script>', 'utf8')
  await writeFile(outside, '<!doctype html><title>outside</title>', 'utf8')
  await writeFile(otherDemo, '<!doctype html><title>other</title>', 'utf8')
  const service = new NoteService(realContext(root), {
    notesDir: 'notes',
    assetsDir: '.dsh-assets',
    storeDir: join(base, 'store'),
    scanTtlMs: 8000,
    unfiledMax: 200,
    autosaveMs: 800,
    pasteImage: 'copy',
    watch: false,
    htmlEmbed: true,
    ...config,
  })
  return { base, root, other, demo, outside, otherDemo, service }
}

test('readEmbed:工作区相对/绝对路径都能读,回字节与规范化路径', async () => {
  const { demo, service } = await setup()
  const relative = await service.readEmbed({ sessionId: 'session-1', path: '.dsh-assets/n1/demo.html' })
  assert.equal(Buffer.isBuffer(relative.bytes) || relative.bytes instanceof Uint8Array, true)
  assert.equal(Buffer.from(relative.bytes).toString('utf8').includes('<title>demo</title>'), true)
  assert.equal(relative.absolutePath.endsWith('/.dsh-assets/n1/demo.html'), true)

  const absolute = await service.readEmbed({ sessionId: 'session-1', path: demo })
  assert.equal(Buffer.from(absolute.bytes).toString('utf8'), Buffer.from(await readFile(demo)).toString('utf8'))
})

test('readEmbed:工作区外(含 `..` 逃逸)一律 EMBED_OUTSIDE', async () => {
  const { outside, service } = await setup()
  await assert.rejects(
    () => service.readEmbed({ sessionId: 'session-1', path: outside }),
    (error) => error.code === 'EMBED_OUTSIDE',
  )
  await assert.rejects(
    () => service.readEmbed({ sessionId: 'session-1', path: '../outside.html' }),
    (error) => error.code === 'EMBED_OUTSIDE',
  )
})

test('readEmbed:非 .html/.htm 一律 INVALID', async () => {
  const { root, service } = await setup()
  const text = join(root, 'notes', 'x.txt')
  await writeFile(text, 'plain', 'utf8')
  await assert.rejects(
    () => service.readEmbed({ sessionId: 'session-1', path: text }),
    (error) => error.code === 'INVALID',
  )
})

test('readEmbed:不存在 / 目录 → NOT_FOUND', async () => {
  const { root, service } = await setup()
  await assert.rejects(
    () => service.readEmbed({ sessionId: 'session-1', path: join(root, 'nope.html') }),
    (error) => error.code === 'NOT_FOUND',
  )
  await mkdir(join(root, 'dir.html'), { recursive: true })
  await assert.rejects(
    () => service.readEmbed({ sessionId: 'session-1', path: join(root, 'dir.html') }),
    (error) => error.code === 'NOT_FOUND',
  )
})

test('readEmbed:超过上限透传 FS_TOO_LARGE', async () => {
  const { root, service } = await setup()
  const big = join(root, 'big.html')
  await writeFile(big, '<p>' + 'x'.repeat(64) + '</p>', 'utf8')
  // 不必真写 8MB:把 provider 的读出换成"一定超限",验证 readEmbed 不吞掉这个码。
  const fs = service.ctx.fs
  const realReadBytes = fs.readBytes
  fs.readBytes = async () => {
    const error = new Error('file exceeds byte limit')
    error.code = 'FS_TOO_LARGE'
    throw error
  }
  await assert.rejects(
    () => service.readEmbed({ sessionId: 'session-1', path: big }),
    (error) => error.code === 'FS_TOO_LARGE',
  )
  fs.readBytes = realReadBytes
})

test('readEmbed:provider 没有 readBytes 时退化 readText', async () => {
  const { demo, service } = await setup()
  delete service.ctx.fs.readBytes
  const result = await service.readEmbed({ sessionId: 'session-1', path: demo })
  assert.equal(Buffer.from(result.bytes).toString('utf8').includes('<title>demo</title>'), true)
})

test('readEmbed:htmlEmbed=false 时 EMBED_DISABLED', async () => {
  const { demo, service } = await setup({ htmlEmbed: false })
  await assert.rejects(
    () => service.readEmbed({ sessionId: 'session-1', path: demo }),
    (error) => error.code === 'EMBED_DISABLED',
  )
})

test('readEmbed:workspaceKey 决定边界根(面板切到别的工作区)', async () => {
  const { other, otherDemo, service } = await setup()
  const opened = await service.openWorkspace({ sessionId: 'session-1', root: other })
  // 不带 key:按会话 cwd 的边界 → 越界
  await assert.rejects(
    () => service.readEmbed({ sessionId: 'session-1', path: otherDemo }),
    (error) => error.code === 'EMBED_OUTSIDE',
  )
  // 带 key:边界换到另一个已登记工作区 → 能读
  const result = await service.readEmbed({ sessionId: 'session-1', workspaceKey: opened.key, path: otherDemo })
  assert.equal(Buffer.from(result.bytes).toString('utf8').includes('<title>other</title>'), true)
})
