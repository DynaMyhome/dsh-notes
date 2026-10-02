import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NoteService } from '../lib/service.js'
import { toPosix, workspaceKeyOf } from '../lib/notes.js'

/**
 * **语义数据跟着工作区走**(`storeScope: 'workspace'`,默认)。
 *
 * 这一组是这次改造的验收面:备份/搬走工作区之后,装同一个插件就能原样读出来 ——
 * 分类树、笔记归属、忽略规则、置顶、回收站都在工作区里,机器本地只剩"缓存"与
 * "这台机器见过哪些工作区"。同时锁住几条容易回归的边界:
 *   - 旧的整体索引(升级路径)自动迁进工作区,**旧文件保留**;
 *   - 工作区换路径后,索引里记的**绝对路径**要重定位到新根(否则出来一堆死路径);
 *   - `.dsh-notes/`(含 `.trash/` 里的 `.md`)永远不被当成候选笔记扫到;
 *   - 只读工作区:读照常、写降级(不抛)。
 */

/** 真文件系统 ctx(与 service-notes-root.test.mjs 同款)。 */
function realContext(roots) {
  const sessions = new Map(Object.entries(roots).map(([id, cwd]) => [id, { header: { cwd } }]))
  return {
    sessions: { get: (id) => sessions.get(String(id)) },
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
            let version = ''
            let size
            try {
              const info = await stat(join(target.path, entry.name))
              version = String(info.mtimeMs)
              size = info.size
            } catch {
              /* 读不到就给空版本 */
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

async function setup({ roots, storeScope = 'workspace', legacy = null } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-scope-'))
  const store = join(base, 'store')
  if (legacy !== null) {
    await mkdir(store, { recursive: true })
    await writeFile(join(store, 'registry.json'), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')
  }
  const service = new NoteService(realContext(roots), {
    notesDir: 'notes',
    assetsDir: '.dsh-assets',
    storeDir: store,
    storeScope,
    unfiledDepth: 3,
    unfiledMax: 200,
    scanTtlMs: 8000,
    autoscan: false,
    watch: false,
  })
  return { base, store, service }
}

const exists = async (path) => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 造一份"旧的整体索引"(升级前的形态)。 */
function legacyState({ root, key, noteId = 'n_old' }) {
  return {
    schemaVersion: 1,
    notes: {
      [noteId]: {
        id: noteId,
        workspaceKey: key,
        path: join(root, 'notes', '旧笔记.md'),
        title: '旧笔记',
        collectionId: 'c_old',
        order: 1,
      },
    },
    workspaces: {
      [key]: {
        root,
        name: 'ws',
        notesRoot: join(root, 'notes'),
        collections: { c_old: { id: 'c_old', name: '老分类', parentId: null, order: 1 } },
        refs: {},
        pins: [noteId],
        recent: [],
        ignored: ['ignore-me.md'],
        ignoredGlobs: ['docs/**'],
        scanRoots: [''],
        lastUsedAt: 1,
      },
    },
  }
}

test('升级路径:旧整体索引里的工作区被自动迁进 <root>/.dsh-notes/,旧文件保留', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-scope-'))
  const root = join(base, 'ws')
  await mkdir(join(root, 'notes'), { recursive: true })
  await writeFile(join(root, 'notes', '旧笔记.md'), '---\ndsh-note-id: n_old\n---\n\n正文\n', 'utf8')
  const key = workspaceKeyOf(root)
  const legacy = legacyState({ root, key })
  const { store, service } = await setup({ roots: { 'session-1': root }, legacy })
  try {
    const tree = await service.tree({ sessionId: 'session-1', force: true })
    assert.equal(tree.stats.notes, 1, '旧索引里的笔记要出现在树里')
    assert.equal(tree.collections[0].name, '老分类', '分类树要跟着搬过来')
    assert.deepEqual(tree.pinned, ['n_old'], '置顶也要搬过来')

    const moved = JSON.parse(await readFile(join(root, '.dsh-notes', 'index.json'), 'utf8'))
    assert.deepEqual(Object.keys(moved.notes), ['n_old'])
    assert.equal(moved.workspaces[key].collections.c_old.name, '老分类')
    assert.deepEqual(moved.workspaces[key].ignored, ['ignore-me.md'], '忽略规则属于工作区')
    assert.deepEqual(moved.workspaces[key].ignoredGlobs, ['docs/**'])

    const legacyAfter = JSON.parse(await readFile(join(store, 'registry.json'), 'utf8'))
    assert.deepEqual(Object.keys(legacyAfter.notes), ['n_old'], '自动迁移**不改**旧文件(留作备份)')

    const roots = JSON.parse(await readFile(join(store, 'workspaces.json'), 'utf8'))
    assert.equal(typeof roots.workspaces[key].migratedAt, 'number', '迁移过要留痕,便于排障')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('把工作区复制到别的路径:同一棵树照常读出来(索引记相对路径,搬迁零操作)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-scope-'))
  const rootA = join(base, 'wsA')
  const rootB = join(base, 'wsB')
  await mkdir(join(rootA, 'notes'), { recursive: true })
  const legacy = legacyState({ root: rootA, key: workspaceKeyOf(rootA) })
  await writeFile(join(rootA, 'notes', '旧笔记.md'), '---\ndsh-note-id: n_old\n---\n\n正文\n', 'utf8')
  // 先让 A 完成迁移(产生工作区文件),再**整份复制**到 B(模拟"备份/搬到另一台机器")
  const first = await setup({ roots: { 'session-1': rootA }, legacy })
  let savedInA = null
  try {
    await first.service.tree({ sessionId: 'session-1', force: true })
    await first.service.workspaceOf('session-1')
  } finally {
    await first.service.persist(first.service.registries.keys().next().value)
    savedInA = JSON.parse(await readFile(join(rootA, '.dsh-notes', 'index.json'), 'utf8'))
    await rm(first.base, { recursive: true, force: true })
  }
  await mkdir(base, { recursive: true })
  await rename(rootA, rootB)

  // **这是相对记法的全部意义**:文件里只留一个绝对路径(`ws.root`,它是锚点),
  // 笔记与笔记根都是相对的 —— 所以"换个目录 / 换台机器"根本不需要重定位那一趟。
  const textInA = JSON.stringify(savedInA)
  assert.equal(textInA.includes(`${rootA}/notes`), false, '笔记路径与笔记根都不该记绝对路径')
  assert.equal(savedInA.workspaces[workspaceKeyOf(rootA)].root, toPosix(rootA), 'root 是锚点,必须保留(落盘按插件约定归一)')
  assert.equal(savedInA.notes.n_old.rel, 'notes/旧笔记.md')
  assert.equal('path' in savedInA.notes.n_old, false)
  assert.equal(savedInA.workspaces[workspaceKeyOf(rootA)].notesRootRel, 'notes')

  const { base: base2, service } = await setup({ roots: { 'session-2': rootB } })
  try {
    const tree = await service.tree({ sessionId: 'session-2', force: true })
    assert.equal(tree.workspace.root, toPosix(rootB), '工作区根是当前路径')
    assert.notEqual(workspaceKeyOf(rootB), workspaceKeyOf(rootA), '换路径 = 换键(前提成立)')
    assert.equal(tree.stats.notes, 1, '笔记条目还在')
    assert.equal(tree.notes[0].path, toPosix(join(rootB, 'notes', '旧笔记.md')), '绝对路径按**当前根**展开')
    assert.equal(tree.notes[0].relPath, 'notes/旧笔记.md')
    assert.equal(tree.collections[0].name, '老分类', '人工组织跟着备份走')
    assert.equal(tree.workspace.notesRoot, toPosix(join(rootB, 'notes')), '笔记根也跟着走')
    const saved = JSON.parse(await readFile(join(rootB, '.dsh-notes', 'index.json'), 'utf8'))
    assert.deepEqual(Object.keys(saved.workspaces), [workspaceKeyOf(rootB)], '文件里不该再留旧键')
    assert.equal(JSON.stringify(saved).includes(rootA), false, '新文件里不该残留旧根')
  } finally {
    await rm(base, { recursive: true, force: true })
    await rm(base2, { recursive: true, force: true })
  }
})

test('.dsh-notes 永远不被扫描:回收站里的 md 不会被当成候选笔记捞回来', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-scope-'))
  const root = join(base, 'ws')
  await mkdir(join(root, 'notes'), { recursive: true })
  await mkdir(join(root, '.dsh-notes', '.trash'), { recursive: true })
  await writeFile(join(root, '.dsh-notes', 'index.json'), '{}\n', 'utf8')
  await writeFile(join(root, '.dsh-notes', '.trash', 't_1-删掉的.md'), '---\ndsh-note-id: n_gone\n---\n', 'utf8')
  await writeFile(join(root, 'notes', '真笔记.md'), '---\ndsh-note-id: n_real\n---\n', 'utf8')
  const { service } = await setup({ roots: { 'session-1': root } })
  try {
    const workspace = await service.workspaceOf('session-1')
    const scan = await service.scanWorkspace(workspace.key, { force: true })
    const paths = scan.files.map((file) => file.relPath)
    assert.deepEqual(paths, ['notes/真笔记.md'], `.dsh-notes 下的东西一个都不能出现(${JSON.stringify(paths)})`)
    const classified = await service.classify(workspace.key, { force: true })
    assert.equal(
      classified.candidates.some((item) => item.relPath.includes('.dsh-notes')),
      false,
      '候选列表里也不能冒出来',
    )
    assert.equal(classified.ignored.some((item) => item.relPath.includes('.dsh-notes')), false)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('只看一眼的工作区:不创建 .dsh-notes/(切过去渲染一次树也不留东西)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-scope-'))
  const root = join(base, 'idle')
  await mkdir(join(root, 'notes'), { recursive: true })
  const { service } = await setup({ roots: { 'session-1': root } })
  try {
    const tree = await service.tree({ sessionId: 'session-1', force: true })
    assert.equal(tree.stats.notes, 0)
    assert.equal(await exists(join(root, '.dsh-notes')), false, '看一眼不该在工作区里建目录')

    // 真有东西要记时才建(登记一篇笔记)
    await writeFile(join(root, 'notes', '甲.md'), '---\ndsh-note-id: n_jia\n---\n\n甲\n', 'utf8')
    await service.register({ sessionId: 'session-1', path: join(root, 'notes', '甲.md') })
    assert.equal(await exists(join(root, '.dsh-notes', 'index.json')), true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('回收站跟着工作区走:文件搬进 <root>/.dsh-notes/.trash,可恢复、可彻底删除', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-scope-'))
  const root = join(base, 'ws')
  await mkdir(join(root, 'notes'), { recursive: true })
  await writeFile(join(root, 'notes', '甲.md'), '---\ndsh-note-id: n_jia\n---\n\n甲\n', 'utf8')
  const { service } = await setup({ roots: { 'session-1': root } })
  try {
    const note = await service.register({ sessionId: 'session-1', path: join(root, 'notes', '甲.md') })
    const trashed = await service.trashNote({ sessionId: 'session-1', noteId: note.id })
    assert.equal(trashed.file.startsWith(toPosix(join(root, '.dsh-notes', '.trash'))), true, `回收站要在工作区里:${trashed.file}`)
    assert.equal(await exists(join(root, 'notes', '甲.md')), false)

    const list = await service.listTrash({ sessionId: 'session-1' })
    assert.equal(list.entries.length, 1)
    assert.equal(list.root, toPosix(join(root, '.dsh-notes', '.trash')))
    assert.equal(await service.noteById(note.id), undefined, '索引里不该还留着')

    const restored = await service.restoreTrash({ sessionId: 'session-1', id: trashed.id })
    assert.equal(restored.path, toPosix(join(root, 'notes', '甲.md')))
    assert.equal(await exists(join(root, 'notes', '甲.md')), true, '恢复必须把文件挪回原处')
    assert.notEqual(await service.noteById(restored.note.id), undefined)

    const again = await service.trashNote({ sessionId: 'session-1', noteId: restored.note.id })
    assert.deepEqual(await service.purgeTrash({ sessionId: 'session-1', all: true }), { removed: 1 })
    assert.equal(await exists(again.file), false, '彻底删除才真的 unlink')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('只读工作区:读照常(界面能用),写降级不抛', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-scope-'))
  const root = join(base, 'ws')
  await mkdir(join(root, 'notes'), { recursive: true })
  await writeFile(join(root, 'notes', '甲.md'), '---\ndsh-note-id: n_jia\n---\n\n甲\n', 'utf8')
  const { service } = await setup({ roots: { 'session-1': root } })
  try {
    const note = await service.register({ sessionId: 'session-1', path: join(root, 'notes', '甲.md') })
    // 把索引目录设成只读:mkdir/writeFile 都会失败
    await chmod(join(root, '.dsh-notes'), 0o500)
    const tree = await service.tree({ sessionId: 'session-1', force: true })
    assert.equal(tree.stats.notes, 1, '写不进去也要能读(内存里的索引仍然有效)')
    assert.equal(tree.notes[0].id, note.id)
  } finally {
    await chmod(join(root, '.dsh-notes'), 0o700).catch(() => {})
    await rm(base, { recursive: true, force: true })
  }
})

test('migrate:显式 toHome / toWorkspace 是**移动**语义(不两边各留一半)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-scope-'))
  const root = join(base, 'ws')
  await mkdir(join(root, 'notes'), { recursive: true })
  await writeFile(join(root, 'notes', '甲.md'), '---\ndsh-note-id: n_jia\n---\n\n甲\n', 'utf8')
  const { service, store } = await setup({ roots: { 'session-1': root } })
  try {
    const note = await service.register({ sessionId: 'session-1', path: join(root, 'notes', '甲.md') })
    const toHome = await service.migrateStore({ sessionId: 'session-1', direction: 'toHome' })
    assert.equal(toHome.scope, 'home')
    const home = JSON.parse(await readFile(join(store, 'registry.json'), 'utf8'))
    assert.deepEqual(Object.keys(home.notes), [note.id], '笔记被合并回旧索引')
    assert.equal(await exists(join(root, '.dsh-notes', 'index.json')), false, '工作区文件被挪走(改名留档)')
    assert.equal(await exists(toHome.moved), true, '留档而不是删除')

    const back = await service.migrateStore({ sessionId: 'session-1', direction: 'toWorkspace' })
    assert.equal(back.scope, 'workspace')
    const workspaceFile = JSON.parse(await readFile(join(root, '.dsh-notes', 'index.json'), 'utf8'))
    assert.deepEqual(Object.keys(workspaceFile.notes), [note.id])
    const afterLegacy = JSON.parse(await readFile(join(store, 'registry.json'), 'utf8'))
    assert.deepEqual(Object.keys(afterLegacy.notes), [], '搬回工作区后旧索引里不再留底(移动语义)')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('工作区列表:来自机器本地的已知根表,笔记条数从各工作区自己的文件里数', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-scope-'))
  const rootA = join(base, 'a')
  const rootB = join(base, 'b')
  for (const root of [rootA, rootB]) {
    await mkdir(join(root, 'notes'), { recursive: true })
    await writeFile(join(root, 'notes', '甲.md'), '---\ndsh-note-id: n_jia\n---\n\n甲\n', 'utf8')
  }
  const { service } = await setup({ roots: { 'session-1': rootA, 'session-2': rootB } })
  try {
    await service.register({ sessionId: 'session-1', path: join(rootA, 'notes', '甲.md') })
    await service.register({ sessionId: 'session-2', path: join(rootB, 'notes', '甲.md') })
    const list = await service.listWorkspaces({ sessionId: 'session-1' })
    const keys = list.workspaces.map((row) => row.key).sort()
    assert.deepEqual(keys, [workspaceKeyOf(rootA), workspaceKeyOf(rootB)].sort())
    assert.equal(list.current, workspaceKeyOf(rootA))
    const rowA = list.workspaces.find((row) => row.key === workspaceKeyOf(rootA))
    const rowB = list.workspaces.find((row) => row.key === workspaceKeyOf(rootB))
    assert.equal(rowA.notes, 1, '装载过的数内存')
    assert.equal(rowA.name, 'a')
    assert.equal(rowB.notes, 1, '没装载过的读它那一个小文件也应该数得出来')
    assert.equal(rowA.notesDirMissing, false)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('storeScope: home 时不碰工作区(逃生开关等价旧行为)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-scope-'))
  const root = join(base, 'ws')
  await mkdir(join(root, 'notes'), { recursive: true })
  await writeFile(join(root, 'notes', '甲.md'), '---\ndsh-note-id: n_jia\n---\n\n甲\n', 'utf8')
  const { service, store } = await setup({ roots: { 'session-1': root }, storeScope: 'home' })
  try {
    await service.register({ sessionId: 'session-1', path: join(root, 'notes', '甲.md') })
    const home = JSON.parse(await readFile(join(store, 'registry.json'), 'utf8'))
    assert.deepEqual(Object.keys(home.notes), ['n_jia'])
    assert.equal(await exists(join(root, '.dsh-notes')), false, 'home 形态不该在工作区里留下任何东西')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
