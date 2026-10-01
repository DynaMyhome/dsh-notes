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
        // 真 provider 会带 version/size(harness 的 FsDirEntry:「cheap metadata only」)。
        // 少了它们,增量索引就会认为"每个文件都没变"。
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
    assert.equal((await service.noteById(outside.id)) !== undefined, true, '扫描范围之外的条目不能被"漏扫"判死')
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
    assert.equal(await service.noteById(note.id), undefined)
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

/* ------------------------------------------------------------------ */
/* 三类分类(整个工作区):笔记 / 候选 / 杂项                            */
/* ------------------------------------------------------------------ */

/**
 * 取工作区键 + 分类结果(测试里高频用)。
 *
 * 默认把扫描范围设成**整个工作区**(`['']`)—— 生产默认只有 `notesDir`,
 * 因为本机实测一次 listDir 约 330ms,扫整棵树要按分钟算(见 walkWorkspace 注释)。
 */
async function classifyAll(service, options = {}, roots = ['']) {
  await service.setScanRoots({ sessionId: 'session-1', roots })
  const workspace = await service.workspaceOf('session-1')
  return service.classify(workspace.key, options)
}

test('classify:三类各就各位(嵌套目录也会被找到)', async () => {
  const { base, root, service } = await setup()
  try {
    await mkdir(join(root, 'docs', 'design'), { recursive: true })
    await writeFile(join(root, 'docs', 'design', 'api.md'), '# api\n', 'utf8')
    await service.register({ sessionId: 'session-1', path: join(root, 'notes', '甲.md') })

    const found = await classifyAll(service, { force: true })
    const rel = (list) => list.map((item) => item.relPath).sort()
    assert.deepEqual(rel(found.notes), ['notes/甲.md'])
    assert.deepEqual(rel(found.candidates), ['docs/design/api.md', 'docs/guide.md', 'notes/甲.md' === '' ? '' : 'notes/甲.md'].filter((p) => p !== 'notes/甲.md').sort())
    assert.deepEqual(rel(found.candidates), ['docs/design/api.md', 'docs/guide.md'])
    assert.equal(found.stats.total, 3, '整个工作区共 3 个 md')
    assert.equal(found.truncated, false)
    // 候选带 mtime(「最近」排序用)与文件夹分组信息
    assert.equal(typeof found.candidates[0].at, 'number')
    assert.ok(['docs', 'docs/design'].includes(found.candidates[0].folder))
  } finally {
    await cleanup(base, service)
  }
})

test('include:把工作区其它目录的 md 纳入,重扫后仍是笔记', async () => {
  const { base, root, service } = await setup()
  try {
    const result = await service.includePaths({ sessionId: 'session-1', paths: [join(root, 'docs', 'guide.md')] })
    assert.equal(result.included.length, 1)
    assert.equal(result.failed.length, 0)
    assert.equal(result.included[0].title, 'guide', '标题 = 文件名')

    let found = await classifyAll(service, { force: true })
    assert.deepEqual(found.notes.map((note) => note.relPath), ['docs/guide.md'])
    assert.equal(found.candidates.some((file) => file.relPath === 'docs/guide.md'), false, '纳入后不再出现在候选中')

    found = await classifyAll(service, { force: true })
    assert.equal(found.notes.some((note) => note.relPath === 'docs/guide.md'), true, '重扫之后仍在')
  } finally {
    await cleanup(base, service)
  }
})

test('ignore / unignore:标为杂项与放回候选(不动磁盘)', async () => {
  const { base, root, service } = await setup()
  try {
    await service.ignorePaths({ sessionId: 'session-1', paths: ['docs/guide.md'] })
    let found = await classifyAll(service, { force: true })
    assert.deepEqual(found.ignored.map((file) => file.relPath), ['docs/guide.md'])
    assert.equal(found.candidates.some((file) => file.relPath === 'docs/guide.md'), false)
    assert.equal(await readFile(join(root, 'docs', 'guide.md'), 'utf8').then(() => true), true, '忽略不删文件')

    await service.ignorePaths({ sessionId: 'session-1', paths: ['docs/guide.md'], on: false })
    found = await classifyAll(service, { force: true })
    assert.equal(found.ignored.length, 0)
    assert.equal(found.candidates.some((file) => file.relPath === 'docs/guide.md'), true, '放回候选')
  } finally {
    await cleanup(base, service)
  }
})

test('ignore glob:整棵目录剪掉,不进候选也不进忽略清单(规则另列)', async () => {
  const { base, root, service } = await setup()
  try {
    await mkdir(join(root, 'archive', 'old'), { recursive: true })
    await writeFile(join(root, 'archive', 'old', 'x.md'), '# x\n', 'utf8')
    await service.ignorePaths({ sessionId: 'session-1', globs: ['archive/**'] })

    const found = await classifyAll(service, { force: true })
    assert.equal(found.candidates.some((file) => file.relPath.startsWith('archive/')), false)
    assert.deepEqual(found.ignoredGlobs, ['archive/**'])
    assert.equal(found.stats.total, 2, '被 glob 剪掉的目录不参与扫描')
  } finally {
    await cleanup(base, service)
  }
})

test('ignore 已纳入的笔记:同时移出笔记树(不动文件)', async () => {
  const { base, root, service } = await setup()
  try {
    const note = await service.register({ sessionId: 'session-1', path: join(root, 'docs', 'guide.md') })
    await service.ignorePaths({ sessionId: 'session-1', paths: ['docs/guide.md'] })
    await service.unregister({ noteId: note.id }) // 界面/tool 里这一条是"移出并忽略"

    const found = await classifyAll(service, { force: true })
    assert.equal(found.notes.length, 0)
    assert.deepEqual(found.ignored.map((file) => file.relPath), ['docs/guide.md'])
    assert.equal(await readFile(join(root, 'docs', 'guide.md'), 'utf8').then(() => true), true)
  } finally {
    await cleanup(base, service)
  }
})

test('增量索引:没改动就不重读文件,改一个只重读一个', async () => {
  const { base, root, service } = await setup()
  try {
    const first = await classifyAll(service, { force: true })
    assert.equal(first.stats.changed, 2, '首次扫描要读 2 个新文件')

    await service.workspaceScansClear?.()
    const second = await classifyAll(service, { force: true })
    assert.equal(second.stats.changed, 0, '什么都没改 → 一个文件都不用读')
    assert.equal(second.stats.total, 2)

    // 改一个文件(内容变化会改 mtime/version)→ 只重读它
    await new Promise((resolve) => setTimeout(resolve, 20))
    await writeFile(join(root, 'docs', 'guide.md'), '---\ndsh-note-id: n_guide\n---\n\n# guide 改过\n', 'utf8')
    const third = await classifyAll(service, { force: true })
    assert.equal(third.stats.changed, 1)
  } finally {
    await cleanup(base, service)
  }
})

test('删除/改名联动:候选消失、已纳入的按 id 重绑到新文件名', async () => {
  const { base, root, service } = await setup()
  try {
    const note = await service.register({ sessionId: 'session-1', path: join(root, 'docs', 'guide.md') })
    await mkdir(join(root, 'docs', 'sub'), { recursive: true })
    await rename(join(root, 'docs', 'guide.md'), join(root, 'docs', 'sub', '指南.md'))

    let found = await classifyAll(service, { force: true })
    const rebound = found.notes.find((item) => item.id === note.id)
    assert.equal(rebound?.relPath, 'docs/sub/指南.md', '按 id 重绑')
    assert.equal(rebound?.title, '指南', '标题跟着文件名')

    await rm(join(root, 'docs', 'sub', '指南.md'))
    found = await classifyAll(service, { force: true })
    assert.equal(found.notes.some((item) => item.id === note.id), false, '原文件没了 → 条目消失')
    assert.equal(await service.noteById(note.id), undefined)
  } finally {
    await cleanup(base, service)
  }
})

test('classify 过滤:query / folder / limit', async () => {
  const { base, root, service } = await setup()
  try {
    await mkdir(join(root, 'docs', 'design'), { recursive: true })
    await writeFile(join(root, 'docs', 'design', 'api.md'), '# api\n', 'utf8')

    const byQuery = await classifyAll(service, { query: 'api' })
    assert.deepEqual(byQuery.candidates.map((file) => file.relPath), ['docs/design/api.md'])

    const byFolder = await classifyAll(service, { folder: 'docs/design' })
    assert.deepEqual(byFolder.candidates.map((file) => file.relPath), ['docs/design/api.md'])

    const limited = await classifyAll(service, { limit: 1 })
    assert.equal(limited.candidates.length, 1)
    assert.equal(limited.stats.candidates, 3, 'stats 报的是过滤前的总数(含未登记的 notes/甲.md)')
  } finally {
    await cleanup(base, service)
  }
})

test('扫描范围:默认只有 notesDir;显式加根才看得见工作区其它目录', async () => {
  const { base, root, service } = await setup()
  try {
    await mkdir(join(root, 'docs', 'design'), { recursive: true })
    await writeFile(join(root, 'docs', 'design', 'api.md'), '# api\n', 'utf8')

    // 默认:只扫 notes/
    const workspace = await service.workspaceOf('session-1')
    const byDefault = await service.classify(workspace.key, { force: true })
    assert.deepEqual(service.scanRootsOf(await service.workspaceNodeOf(workspace.key)), ['notes'])
    assert.equal(byDefault.candidates.some((file) => file.relPath.startsWith('docs/')), false)
    assert.equal(byDefault.stats.total, 1, '默认只看得到 notes/ 里的 md')

    // 加一个根:docs/
    await service.setScanRoots({ sessionId: 'session-1', roots: ['notes', 'docs'] })
    const withDocs = await service.classify(workspace.key, { force: true })
    assert.equal(withDocs.candidates.some((file) => file.relPath === 'docs/design/api.md'), true)
    assert.equal(withDocs.scanRoots.includes('docs'), true)

    // 回到默认
    await service.setScanRoots({ sessionId: 'session-1', roots: [] })
    const back = await service.classify(workspace.key, { force: true })
    assert.equal(back.candidates.some((file) => file.relPath.startsWith('docs/')), false)
  } finally {
    await cleanup(base, service)
  }
})
