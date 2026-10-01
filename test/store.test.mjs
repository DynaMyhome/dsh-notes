import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  STORE_DIRNAME,
  isEmptySlice,
  STORE_FILENAME,
  STORE_GITIGNORE,
  adoptWorkspaceKey,
  cacheFileFor,
  dropRoot,
  emptyRoots,
  homeStoreRoot,
  mergeSlice,
  normalizeRoots,
  pluckWorkspace,
  relativizeState,
  resolveStoreScope,
  rootsFile,
  rootsFromLegacy,
  sliceFor,
  storeFileFor,
  storeRootFor,
  trashIndexFileFor,
  trashRootFor,
  upsertRoot,
  workspaceStoreFile,
  workspaceStoreRoot,
} from '../lib/store.js'
import { NoteRegistry, stateFromJSON } from '../lib/registry.js'

/**
 * 存储位置的**决策**与**切片**都是纯函数,所以这一组测试不需要文件系统、也不起服务。
 *
 * 兜的是这次改造的核心命题:插件语义数据放在工作区里、机器本地只留缓存与"见过哪些工作区",
 * 以及"工作区键是派生的、不是数据"(把工作区挪走之后仍然读得出来)。
 */

const WS = '/mnt/d/project/demo'
const ENV = { DSH_HOME: '/home/u/.dsh' }

/** 造一份"整体索引"state。 */
function demoState() {
  return {
    schemaVersion: 1,
    notes: {
      n_a: { id: 'n_a', workspaceKey: 'k1', path: `${WS}/notes/a.md`, title: 'a', collectionId: 'c1', order: 1 },
      n_b: { id: 'n_b', workspaceKey: 'k1', path: `${WS}/notes/b.md`, title: 'b', collectionId: null },
      n_c: { id: 'n_c', workspaceKey: 'k2', path: '/other/notes/c.md', title: 'c', collectionId: null },
    },
    workspaces: {
      k1: { root: WS, name: 'demo', notesRoot: `${WS}/notes`, collections: { c1: { id: 'c1', name: '组', parentId: null, order: 1 } }, refs: { n_c: { collectionId: null, order: 1 } }, pins: ['n_a'], recent: [], ignored: ['x.md'], ignoredGlobs: [], scanRoots: [''] },
      k2: { root: '/other', name: 'other', notesRoot: '/other/notes', collections: {}, refs: {}, pins: [], recent: [], ignored: [], ignoredGlobs: [], scanRoots: [] },
    },
  }
}

test('storeScope:默认 workspace,只有显式 "home" 才回退旧行为', () => {
  assert.equal(resolveStoreScope({}), 'workspace')
  assert.equal(resolveStoreScope({ storeScope: '' }), 'workspace')
  assert.equal(resolveStoreScope({ storeScope: 'workspace' }), 'workspace')
  assert.equal(resolveStoreScope({ storeScope: 'home' }), 'home')
  assert.equal(resolveStoreScope({ storeScope: 'HOME' }), 'workspace', '大小写不敏感地只认 home')
})

test('机器本地根:storeDir 优先,否则 $DSH_HOME/knowledge', () => {
  assert.equal(homeStoreRoot({}, ENV, '/home/u'), '/home/u/.dsh/knowledge')
  assert.equal(homeStoreRoot({ storeDir: '/tmp/store' }, ENV, '/home/u'), '/tmp/store')
  assert.equal(homeStoreRoot({}, {}, '/home/u'), '/home/u/.dsh/knowledge', '没有 DSH_HOME 时退回 ~/.dsh')
  assert.equal(rootsFile({}, ENV, '/home/u'), '/home/u/.dsh/knowledge/workspaces.json')
  assert.equal(cacheFileFor({}, 'abc', ENV, '/home/u'), '/home/u/.dsh/knowledge/index/abc.json')
})

test('工作区形态:语义数据落在 <root>/.dsh-notes/,回收站在其下', () => {
  assert.equal(workspaceStoreRoot(WS), `${WS}/${STORE_DIRNAME}`)
  assert.equal(workspaceStoreFile(WS), `${WS}/${STORE_DIRNAME}/${STORE_FILENAME}`)
  assert.equal(storeRootFor('workspace', {}, WS, ENV, '/home/u'), `${WS}/${STORE_DIRNAME}`)
  assert.equal(storeFileFor('workspace', {}, WS, ENV, '/home/u'), `${WS}/${STORE_DIRNAME}/${STORE_FILENAME}`)
  assert.equal(trashRootFor('workspace', {}, WS, ENV, '/home/u'), `${WS}/${STORE_DIRNAME}/.trash`)
  assert.equal(trashIndexFileFor('workspace', {}, WS, ENV, '/home/u'), `${WS}/${STORE_DIRNAME}/.trash/trash.json`)
  assert.equal(STORE_GITIGNORE, '*\n', '自忽略文件必须让插件数据不出现在 git status 里')
})

test('home 形态:与旧版逐字段一致(逃生开关)', () => {
  assert.equal(storeFileFor('home', {}, WS, ENV, '/home/u'), '/home/u/.dsh/knowledge/registry.json')
  assert.equal(trashIndexFileFor('home', {}, WS, ENV, '/home/u'), '/home/u/.dsh/knowledge/trash/trash.json')
})

test('sliceFor:只留这一个工作区的笔记与节点,且仍能被 NoteRegistry 读', () => {
  const slice = sliceFor(demoState(), 'k1')
  assert.deepEqual(Object.keys(slice.notes), ['n_a', 'n_b'])
  assert.deepEqual(Object.keys(slice.workspaces), ['k1'])
  assert.equal(slice.schemaVersion, 1)
  assert.deepEqual(slice.workspaces.k1.collections.c1.name, '组', '分类树必须完整跟着走')
  assert.deepEqual(slice.workspaces.k1.pins, ['n_a'])
  assert.deepEqual(slice.workspaces.k1.ignored, ['x.md'])

  // 关键:切片与 stateFromJSON/NoteRegistry 同构 —— 工作区文件可以被原样加载
  const registry = new NoteRegistry(stateFromJSON(JSON.stringify(slice)))
  assert.equal(Object.keys(registry.state.notes).length, 2)
  assert.notEqual(registry.workspaceOf('k1'), undefined)
  assert.equal(registry.workspaceOf('k2'), undefined, '切片里不该出现别的工作区')
})

test('adoptWorkspaceKey:工作区被搬走(路径变了 → 键变了)后仍能读出来', () => {
  const state = stateFromJSON(JSON.stringify(sliceFor(demoState(), 'k1')))
  adoptWorkspaceKey(state, 'k9')
  assert.deepEqual(Object.keys(state.workspaces), ['k9'], '单工作区文件整体改挂到新键')
  assert.equal(state.workspaces.k9.collections.c1.name, '组', '人工组织不能丢')
  assert.deepEqual(Object.values(state.notes).map((note) => note.workspaceKey), ['k9', 'k9'], '笔记的键一并改写')
  assert.equal(state.notes.n_a.collectionId, 'c1', '归属不变')
})

test('adoptWorkspaceKey:键已对上时不动结构;多工作区文件不被误改挂', () => {
  const same = stateFromJSON(JSON.stringify(sliceFor(demoState(), 'k1')))
  adoptWorkspaceKey(same, 'k1')
  assert.deepEqual(Object.keys(same.workspaces), ['k1'])

  const multi = stateFromJSON(JSON.stringify(demoState()))
  adoptWorkspaceKey(multi, 'k9')
  assert.deepEqual(Object.keys(multi.workspaces).sort(), ['k1', 'k2'], '多工作区时保持原样(不该乱认领)')
})

test('relativizeState:落盘用相对路径,只剩 root 是绝对的', () => {
  const state = sliceFor(demoState(), 'k1')
  const stored = relativizeState(state, 'k1', WS)

  // 笔记:path → rel
  assert.equal(stored.notes.n_a.rel, 'notes/a.md')
  assert.equal('path' in stored.notes.n_a, false, '绝对路径不该写进工作区文件')
  // 笔记根:绝对 → 相对
  assert.equal(stored.workspaces.k1.notesRootRel, 'notes')
  assert.equal('notesRoot' in stored.workspaces.k1, false)
  // 锚点保留
  assert.equal(stored.workspaces.k1.root, WS)
  // 不改入参(内存态要继续用绝对路径)
  assert.equal(state.notes.n_a.path, `${WS}/notes/a.md`)
  assert.equal(state.workspaces.k1.notesRoot, `${WS}/notes`)
  // 整个文件里没有工作区内的绝对路径
  const text = JSON.stringify(stored)
  assert.equal(text.includes(`${WS}/notes/a.md`), false)
})

test('相对记法:整份拷到别的根下直接可读(不需要重定位)', () => {
  // 1) 在 WS 下组织好,落盘成相对记法
  const stored = relativizeState(sliceFor(demoState(), 'k1'), 'k1', WS)
  // 2) 整份搬到另一个根(键也变了)
  const moved = stateFromJSON(JSON.stringify(stored))
  adoptWorkspaceKey(moved, 'k9', '/elsewhere/ws-2')
  // 3) 路径按新根展开,一条死路径都没有
  assert.deepEqual(
    Object.values(moved.notes).map((note) => note.path).sort(),
    ['/elsewhere/ws-2/notes/a.md', '/elsewhere/ws-2/notes/b.md'],
  )
  assert.equal(moved.workspaces.k9.notesRoot, '/elsewhere/ws-2/notes')
  assert.equal(moved.workspaces.k9.notesRootRel, 'notes')
})

test('旧格式(绝对 path)仍然能读,并在装载时补出 rel 完成迁移', () => {
  const legacy = {
    schemaVersion: 1,
    notes: { n_a: { id: 'n_a', workspaceKey: 'k1', path: `${WS}/notes/a.md`, title: 'a' } },
    workspaces: { k1: { root: WS, name: 'demo', notesRoot: `${WS}/notes`, collections: {}, refs: {}, pins: [], recent: [] } },
  }
  const state = stateFromJSON(JSON.stringify(legacy))
  adoptWorkspaceKey(state, 'k1', WS)
  assert.equal(state.notes.n_a.rel, 'notes/a.md', '装载时就补出相对记法 → 下次落盘即迁移完')
  assert.equal(state.notes.n_a.path, `${WS}/notes/a.md`)
  assert.equal(state.workspaces.k1.notesRootRel, 'notes')
})

test('旧格式 + 工作区已搬家:先按旧根重定位,再补 rel', () => {
  const legacy = {
    schemaVersion: 1,
    notes: { n_a: { id: 'n_a', workspaceKey: 'k1', path: `${WS}/notes/a.md`, title: 'a' } },
    workspaces: { k1: { root: WS, name: 'demo', notesRoot: `${WS}/notes`, collections: {}, refs: {}, pins: [], recent: [] } },
  }
  const state = stateFromJSON(JSON.stringify(legacy))
  adoptWorkspaceKey(state, 'k9', '/elsewhere/ws-2')
  assert.equal(state.notes.n_a.path, '/elsewhere/ws-2/notes/a.md')
  assert.equal(state.notes.n_a.rel, 'notes/a.md')
  assert.equal(state.workspaces.k9.notesRoot, '/elsewhere/ws-2/notes')
})

test('笔记根 = 工作区根本身:notesRootRel 记空串,override 记 "."(两者含义不同)', () => {
  const state = {
    schemaVersion: 1,
    notes: {},
    workspaces: { k1: { root: WS, name: 'demo', notesRoot: WS, notesRootOverride: WS, collections: {}, refs: {}, pins: [], recent: [] } },
  }
  const stored = relativizeState(state, 'k1', WS)
  assert.equal(stored.workspaces.k1.notesRootRel, '', 'notesRootRel 恒有意义 → 空串就是工作区根本身')
  // override 的 `''` 表示"没设过",所以"显式设成工作区根"必须是 `'.'`,否则往返一趟就丢
  assert.equal(stored.workspaces.k1.notesRootOverrideRel, '.')
  const back = stateFromJSON(JSON.stringify(stored))
  adoptWorkspaceKey(back, 'k1', WS)
  assert.equal(back.workspaces.k1.notesRoot, WS)
  assert.equal(back.workspaces.k1.notesRootOverride, WS, '用户显式选过的笔记根不能丢')

  // 没设过 override 时不该凭空长出一个
  const plain = relativizeState(
    { schemaVersion: 1, notes: {}, workspaces: { k1: { root: WS, name: 'demo', notesRoot: `${WS}/notes`, collections: {}, refs: {}, pins: [], recent: [] } } },
    'k1',
    WS,
  )
  assert.equal('notesRootOverrideRel' in plain.workspaces.k1, false)
})

test('工作区外的路径不被硬算成相对(宁可原样保留,也不丢真实路径)', () => {
  const state = {
    schemaVersion: 1,
    notes: { n_x: { id: 'n_x', workspaceKey: 'k1', path: '/outside/other.md', title: 'x' } },
    workspaces: { k1: { root: WS, name: 'demo', notesRoot: WS, collections: {}, refs: {}, pins: [], recent: [] } },
  }
  const stored = relativizeState(state, 'k1', WS)
  assert.equal(stored.notes.n_x.rel, '/outside/other.md')
  const back = stateFromJSON(JSON.stringify(stored))
  adoptWorkspaceKey(back, 'k1', WS)
  assert.equal(back.notes.n_x.path, '/outside/other.md')
})

test('已知根表:从旧整体索引提取、增删、容错', () => {
  const roots = rootsFromLegacy(demoState())
  assert.deepEqual(Object.keys(roots.workspaces).sort(), ['k1', 'k2'])
  assert.equal(roots.workspaces.k1.root, WS)
  assert.equal(roots.workspaces.k1.name, 'demo')
  assert.equal('notes' in roots.workspaces.k1, false, '根表只放路由信息,不放语义数据')

  const added = upsertRoot(roots, 'k3', { root: '/tmp/three', name: 'three', lastUsedAt: 5 })
  assert.equal(added.workspaces.k3.root, '/tmp/three')
  assert.equal(roots.workspaces.k3, undefined, '不改入参')
  const migrated = upsertRoot(added, 'k3', { migratedAt: 7 })
  assert.equal(migrated.workspaces.k3.migratedAt, 7)
  assert.equal(migrated.workspaces.k3.root, '/tmp/three', 'patch 不该把 root 抹掉')
  assert.equal(dropRoot(migrated, 'k3').workspaces.k3, undefined)

  const messy = normalizeRoots({ workspaces: { bad: null, nope: { name: 'x' }, ok: { root: '/r', lastUsedAt: '3' } } })
  assert.deepEqual(Object.keys(messy.workspaces), ['ok'], '没有 root 的条目丢掉;lastUsedAt 非法归零')
  assert.equal(messy.workspaces.ok.lastUsedAt, 0)
  assert.deepEqual(normalizeRoots(null), emptyRoots())
})

test('isEmptySlice:空切片不落盘(用户只是看了一眼的工作区不该多出点目录)', () => {
  const empty = { schemaVersion: 1, notes: {}, workspaces: { k1: { root: '/r', name: 'x', notesRoot: '/r/notes', collections: {}, refs: {}, pins: [], recent: [], ignored: [], ignoredGlobs: [], scanRoots: [], notesRootOverride: '' } } }
  assert.equal(isEmptySlice(empty), true)
  assert.equal(isEmptySlice({ schemaVersion: 1, notes: {}, workspaces: {} }), true)
  assert.equal(isEmptySlice({ schemaVersion: 1, notes: { n_a: { id: 'n_a' } }, workspaces: empty.workspaces }), false, '有笔记 → 要写')
  const withCollection = structuredClone(empty)
  withCollection.workspaces.k1.collections = { c1: { id: 'c1', name: '组', parentId: null, order: 1 } }
  assert.equal(isEmptySlice(withCollection), false, '建了分类 → 要写')
  const withIgnored = structuredClone(empty)
  withIgnored.workspaces.k1.ignored = ['x.md']
  assert.equal(isEmptySlice(withIgnored), false, '标了忽略 → 要写')
  const withRoots = structuredClone(empty)
  withRoots.workspaces.k1.scanRoots = ['']
  assert.equal(isEmptySlice(withRoots), false, '改了扫描范围 → 要写')
  const withOverride = structuredClone(empty)
  withOverride.workspaces.k1.notesRootOverride = '/r/docs'
  assert.equal(isEmptySlice(withOverride), false, '换了笔记根 → 要写')
  const withPin = structuredClone(empty)
  withPin.workspaces.k1.pins = ['n_a']
  assert.equal(isEmptySlice(withPin), false, '有置顶 → 要写')
})

test('mergeSlice / pluckWorkspace:home ⇄ workspace 双向搬运', () => {
  const slice = sliceFor(demoState(), 'k1')
  const home = { schemaVersion: 1, notes: { n_c: demoState().notes.n_c }, workspaces: { k2: demoState().workspaces.k2 } }
  const merged = mergeSlice(home, slice, 'k1')
  assert.deepEqual(Object.keys(merged.notes).sort(), ['n_a', 'n_b', 'n_c'])
  assert.deepEqual(Object.keys(merged.workspaces).sort(), ['k1', 'k2'])
  assert.equal(merged.notes.n_a.workspaceKey, 'k1')
  assert.equal(home.notes.n_a, undefined, '不改入参')

  const plucked = pluckWorkspace(merged, 'k1')
  assert.deepEqual(Object.keys(plucked.notes), ['n_c'])
  assert.deepEqual(Object.keys(plucked.workspaces), ['k2'])
})
