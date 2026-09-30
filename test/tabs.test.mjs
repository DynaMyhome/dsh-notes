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
