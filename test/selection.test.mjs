import { test } from 'node:test'
import assert from 'node:assert/strict'

import { wrapSelectionSpec } from '../src/client/editor/selection.ts'

/**
 * 真 CM6 的 state 包(纯 JS,不需要 DOM)。依赖装在构建工具链目录,走相对路径 deep import。
 * 说明:`src/client/editor/selection.ts` 只做 **type-only** 导入,所以这里能直接 import 它。
 */
const { EditorState, EditorSelection } = await import('../scripts/node_modules/@codemirror/state/dist/index.js')

/** 造一个状态(默认选中 `aaa`)。 */
const stateOf = (doc = 'aaa bbb', selection = { anchor: 0, head: 3 }) => EditorState.create({ doc, selection })

test('wrapSelectionSpec:包裹后选区的 range 必须是真 SelectionRange(否则下一个事务崩)', () => {
  const state = stateOf()
  const next = state.update(wrapSelectionSpec(state, EditorSelection.range, '**')).state
  assert.equal(next.doc.toString(), '**aaa** bbb')
  const range = next.selection.ranges[0]
  assert.equal(typeof range.map, 'function', 'range.map 必须存在')
  assert.equal(range.from, 2)
  assert.equal(range.to, 5)
  // 关键回归:紧接着一次**只改文档**的事务(用户"接着打字"就是这个形状)必须成功。
  // 这就是"设一次格式就卡死"的靶子 —— 旧实现(普通对象)在这里抛
  // `TypeError: r.map is not a function`。
  const typed = next.update({ changes: { from: 0, insert: 'X' } }).state
  assert.equal(typed.doc.toString(), 'X**aaa** bbb')
})

test('wrapSelectionSpec:空选区(只敲 Ctrl-B)光标落在两个标记之间', () => {
  const state = stateOf('aaa', { anchor: 3, head: 3 })
  const next = state.update(wrapSelectionSpec(state, EditorSelection.range, '**')).state
  assert.equal(next.doc.toString(), 'aaa****')
  assert.equal(next.selection.main.head, 5)
  assert.equal(typeof next.selection.main.map, 'function')
  assert.equal(next.update({ changes: { from: 0, insert: 'X' } }).state.doc.toString(), 'Xaaa****')
})

test('wrapSelectionSpec:前后标记不同也能用(如 `==` 以外的成对语法)', () => {
  const state = stateOf('aaa bbb')
  const next = state.update(wrapSelectionSpec(state, EditorSelection.range, '<', '>')).state
  assert.equal(next.doc.toString(), '<aaa> bbb')
  assert.equal(next.selection.main.from, 1)
  assert.equal(next.selection.main.to, 4)
})

test('回归锁:用普通对象冒充 SelectRange 会让下一个事务抛 TypeError(这就是卡死的真因)', () => {
  const state = stateOf()
  const broken = wrapSelectionSpec(state, (anchor, head) => ({ anchor, head }), '**')
  const next = state.update(broken).state
  // 文档看着改对了(所以用户以为"格式化成功了"),但选区已经坏掉:
  assert.equal(next.doc.toString(), '**aaa** bbb')
  assert.equal(typeof next.selection.ranges[0].map, 'undefined', '普通对象没有 map')
  assert.throws(
    // 必须取 `.state`:事务本身是惰性的,映射选区发生在应用事务时
    () => next.update({ changes: { from: 0, insert: 'X' } }).state,
    /r\.map is not a function/,
    '下一个事务会崩 —— 编辑器"卡死"到只能重开笔记',
  )
})
