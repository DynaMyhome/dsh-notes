import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NoteService } from '../lib/service.js'

/**
 * 扫描 / 对账的服务层测试(**用真文件 + 真 listDir**)。
 *
 * 兜住三类只在真实目录树上才暴露的问题:
 *   1. 登记了 `notes/` 之外的 md,下一次对账被"漏扫"静默丢掉(实测踩过的 bug);
 *   2. `tree()` 每次都走目录 → 大工作区(本机实测 1268 目录 / 6.3s)会卡;
 *   3. 改名/移动/删除与原条目的联动。
 */

/** ctx:`sessionId → 工作区 cwd`,fs 落到真目录(含真 listDir —— 扫描靠它)。 */
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
      readByteRange: async (target, range) => {
        const value = await readFile(target.path)
        return value.subarray(range.offset, range.offset + range.length)
      },
      writeText: async (target, text) => {
        await writeFile(target.path, text, 'utf8')
        return { version: 'v1' }
      },
      listDir: async (target) => {
        const entries = await readdir(target.path, { withFileTypes: true })
        return entries.map((entry) => ({
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

/**
 * 收尾:先释放服务、等后台重扫落盘,再删目录。
 * 直接 rm 会撞上"后台扫描还在写索引"的 ENOTEMPTY(实测)。
 */
async function cleanup(base, service) {
  service.dispose()
  await new Promise((resolve) => setTimeout(resolve, 500))
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

/** 建一个真实工作区 + 服务。 */
async function setup(overrides = {}) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-scan-'))
  const root = join(base, 'ws')
  const storeDir = join(base, 'store')
  await mkdir(join(root, 'notes'), { recursive: true })
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'notes', '甲.md'), '---\ndsh-note-id: n_jia\n---\n\n# 正文标题甲\n', 'utf8')
  await writeFile(join(root, 'docs', 'guide.md'), '---\ndsh-note-id: n_guide\n---\n\n# guide\n', 'utf8')
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
    ...overrides,
  })
  return { base, root, storeDir, service }
}

test('登记 notes/ 之外的 md:重扫之后仍在树里(回归:以前会被静默丢掉)', async () => {
  const { base, root, service } = await setup()
  try {
    await service.register({ sessionId: 'session-1', path: join(root, 'notes', '甲.md') })
    const outside = await service.register({ sessionId: 'session-1', path: join(root, 'docs', 'guide.md') })

    // 第一次取树(会扫描一次)
    let tree = await service.tree({ sessionId: 'session-1' })
    assert.deepEqual(
      tree.notes.map((note) => note.relPath).sort(),
      ['docs/guide.md', 'notes/甲.md'],
      'notes/ 之外的登记项必须出现在树里',
    )

    // 越过冷却再取一次:以前这里会把 outside 的条目丢掉
    await new Promise((resolve) => setTimeout(resolve, 3100))
    tree = await service.tree({ sessionId: 'session-1', force: true })
    assert.equal(service.registry.noteById(outside.id) !== undefined, true, '扫描范围之外的条目不能被"漏扫"判死')
    assert.deepEqual(tree.notes.map((note) => note.relPath).sort(), ['docs/guide.md', 'notes/甲.md'])
  } finally {
    await cleanup(base, service)
  }
})

test('tree() 不再触发扫描;force / rescan 才重新走目录', async () => {
  const { base, root, service } = await setup()
  try {
    await service.tree({ sessionId: 'session-1' }) // 首次:扫描一次并建缓存
    await writeFile(join(root, 'notes', '乙.md'), '---\ndsh-note-id: n_yi\n---\n\n# 乙\n', 'utf8')

    const plain = await service.tree({ sessionId: 'session-1' })
    assert.equal(
      plain.unfiled.some((file) => file.relPath === 'notes/乙.md'),
      false,
      '普通取树不该重新扫描(否则大工作区每次刷新都要几秒)',
    )

    const forced = await service.tree({ sessionId: 'session-1', force: true })
    assert.equal(forced.unfiled.some((file) => file.relPath === 'notes/乙.md'), true, 'force 取树应当重新扫描')
    assert.equal(typeof forced.scanReport?.scanned, 'number', '树里带回扫描报告(重扫按钮回显用)')
  } finally {
    await cleanup(base, service)
  }
})

test('改名/移动按 id 重绑,标题跟着新文件名;删除后条目消失', async () => {
  const { base, root, service } = await setup()
  try {
    const note = await service.register({ sessionId: 'session-1', path: join(root, 'notes', '甲.md') })
    await service.tree({ sessionId: 'session-1' })

    // 改名 + 挪目录(等价于用户在文件系统里改名/移动)
    await mkdir(join(root, 'notes', 'sub'), { recursive: true })
    await rename(join(root, 'notes', '甲.md'), join(root, 'notes', 'sub', '甲改.md'))
    let tree = await service.tree({ sessionId: 'session-1', force: true })
    const rebound = tree.notes.find((item) => item.id === note.id)
    assert.equal(rebound?.relPath, 'notes/sub/甲改.md', '按 dsh-note-id 重绑到新路径')
    assert.equal(rebound?.title, '甲改', '标题 = 新文件名')
    assert.equal(tree.scanReport.rebound, 1)

    // 删除原文件 → 条目消失(用户/Agent 在文件系统里删 → 笔记树同步)
    await rm(join(root, 'notes', 'sub', '甲改.md'))
    tree = await service.tree({ sessionId: 'session-1', force: true })
    assert.equal(tree.notes.some((item) => item.id === note.id), false, '原文件没了,条目要消失')
    assert.equal(service.registry.noteById(note.id), undefined)
  } finally {
    await cleanup(base, service)
  }
})

test('TTL 兜底:外部新增的 md 由后台重扫接住(监视器不可靠时也不丢)', async () => {
  const { base, root, service } = await setup({ scanTtlMs: 40 })
  try {
    await service.tree({ sessionId: 'session-1' })
    await writeFile(join(root, 'notes', '丙.md'), '---\ndsh-note-id: n_bing\n---\n\n# 丙\n', 'utf8')

    // TTL 还没到:取树返回旧缓存,且**不**触发扫描(不能每取一次树就走一遍目录)
    const fresh = await service.tree({ sessionId: 'session-1' })
    assert.equal(fresh.unfiled.some((file) => file.relPath === 'notes/丙.md'), false)

    // 越过 TTL 之后再取树:立刻返回旧缓存(不阻塞),同时在后台重扫
    await new Promise((resolve) => setTimeout(resolve, 80))
    const immediate = await service.tree({ sessionId: 'session-1' })
    assert.equal(immediate.unfiled.some((file) => file.relPath === 'notes/丙.md'), false, '本次返回的是旧缓存(不阻塞)')

    await new Promise((resolve) => setTimeout(resolve, 300))
    const later = await service.tree({ sessionId: 'session-1' })
    assert.equal(later.unfiled.some((file) => file.relPath === 'notes/丙.md'), true, '后台重扫完成后就该看见它')
  } finally {
    await cleanup(base, service)
  }
})

test('标题 = 文件名:正文里的 H1 改了不影响树上的名字', async () => {
  const { base, root, service } = await setup()
  try {
    const note = await service.register({ sessionId: 'session-1', path: join(root, 'notes', '甲.md') })
    assert.equal(note.title, '甲')

    const text = await readFile(join(root, 'notes', '甲.md'), 'utf8')
    await writeFile(join(root, 'notes', '甲.md'), text.replace('# 正文标题甲', '# 完全不同的标题'), 'utf8')
    const tree = await service.tree({ sessionId: 'session-1', force: true })
    assert.equal(tree.notes.find((item) => item.id === note.id)?.title, '甲', 'H1 与标题解绑')
  } finally {
    await cleanup(base, service)
  }
})
