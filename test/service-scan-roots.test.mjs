import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NoteService } from '../lib/service.js'

/**
 * 「扫描范围」的两个契约:
 *   1. 目录选择器给的是**绝对路径** → 必须换算成工作区相对路径再存;
 *   2. 绝对路径落在工作区**外面** → 直接拒绝(否则"看别处"就成了越界读用户主目录)。
 * 相对路径的老行为(手打 `docs`)必须原样保留。
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
      readText: async () => '',
      listDir: async () => [],
      writeText: async () => ({ version: 'v1' }),
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

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-roots-'))
  const root = join(base, 'ws')
  await mkdir(join(root, 'notes'), { recursive: true })
  await mkdir(join(root, 'docs', 'deep'), { recursive: true })
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

test('绝对路径 → 工作区相对路径', async () => {
  const { base, root, service } = await setup()
  try {
    const result = await service.setScanRoots({
      sessionId: 'session-1',
      roots: [join(root, 'docs'), join(root, 'docs', 'deep')],
    })
    assert.deepEqual(result.scanRoots, ['docs', 'docs/deep'])
  } finally {
    await cleanup(base, service)
  }
})

test('工作区根本身（绝对路径）→ 整个工作区（空串）', async () => {
  const { base, root, service } = await setup()
  try {
    const result = await service.setScanRoots({ sessionId: 'session-1', roots: [root] })
    assert.deepEqual(result.scanRoots, [''])
  } finally {
    await cleanup(base, service)
  }
})

test('工作区外的绝对路径被拒绝（附后可读的报错）', async () => {
  const { base, service } = await setup()
  try {
    await assert.rejects(
      () => service.setScanRoots({ sessionId: 'session-1', roots: ['/home/phyd'] }),
      (error) => {
        assert.equal(error.code, 'INVALID')
        assert.match(error.message, /工作区内/)
        return true
      },
    )
    // 前缀相同但不是子目录,同样要拒
    await assert.rejects(
      () => service.setScanRoots({ sessionId: 'session-1', roots: [`${base}/ws-sibling`] }),
      (error) => error.code === 'INVALID',
    )
  } finally {
    await cleanup(base, service)
  }
})

test('相对路径的老行为不变（去掉 ./ 与结尾斜杠；空数组回落 notesDir）', async () => {
  const { base, service } = await setup()
  try {
    let result = await service.setScanRoots({ sessionId: 'session-1', roots: ['./docs/', 'docs/deep/'] })
    assert.deepEqual(result.scanRoots, ['docs', 'docs/deep'])
    result = await service.setScanRoots({ sessionId: 'session-1', roots: [] })
    assert.deepEqual(result.scanRoots, ['notes'], '空数组 = 回到默认 notesDir')
  } finally {
    await cleanup(base, service)
  }
})

test('扫描范围会落进工作区自己的 .dsh-notes/index.json（跟着工作区走）', async () => {
  const { base, root, service } = await setup()
  try {
    await service.setScanRoots({ sessionId: 'session-1', roots: [join(root, 'docs')] })
    const raw = JSON.parse(await readFile(join(root, '.dsh-notes', 'index.json'), 'utf8'))
    const slice = Object.values(raw.workspaces)[0]
    assert.deepEqual(slice.scanRoots, ['docs'])
  } finally {
    await cleanup(base, service)
  }
})
