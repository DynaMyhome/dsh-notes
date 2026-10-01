import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  STORE_DIRNAME,
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

const WS = '/data/project/demo'
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
