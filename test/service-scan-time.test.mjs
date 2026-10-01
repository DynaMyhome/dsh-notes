import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NoteService } from '../lib/service.js'

/**
 * 「最近」的排序必须真的是**时间序**。
 *
 * 这条回归的靶子是"单测替身与运行时不同构":旧代码用 `Number(entry.version)` 取时间,
 * 而真 provider(`@deepseek-ai/dsh-fs-local`)的 version 是
 * `` `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}` `` → `Number(...)` 是 NaN → at 恒为 0
 * → 排序退化成按路径。替身如果直接给 `String(mtimeMs)`,这条就永远测不出来。
 *
 * 所以这里的假 provider **故意用真形状**;另留一条纯毫秒的用例锁旧形态仍可用。
 */

/** 真 provider 的 version 形状。 */
function realVersion(info) {
  const mtimeNs = BigInt(Math.round(info.mtimeMs)) * 1_000_000n
  const ctimeNs = BigInt(Math.round(info.ctimeMs)) * 1_000_000n
  return `2050:${info.ino}:${info.size}:${mtimeNs}:${ctimeNs}`
}

/** ctx:fs 落到真目录;listDir 给**真形状**的 version。 */
function realContext(root, { legacyVersion = false } = {}) {
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
          return { type: value.isDirectory() ? 'directory' : 'file', version: realVersion(value) }
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
        return { version: realVersion(await stat(target.path)) }
      },
      listDir: async (target) => {
        const entries = await readdir(target.path, { withFileTypes: true })
        return Promise.all(
          entries.map(async (entry) => {
            let version = ''
            let size
            try {
              const info = await stat(join(target.path, entry.name))
              version = legacyVersion ? String(info.mtimeMs) : realVersion(info)
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

async function cleanup(base, service) {
  service.dispose()
  await new Promise((resolve) => setTimeout(resolve, 400))
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

/**
 * 建一个真工作区:三篇未纳入的 md,修改时间**故意与路径序相反**
 * (路径 a < b < c,时间 a 最旧、c 最新 —— 时间序与路径序都能分辨)。
 */
async function setup(overrides = {}) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-time-'))
  const root = join(base, 'ws')
  await mkdir(join(root, 'notes'), { recursive: true })
  const stamps = {
    'aaa.md': Date.UTC(2026, 0, 1, 0, 0, 0),
    'mmm.md': Date.UTC(2026, 5, 1, 0, 0, 0),
    'zzz.md': Date.UTC(2026, 9, 1, 0, 0, 0),
  }
  for (const [name, stamp] of Object.entries(stamps)) {
    const file = join(root, 'notes', name)
    await writeFile(file, `# ${name}\n`, 'utf8')
    await utimes(file, new Date(stamp), new Date(stamp))
  }
  const service = new NoteService(realContext(root, overrides), {
    notesDir: 'notes',
    assetsDir: '.dsh-assets',
    storeDir: join(base, 'store'),
    scanTtlMs: 0,
    unfiledMax: 200,
    autosaveMs: 800,
    pasteImage: 'copy',
    watch: false,
    ...overrides.config,
  })
  return { base, root, service, stamps }
}

test('「最近」按 mtime 排序(真 provider 的 5 段 version token)', async () => {
  const { base, service, stamps } = await setup()
  try {
    const workspace = await service.workspaceOf('session-1')
    const files = await service.classify(workspace.key, { force: true })
    assert.equal(files.stats.candidates, 3)
    assert.deepEqual(
      files.candidates.map((file) => file.relPath),
      ['notes/zzz.md', 'notes/mmm.md', 'notes/aaa.md'],
      '必须按 mtime 倒序 —— 按路径排会得到 aaa/mmm/zzz',
    )
    for (const file of files.candidates) {
      const name = file.relPath.replace('notes/', '')
      assert.equal(file.at, stamps[name], `${name} 的 at 必须是真的 mtime`)
    }
  } finally {
    await cleanup(base, service)
  }
})

test('sort=path 仍然按路径排(两种排序都要在)', async () => {
  const { base, service } = await setup()
  try {
    const workspace = await service.workspaceOf('session-1')
    const files = await service.classify(workspace.key, { force: true, sort: 'path' })
    assert.deepEqual(files.candidates.map((file) => file.relPath), ['notes/aaa.md', 'notes/mmm.md', 'notes/zzz.md'])
  } finally {
    await cleanup(base, service)
  }
})

test('旧形态(纯毫秒 version)仍然可用 —— provider 换成别的形状不至于崩', async () => {
  const { base, service } = await setup({ legacyVersion: true })
  try {
    const workspace = await service.workspaceOf('session-1')
    const files = await service.classify(workspace.key, { force: true })
    assert.deepEqual(files.candidates.map((file) => file.relPath), ['notes/zzz.md', 'notes/mmm.md', 'notes/aaa.md'])
    assert.equal(files.candidates[0].at > 0, true)
  } finally {
    await cleanup(base, service)
  }
})

test('认不出的 version 一律 at=0,并回落成路径序(绝不瞎猜时间)', async () => {
  const { base, service } = await setup({ legacyVersion: true })
  try {
    const workspace = await service.workspaceOf('session-1')
    // 把 version 换成完全认不出来的形态:重扫后 at 必须全 0
    service.ctx.fs.listDir = async (target) => {
      const entries = await readdir(target.path, { withFileTypes: true })
      return entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        target: { path: join(target.path, entry.name) },
        version: 'unknown-shape',
        size: 1,
      }))
    }
    service.walkStates.clear()
    const files = await service.classify(workspace.key, { force: true })
    assert.deepEqual(files.candidates.map((file) => file.at), [0, 0, 0])
    assert.deepEqual(files.candidates.map((file) => file.relPath), ['notes/aaa.md', 'notes/mmm.md', 'notes/zzz.md'])
  } finally {
    await cleanup(base, service)
  }
})
