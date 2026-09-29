import { test } from 'node:test'
import assert from 'node:assert/strict'

import { NoteRegistry, emptyState, stateFromJSON, noteRecord } from '../lib/registry.js'

function seeded() {
  const registry = new NoteRegistry()
  registry.workspace('ws_a', { root: '/ws_a', name: 'A', notesRoot: '/ws_a/notes' })
  return registry
}

test('workspace: 取/建 + 更新', () => {
  const registry = new NoteRegistry()
  const created = registry.workspace('ws_a', { root: '/ws_a', name: 'A', notesRoot: '/ws_a/notes' })
  assert.equal(created.root, '/ws_a')
  const again = registry.workspace('ws_a', { name: 'A2' })
  assert.equal(again.name, 'A2')
  assert.equal(again.notesRoot, '/ws_a/notes')
})

test('note: 登记 / 改归属 / 删条目(不动文件的概念由纯逻辑保证)', () => {
  const registry = seeded()
  const note = noteRecord({ path: '/ws_a/notes/x.md', workspaceKey: 'ws_a', title: 'X' })
  registry.addNote(note)
  assert.equal(registry.noteById(note.id).title, 'X')
  assert.equal(registry.noteByPath('/ws_a/notes/x.md').id, note.id)

  const collection = registry.createCollection('ws_a', { name: '文献' })
  assert.equal(registry.moveNote(note.id, collection.id), true)
  assert.equal(registry.noteById(note.id).collectionId, collection.id)

  assert.equal(registry.removeNote(note.id), true)
  assert.equal(registry.noteById(note.id), undefined)
  assert.equal(registry.removeNote(note.id), false)
})

test('collection: 建 / 改名 / 环检测 / 两种删除语义', () => {
  const registry = seeded()
  const root = registry.createCollection('ws_a', { name: '根' })
  const child = registry.createCollection('ws_a', { name: '子', parentId: root.id })
  const grand = registry.createCollection('ws_a', { name: '孙', parentId: child.id })

  assert.equal(registry.renameCollection('ws_a', child.id, '子2'), true)
  assert.equal(registry.collection('ws_a', child.id).name, '子2')

  // 把祖先移到后代下面必须被拒绝(否则成环)
  assert.equal(registry.moveCollection('ws_a', root.id, grand.id), false)
  assert.equal(registry.moveCollection('ws_a', grand.id, root.id), true)

  const note = noteRecord({ path: '/ws_a/notes/y.md', workspaceKey: 'ws_a', collectionId: child.id })
  registry.addNote(note)

  // 删 child:孙子上提到 root,笔记跟随到 root
  registry.deleteCollection('ws_a', child.id, 'move-to-parent')
  assert.equal(registry.collection('ws_a', grand.id).parentId, root.id)
  assert.equal(registry.noteById(note.id).collectionId, root.id)

  // 删 root(unfile):笔记变未归类
  registry.deleteCollection('ws_a', root.id, 'unfile')
  assert.equal(registry.noteById(note.id).collectionId, null)
})

test('notesInCollection: 只取本工作区 + 指定分类,按标题排序', () => {
  const registry = seeded()
  const collection = registry.createCollection('ws_a', { name: 'c' })
  registry.addNote(noteRecord({ path: '/ws_a/notes/b.md', workspaceKey: 'ws_a', title: 'b', collectionId: collection.id }))
  registry.addNote(noteRecord({ path: '/ws_a/notes/a.md', workspaceKey: 'ws_a', title: 'a', collectionId: collection.id }))
  registry.addNote(noteRecord({ path: '/ws_a/notes/c.md', workspaceKey: 'ws_a', title: 'c' }))
  registry.workspace('ws_b', { root: '/ws_b' })
  registry.addNote(noteRecord({ path: '/ws_b/notes/z.md', workspaceKey: 'ws_b', title: 'z', collectionId: collection.id }))

  const ids = registry.notesInCollection('ws_a', collection.id)
  assert.deepEqual(
    ids.map((id) => registry.noteById(id).title),
    ['a', 'b'],
  )
})

test('refs / pins / recent', () => {
  const registry = seeded()
  const note = noteRecord({ path: '/ws_a/notes/x.md', workspaceKey: 'ws_a', title: 'X' })
  registry.addNote(note)
  assert.equal(registry.addReference('ws_a', note.id, null), true)
  assert.equal(registry.workspaceOf('ws_a').refs[note.id] !== undefined, true)
  assert.equal(registry.removeReference('ws_a', note.id), true)

  registry.setPinned(note.id, true)
  assert.deepEqual(registry.workspaceOf('ws_a').pins, [note.id])
  registry.setPinned(note.id, false)
  assert.deepEqual(registry.workspaceOf('ws_a').pins, [])

  registry.touchRecent('ws_a', note.id)
  registry.touchRecent('ws_a', note.id)
  assert.deepEqual(registry.workspaceOf('ws_a').recent, [note.id])
})

test('applyScan: 改名/移动按 id 重绑,漏扫的条目直接丢弃(不留 tombstone)', () => {
  const registry = seeded()
  const note = noteRecord({ path: '/ws_a/notes/x.md', workspaceKey: 'ws_a', title: 'X' })
  registry.addNote(note)

  const result = registry.applyScan('ws_a', [
    { id: note.id, path: '/ws_a/notes/sub/x-renamed.md', title: 'X' },
    { id: 'n_other', path: '/ws_a/notes/new.md', title: 'New' },
  ])
  assert.deepEqual(result, { rebound: 1, registered: 0, dropped: 0 })
  assert.equal(registry.noteById(note.id).path, '/ws_a/notes/sub/x-renamed.md')
  // 带 id 但未登记的文件默认不自动纳入(避免污染)
  assert.equal(registry.noteByPath('/ws_a/notes/new.md'), undefined)

  const withUnknown = seeded()
  withUnknown.addNote(noteRecord({ path: '/ws_a/notes/x.md', workspaceKey: 'ws_a' }))
  assert.equal(
    withUnknown.applyScan('ws_a', [{ id: 'n_other', path: '/ws_a/notes/new.md', title: 'New' }], { registerUnknown: true })
      .registered,
    1,
  )
  // 文件消失 → 条目被丢弃
  assert.equal(withUnknown.noteByPath('/ws_a/notes/x.md') === undefined, true)
})

test('applyScan: id 读不出来的扫描条目不会让已登记笔记被误删(回归)', () => {
  const registry = seeded()
  const note = noteRecord({ path: '/ws_a/notes/big.md', workspaceKey: 'ws_a', title: 'big' })
  registry.addNote(note)
  // 超大文件 / 读失败 → id 为 null,但它确实还躺在盘上
  const result = registry.applyScan('ws_a', [{ id: null, path: '/ws_a/notes/big.md', title: 'big' }])
  assert.deepEqual(result, { rebound: 0, registered: 0, dropped: 0 })
  assert.equal(registry.noteById(note.id) !== undefined, true)
})

test('applyScan: 同一工作区里 repeat 扫描不误删仍在盘上的条目', () => {
  const registry = seeded()
  const a = noteRecord({ path: '/ws_a/notes/a.md', workspaceKey: 'ws_a', title: 'a' })
  const b = noteRecord({ path: '/ws_a/notes/b.md', workspaceKey: 'ws_a', title: 'b' })
  registry.addNote(a)
  registry.addNote(b)
  const result = registry.applyScan('ws_a', [
    { id: a.id, path: a.path, title: 'a' },
    { id: b.id, path: b.path, title: 'b' },
  ])
  assert.deepEqual(result, { rebound: 0, registered: 0, dropped: 0 })
  assert.equal(registry.noteById(a.id) !== undefined && registry.noteById(b.id) !== undefined, true)
})

test('stateFromJSON: 往返 + 坏版本拒绝', () => {
  const registry = seeded()
  registry.addNote(noteRecord({ path: '/ws_a/notes/x.md', workspaceKey: 'ws_a', title: 'X' }))
  const text = JSON.stringify(registry.toJSON())
  const restored = stateFromJSON(text)
  assert.equal(Object.keys(restored.notes).length, 1)
  assert.equal(Object.keys(restored.workspaces).length, 1)

  assert.throws(() => stateFromJSON('{"schemaVersion":99,"notes":{},"workspaces":{}}'), /schemaVersion/)
  assert.throws(() => stateFromJSON('[]'), /不是对象/)
})

test('emptyState: 结构固定', () => {
  assert.deepEqual(emptyState(), { schemaVersion: 1, notes: {}, workspaces: {} })
})
