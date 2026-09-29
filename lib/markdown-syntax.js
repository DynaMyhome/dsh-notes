/**
 * 自定义行内语法:`==高亮==` 与 `[[双链]]`。
 *
 * **为什么不用正则二次扫描**:正则通道和语法树/代码区/嵌套互相打架(实测踩过:
 * `==高亮==` 在代码块旁渲染错乱)。正确做法是把它们注册成 **lezer 的真语法节点**,
 * 之后渲染决策层用同一张 handler 表覆盖它们,正则整段删掉。
 *
 * 本文件**不 import 任何东西**:解析回调只用 lezer 传进来的 `cx`。
 * 这样既能在客户端被打包,也能在 Node 测试里用真解析器跑(见 test/markdown-syntax.test.mjs)。
 */

/** 高亮:`Highlight` 包两个 `HighlightMark`。 */
export const HIGHLIGHT_NODES = [{ name: 'Highlight' }, { name: 'HighlightMark' }]

/** 双链:`WikiLink` 包 `WikiLinkTarget`(可带 `WikiLinkAlias`)。 */
export const WIKILINK_NODES = [
  { name: 'WikiLink' },
  { name: 'WikiLinkMark' },
  { name: 'WikiLinkTarget' },
  { name: 'WikiLinkAlias' },
]

const EQ = 61 // '='
const BRACKET_OPEN = 91 // '['
const BRACKET_CLOSE = 93 // ']'
const PIPE = 124 // '|'
const NEWLINE = 10

/**
 * 解析 `==高亮==`。
 * @param {object} cx - lezer 的 InlineContext(`char`/`end`/`elt`/`addElement`)。
 * @param {number} next - 当前位置字符码。
 * @param {number} pos - 当前位置。
 * @returns {number} 结束位置,或 -1 表示不吃这个位置。
 */
export function parseHighlight(cx, next, pos) {
  if (next !== EQ || cx.char(pos + 1) !== EQ) return -1
  if (cx.char(pos + 2) === EQ) return -1 // `===` 不当高亮起始
  for (let cursor = pos + 2; cursor < cx.end - 1; cursor += 1) {
    const ch = cx.char(cursor)
    if (ch === NEWLINE) return -1
    if (ch !== EQ || cx.char(cursor + 1) !== EQ) continue
    if (cursor === pos + 2) return -1 // `====` 空内容
    return cx.addElement(
      cx.elt('Highlight', pos, cursor + 2, [
        cx.elt('HighlightMark', pos, pos + 2),
        cx.elt('HighlightMark', cursor, cursor + 2),
      ]),
    )
  }
  return -1
}

/**
 * 解析 `[[目标]]` / `[[目标|别名]]`。
 *
 * `before: 'Link'`(见 markdownSyntax 配置)很关键:`[[` 也是 `[`,不抢在 Link 之前
 * 会被当成本地链接引用。
 * @param {object} cx - lezer 的 InlineContext。
 * @param {number} next - 当前位置字符码。
 * @param {number} pos - 当前位置。
 * @returns {number} 结束位置,或 -1。
 */
export function parseWikiLink(cx, next, pos) {
  if (next !== BRACKET_OPEN || cx.char(pos + 1) !== BRACKET_OPEN) return -1
  for (let cursor = pos + 2; cursor < cx.end - 1; cursor += 1) {
    const ch = cx.char(cursor)
    if (ch === NEWLINE) return -1
    if (ch !== BRACKET_CLOSE || cx.char(cursor + 1) !== BRACKET_CLOSE) continue
    if (cursor === pos + 2) return -1 // `[[]]` 空目标
    const targetFrom = pos + 2
    let bar = targetFrom
    while (bar < cursor && cx.char(bar) !== PIPE) bar += 1
    const targetTo = bar < cursor ? bar : cursor
    if (targetTo === targetFrom) return -1 // `[[|别名]]` 没目标
    const children = [cx.elt('WikiLinkTarget', targetFrom, targetTo)]
    if (bar < cursor) children.push(cx.elt('WikiLinkAlias', bar + 1, cursor))
    return cx.addElement(
      cx.elt('WikiLink', pos, cursor + 2, [cx.elt('WikiLinkMark', pos, pos + 2), ...children, cx.elt('WikiLinkMark', cursor, cursor + 2)]),
    )
  }
  return -1
}

/** 交给 `markdown({ extensions: [...] })` 的配置。 */
export function markdownSyntaxConfig() {
  return {
    defineNodes: [...HIGHLIGHT_NODES, ...WIKILINK_NODES],
    parseInline: [
      { name: 'Highlight', parse: parseHighlight },
      { name: 'WikiLink', parse: parseWikiLink, before: 'Link' },
    ],
  }
}
