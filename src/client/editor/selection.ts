/**
 * 选区包裹(`**粗**` / `*斜*` / `~~删~~` / `==高亮==` / `` `码` ``)的**纯逻辑**。
 *
 * 为什么单独成模块:这里出过一个会把编辑器**彻底卡死**的 bug —— 构造事务时图省事,
 * 返回了 `{ anchor, head }` **普通对象**冒充 SelectRange。CM6 的 `changeByRange` 会把它
 * **原样**塞进 `selection.ranges`(`EditorSelection.create` 只在 `range.empty`/`range.from`
 * 是数字时才归一化,普通对象两个都没有),于是:
 *
 *   1. **下一个**需要映射选区的编辑事务走到 `EditorSelection.map` 里的
 *      `this.ranges.map((r) => r.map(...))` 时,`r.map` 不存在 →
 *      `TypeError: r.map is not a function` —— 该事务整个失败(打字没反应);
 *   2. CM6 自己的输入处理还会先读 `sel.from`(undefined),在
 *      `doc.lineAt(sel.from)` 上抛 `TypeError: Cannot read properties of undefined`
 *      —— 按键/输入法/粘贴在插入之前就中断。
 *
 * 表现就是用户实测的"**设一次格式就卡死**,必须打开别的笔记再点回来才能继续编辑"
 * (重开笔记会重建一个新的 EditorState/EditorView)。
 *
 * `makeRange` 必须传 `EditorSelection.range`(真正的 SelectionRange)。做成参数注入是为了
 * 让这条规则能在 Node 里用**真 CM6** 测到:运行期的 `@codemirror/state` 是打包进来的,
 * 测试目录解析不了那条裸导入,只能从外面传(见 test/selection.test.mjs)。
 */

import type { EditorState, SelectionRange, TransactionSpec } from '@codemirror/state'

/** 选区构造器(生产代码传 `EditorSelection.range`)。 */
export type MakeRange = (anchor: number, head: number) => SelectionRange

/**
 * 构造"把每个选区两端包上成对标记"的事务描述。
 * @param state - 当前编辑器状态(只用到 `selection` 与 `changeByRange`)。
 * @param makeRange - **必须是** `EditorSelection.range`(见文件头说明)。
 * @param before - 左侧标记。
 * @param after - 右侧标记(默认与左侧相同)。
 * @returns 可直接 `view.dispatch(...)` 的事务描述。
 */
export function wrapSelectionSpec(
  state: EditorState,
  makeRange: MakeRange,
  before: string,
  after: string = before,
): TransactionSpec {
  return state.changeByRange((range) => ({
    changes: [
      { from: range.from, insert: before },
      { from: range.to, insert: after },
    ],
    // 光标停在右侧标记**之前**(恰好包住选中的文字)
    range: makeRange(range.from + before.length, range.to + before.length),
  }))
}
