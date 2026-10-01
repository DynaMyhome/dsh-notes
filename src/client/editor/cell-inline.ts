/**
 * 表格单元格的**行内节点模型**(纯函数,无 DOM、无 Temml —— 所以能在 `node --test` 里单测)。
 *
 * 背景:单元格以前是 `td.textContent = cell.text` —— 表格里的 `**加粗**`、`$公式$`、
 * `==高亮==`、`` `代码` `` 全是**原文**(用户实测:"表格里面没法渲染")。
 *
 * 规则**不在这里再写一套**:决策层(`lib/markdown-render.js` 的 `decideDecorations`)
 * 给出一串**扁平区间**(mark / hide / widget),这里只负责把它还原成**嵌套树**:
 * `**粗体里的 `代码`**` 是 MARK(0,12) 套 MARK(7,11) + 两个 HIDE(`**` 与 `` ` ``)。
 * 谁该藏、谁该露仍然只有决策层说了算(AGENTS「渲染管线」的硬约束)。
 */

import { HIDE, MARK, WIDGET } from '../../../lib/markdown-render.js'

/** 决策层的描述(这里只关心行内这三种)。 */
export interface InlineOp {
  kind: string
  from: number
  to: number
  cls?: string
  widget?: string
  data?: { tex?: string }
}

/** 折出来的行内节点。 */
export type InlineNode =
  | { kind: 'text'; text: string }
  | { kind: 'mark'; cls: string; children: InlineNode[] }
  | { kind: 'widget'; widget: string; tex: string; raw: string }

/**
 * 行内类名 —— 与 `decorate.ts` 的 `MARK_CLASS`、`setup.ts` 的 theme **必须一致**。
 * 不一致的表现是"正文里的加粗是粗的、表格里的不是"(只在表格里露馅,很难查)。
 */
export const MARK_CLASS: Record<string, string> = {
  strong: 'dsh-cm-strong',
  em: 'dsh-cm-em',
  code: 'dsh-cm-code',
  strike: 'dsh-cm-strike',
  highlight: 'dsh-cm-highlight',
  link: 'dsh-cm-link',
  wiki: 'dsh-cm-wiki',
  wikiNew: 'dsh-cm-wiki-new',
}

/**
 * 把一个单元格的描述折成节点树。
 * @param text - 单元格原文(表格行里两 `|` 之间的那一段)。
 * @param ops - 决策层给的描述(扁平区间)。
 * @returns 节点树(顺序即渲染顺序)。
 */
export function inlineNodes(text: string, ops: readonly InlineOp[]): InlineNode[] {
  const source = String(text ?? '')
  const length = source.length
  const bounded = ops.filter(
    (op) =>
      (op.kind === MARK || op.kind === WIDGET || op.kind === HIDE) &&
      Number.isFinite(op.from) &&
      Number.isFinite(op.to) &&
      op.from >= 0 &&
      op.to <= length &&
      op.to >= op.from,
  )
  /** 藏起来的区间(标记本身:`**`、`$`、`[[`…`]]`):吐文本时要跳过。 */
  const hidden: Array<[number, number]> = bounded.filter((op) => op.kind === HIDE).map((op) => [op.from, op.to])
  return build(0, length, bounded.filter((op) => op.kind !== HIDE), hidden, source)
}

/** 递归折区间:外层先消费,内层在自己那一段里再折(所以按 from 升序、同 from 取外层). */
function build(from: number, to: number, boxes: readonly InlineOp[], hidden: Array<[number, number]>, text: string): InlineNode[] {
  const inner = boxes
    .filter((op) => op.from >= from && op.to <= to)
    .sort((left, right) => left.from - right.from || right.to - left.to)
  const out: InlineNode[] = []
  let cursor = from
  for (const op of inner) {
    // 与已消费的区间重叠:正常不该出现(决策层给的是嵌套区间);真出现了就当没看见,
    // 免得同一段文字被吐两遍
    if (op.from < cursor) continue
    if (op.from > cursor) pushText(out, text, cursor, op.from, hidden)
    if (op.kind === MARK) {
      out.push({
        kind: 'mark',
        cls: MARK_CLASS[String(op.cls ?? '')] ?? '',
        children: build(op.from, op.to, boxes.filter((item) => item !== op), hidden, text),
      })
    } else {
      out.push({
        kind: 'widget',
        widget: String(op.widget ?? ''),
        tex: String(op.data?.tex ?? ''),
        raw: text.slice(op.from, op.to),
      })
    }
    cursor = op.to
  }
  if (cursor < to) pushText(out, text, cursor, to, hidden)
  return out
}

/** 吐一段文本,并跳过其中被隐藏的区间。 */
function pushText(out: InlineNode[], text: string, from: number, to: number, hidden: Array<[number, number]>): void {
  let cursor = from
  for (const [start, end] of hidden.filter(([a, b]) => b > from && a < to).sort((left, right) => left[0] - right[0])) {
    const cutFrom = Math.max(start, from)
    const cutTo = Math.min(end, to)
    if (cutFrom > cursor) out.push({ kind: 'text', text: text.slice(cursor, cutFrom) })
    cursor = Math.max(cursor, cutTo)
  }
  if (cursor < to) out.push({ kind: 'text', text: text.slice(cursor, to) })
}

/**
 * 节点树拍平成可读文本(调试与单测断言用;widget 用它的原文)。
 * @param nodes - {@link inlineNodes} 的输出。
 * @returns 去掉标记之后的可见文字。
 */
export function nodeText(nodes: readonly InlineNode[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.kind === 'text') out += node.text
    else if (node.kind === 'mark') out += nodeText(node.children)
    else out += node.raw
  }
  return out
}

/** 收集节点树里所有行的类名(单测用)。 */
export function nodeClasses(nodes: readonly InlineNode[]): string[] {
  const out: string[] = []
  for (const node of nodes) {
    if (node.kind === 'mark') {
      if (node.cls !== '') out.push(node.cls)
      out.push(...nodeClasses(node.children))
    } else if (node.kind === 'widget') {
      out.push(`@${node.widget}`)
    }
  }
  return out
}
