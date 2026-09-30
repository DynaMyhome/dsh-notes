import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 标签/分栏的纯模型(打开/关闭/激活/移栏/持久化)。
 *
 * 模型是 `.ts`,要靠 Node 的类型剥离(`--experimental-strip-types`)才 import 得进来 ——
 * 所以这里**没有该能力就跳过**(直接 `node --test test/*.test.mjs` 也不会红);
 * `npm test` 已经带上这个参数。
 */
let tabs = null
try {
  tabs = await import('../src/client/editor/tabs.ts')
} catch {
  tabs = null
}

const maybe = tabs === null ? test.skip : test
const note = (id, workspaceKey = 'ws') => ({
  key: `${workspaceKey}:${id}`,
  workspaceKey,
  noteId: id,
  path: `/ws/notes/${id}.md`,
  title: id,
})

maybe('openTab:普通打开替换当前标签,同篇只留一个', () => {
  let layout = tabs.openTab(tabs.emptyLayout(), note('a'))
  layout = tabs.openTab(layout, note('b'))
  assert.deepEqual(layout.panes[0].tabs.map((tab) => tab.noteId), ['b'], '默认是替换,不是叠加')
  assert.equal(layout.panes[0].active, 'ws:b')
  // 再打开 a:替换回来;重复打开同一个 key 不应产生两个标签
  layout = tabs.openTab(layout, note('a'))
  layout = tabs.openTab(layout, note('a'))
  assert.deepEqual(layout.panes[0].tabs.map((tab) => tab.noteId), ['a'])
})

maybe('openTab mode=tab:叠加;满 8 个就不再开', () => {
  let layout = tabs.emptyLayout()
  for (let index = 0; index < 10; index += 1) layout = tabs.openTab(layout, note(`n${index}`), { mode: 'tab' })
  assert.equal(layout.panes[0].tabs.length, tabs.MAX_TABS_PER_PANE)
  assert.equal(layout.panes[0].active, 'ws:n7')
})

maybe('openTab mode=split:第 2 栏 + activePane 跟着走', () => {
  let layout = tabs.openTab(tabs.emptyLayout(), note('a'))
  layout = tabs.openTab(layout, note('b'), { mode: 'split' })
  assert.equal(layout.panes.length, 2)
  assert.deepEqual(layout.panes[1].tabs.map((tab) => tab.noteId), ['b'])
  assert.equal(layout.activePane, 'p2')
})

maybe('closeTab:关活动标签 → 激活右邻;第 2 栏空了就收掉', () => {
  let layout = tabs.emptyLayout()
  layout = tabs.openTab(layout, note('a'), { mode: 'tab' })
  layout = tabs.openTab(layout, note('b'), { mode: 'tab' })
  layout = tabs.openTab(layout, note('c'), { mode: 'tab' })
  layout = tabs.activateTab(layout, 'ws:b')
  layout = tabs.closeTab(layout, 'ws:b')
  assert.deepEqual(layout.panes[0].tabs.map((tab) => tab.noteId), ['a', 'c'])
  assert.equal(layout.panes[0].active, 'ws:c', '激活右邻')

  layout = tabs.openTab(layout, note('d'), { mode: 'split' })
  layout = tabs.closeTab(layout, 'ws:d')
  assert.equal(layout.panes.length, 1, '第 2 栏空了要收掉')
  assert.equal(layout.activePane, 'p1')
})

maybe('moveTabToPane:跨栏搬运(源栏空了收掉第 2 栏)', () => {
  let layout = tabs.openTab(tabs.emptyLayout(), note('a'), { mode: 'tab' })
  layout = tabs.openTab(layout, note('b'), { mode: 'split' })
  layout = tabs.moveTabToPane(layout, 'ws:a', 'p2')
  assert.deepEqual(layout.panes[1].tabs.map((tab) => tab.noteId).sort(), ['a', 'b'])
  assert.deepEqual(layout.panes[0].tabs, [])
  layout = tabs.moveTabToPane(layout, 'ws:a', 'p1')
  assert.deepEqual(layout.panes[0].tabs.map((tab) => tab.noteId), ['a'])
})

maybe('closeSecondPane / closeOtherTabs / pruneTabs', () => {
  let layout = tabs.openTab(tabs.emptyLayout(), note('a'), { mode: 'tab' })
  layout = tabs.openTab(layout, note('b'), { mode: 'split' })
  layout = tabs.closeSecondPane(layout)
  assert.equal(layout.panes.length, 1)
  assert.deepEqual(layout.panes[0].tabs.map((tab) => tab.noteId).sort(), ['a', 'b'], '并入第 1 栏')

  layout = tabs.closeOtherTabs(layout, 'ws:a')
  assert.deepEqual(layout.panes[0].tabs.map((tab) => tab.noteId), ['a'])

  layout = tabs.openTab(layout, note('gone'), { mode: 'tab' })
  layout = tabs.pruneTabs(layout, (key) => key !== 'ws:gone')
  assert.deepEqual(layout.panes[0].tabs.map((tab) => tab.noteId), ['a'], '索引里没有的标签要被清掉')
})

maybe('持久化:loadLayout 在没有 localStorage(或坏数据)时给空布局', () => {
  // Node 里没有 window → 走 catch 分支
  const layout = tabs.loadLayout('ws')
  assert.equal(layout.panes.length, 1)
  assert.deepEqual(layout.panes[0].tabs, [])
})

maybe('pruneTabsForWorkspace:只删"本工作区里确实没有"的标签(跨工作区/未解析键的都不动)', () => {
  const wsKey = 'wsA'
  const other = { ...note('x', 'wsB'), key: 'wsB:n_x' }
  const legacy = { ...note('y', 'session'), key: 'session:n_y' }
  let layout = tabs.emptyLayout()
  layout = tabs.openTab(layout, note('a', wsKey))
  layout = tabs.openTab(layout, other, { mode: 'tab' })
  layout = tabs.openTab(layout, legacy, { mode: 'tab' })

  // a 还在索引里 → 一个都不该被删(noteId 就是 note() 里给的 id)
  let pruned = tabs.pruneTabsForWorkspace(layout, wsKey, ['a'])
  assert.equal(pruned.panes[0].tabs.length, 3, '别的工作区/旧键的标签不能被误删')

  // a 从索引里消失 → 只删它
  pruned = tabs.pruneTabsForWorkspace(layout, wsKey, [])
  assert.deepEqual(pruned.panes[0].tabs.map((tab) => tab.noteId), ['x', 'y'], '只删属于本工作区且已不存在的')
})

maybe('pruneTabsForWorkspace:第 2 栏空了才收掉', () => {
  const wsKey = 'wsA'
  let layout = tabs.openTab(tabs.emptyLayout(), note('a', wsKey))
  layout = tabs.openTab(layout, note('b', wsKey), { mode: 'split' })
  assert.equal(layout.panes.length, 2)
  const pruned = tabs.pruneTabsForWorkspace(layout, wsKey, ['a'])
  assert.equal(pruned.panes.length, 1, 'b 没了 → 第 2 栏收掉')
  assert.deepEqual(pruned.panes[0].tabs.map((tab) => tab.noteId), ['a'])
})

maybe('migrateLayout:只在目标还没有布局时迁移一次', () => {
  const store = new Map()
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  }
  store.set(tabs.layoutStorageKey('session'), '{"panes":[],"activePane":"p1"}')
  assert.equal(tabs.migrateLayout('session', 'wsA', storage), true, '应当迁移')
  assert.equal(storage.getItem(tabs.layoutStorageKey('wsA')), '{"panes":[],"activePane":"p1"}')
  assert.equal(storage.getItem(tabs.layoutStorageKey('session')), null, '旧键要删掉')

  // 目标已经有自己的布局 → 不动
  store.set(tabs.layoutStorageKey('session'), '旧的')
  store.set(tabs.layoutStorageKey('wsB'), '已有的')
  assert.equal(tabs.migrateLayout('session', 'wsB', storage), false)
  assert.equal(storage.getItem(tabs.layoutStorageKey('wsB')), '已有的')

  // 源不存在、或 from === to → 不动
  assert.equal(tabs.migrateLayout('archive', 'wsC', storage), false)
  assert.equal(tabs.migrateLayout('wsA', 'wsA', storage), false)
})

maybe('moveTab:栏内重排(按中线算出的 index)', () => {
  let layout = tabs.emptyLayout()
  layout = tabs.openTab(layout, note('a'), { mode: 'tab' })
  layout = tabs.openTab(layout, note('b'), { mode: 'tab' })
  layout = tabs.openTab(layout, note('c'), { mode: 'tab' })
  // 把 c 拖到最前
  const moved = tabs.moveTab(layout, 'ws:c', { pane: 'p1', index: 0 })
  assert.deepEqual(moved.panes[0].tabs.map((tab) => tab.noteId), ['c', 'a', 'b'])
  // 把 c 再拖到末尾(下标是"摘掉自己前"的 3 → 修正成 2)
  const back = tabs.moveTab(moved, 'ws:c', { pane: 'p1', index: 3 })
  assert.deepEqual(back.panes[0].tabs.map((tab) => tab.noteId), ['a', 'b', 'c'])
})

maybe('moveTab:跨栏 + 第 2 栏空了收掉 + 位置没变是空操作', () => {
  let layout = tabs.openTab(tabs.emptyLayout(), note('a'), { mode: 'tab' })
  layout = tabs.openTab(layout, note('b'), { mode: 'split' })
  // a(第 1 栏)拖到第 2 栏最前
  const merged = tabs.moveTab(layout, 'ws:a', { pane: 'p2', index: 0 })
  assert.equal(merged.panes.length, 2)
  assert.deepEqual(merged.panes[0].tabs.map((tab) => tab.noteId), [])
  assert.deepEqual(merged.panes[1].tabs.map((tab) => tab.noteId), ['a', 'b'])
  // 再把 a 拖回第 1 栏:a 走后第 2 栏还有 b,所以两栏都在
  const back = tabs.moveTab(merged, 'ws:a', { pane: 'p1', index: 0 })
  assert.deepEqual(back.panes[0].tabs.map((tab) => tab.noteId), ['a'])
  // 只剩一个标签的第 2 栏被搬空 → 收掉
  const collapsed = tabs.moveTab(back, 'ws:b', { pane: 'p1', index: 1 })
  assert.equal(collapsed.panes.length, 1, '第 2 栏空了要收掉')
  assert.deepEqual(collapsed.panes[0].tabs.map((tab) => tab.noteId), ['a', 'b'])
  // 位置没变:原样返回(引用相同 → 不会触发写盘/重渲染)
  assert.equal(tabs.moveTab(collapsed, 'ws:a', { pane: 'p1', index: 0 }), collapsed)
})
