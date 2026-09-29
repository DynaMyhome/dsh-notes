import { test } from 'node:test'
import assert from 'node:assert/strict'

import { NoteRegistry, noteRecord } from '../lib/registry.js'

/** 建一个只有工作区 `ws` 的空注册表。 */
function registryOf() {
  const registry = new NoteRegistry()
  registry.workspace('ws', { root: '/ws', name: 'ws', notesRoot: '/ws/notes' })
  return registry
}

/** 标题序列(某父下)。 */
function titles(registry, collectionId = null) {
  return registry.siblingsOfNotes('ws', collectionId).map((note) => note.title)
}

function addNote(registry, title) {
  const note = noteRecord({ path: `/ws/notes/${title}.md`, workspaceKey: 'ws', title })
  registry.addNote(note)
  return note
}

test('placeNote: 未设 order 时按标题,显式下标插入能改顺序', () => {
  const registry = registryOf()
  const a = addNote(registry, 'A')
  addNote(registry, 'B')
  const d = addNote(registry, 'D')

  assert.deepEqual(titles(registry), ['A', 'B', 'D'])

  registry.placeNote('ws', d.id, null, 0)
  assert.deepEqual(titles(registry), ['D', 'A', 'B'])

  registry.placeNote('ws', d.id, null, 3)
  assert.deepEqual(titles(registry), ['A', 'B', 'D'])

  // 同父内往下挪:下标按"当前画面"理解(摘除自己后目标前移一位)
  registry.placeNote('ws', d.id, null, 0)
  registry.placeNote('ws', d.id, null, 2)
  assert.deepEqual(titles(registry), ['A', 'D', 'B'])

  // order 被重编号成 1..n
  assert.deepEqual(
    registry.siblingsOfNotes('ws', null).map((note) => note.order),
    [1, 2, 3],
  )
  void a
})

test('placeNote: 换分类 + 分类内排序;跨工作区/未知分类被拒', () => {
  const registry = registryOf()
  registry.createCollection('ws', { name: 'C', parentId: null })
  const collectionId = Object.keys(registry.toJSON().workspaces.ws.collections)[0]
  const a = addNote(registry, 'A')
  addNote(registry, 'B')

  assert.equal(registry.placeNote('ws', a.id, collectionId, 0), true)
  assert.deepEqual(titles(registry, collectionId), ['A'])
  assert.deepEqual(titles(registry), ['B'])

  // 回到顶层并排在最前
  assert.equal(registry.placeNote('ws', a.id, null, 0), true)
  assert.deepEqual(titles(registry), ['A', 'B'])

  // 未知分类 / 未知工作区
  assert.equal(registry.placeNote('ws', a.id, 'c_nope', 0), false)
  assert.equal(registry.placeNote('ws2', a.id, null, 0), false)
  assert.equal(registry.placeNote('ws', 'n_nope', null, 0), false)
})

test('moveCollection: 嵌套 + 同级排序 + 环检测', () => {
  const registry = registryOf()
  registry.createCollection('ws', { name: 'C1', parentId: null })
  registry.createCollection('ws', { name: 'C2', parentId: null })
  registry.createCollection('ws', { name: 'C3', parentId: null })
  const collections = registry.toJSON().workspaces.ws.collections
  const [c1, c2, c3] = Object.keys(collections)

  const names = (parentId = null) => registry.siblingsOfCollections('ws', parentId).map((node) => node.name)
  assert.deepEqual(names(), ['C1', 'C2', 'C3'])

  // 把 C3 排到最前
  assert.equal(registry.moveCollection('ws', c3, null, 0), true)
  assert.deepEqual(names(), ['C3', 'C1', 'C2'])

  // C2 挂到 C1 下
  assert.equal(registry.moveCollection('ws', c2, c1, null), true)
  assert.deepEqual(names(), ['C3', 'C1'])
  assert.deepEqual(names(c1), ['C2'])

  // 成环拒绝:C1 不能挂到自己子孙 C2 下
  assert.equal(registry.moveCollection('ws', c1, c2, null), false)
  assert.equal(registry.moveCollection('ws', c1, c1, null), false)

  // 未知父被拒
  assert.equal(registry.moveCollection('ws', c1, 'c_nope', null), false)
})
