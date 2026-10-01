/**
 * 表格单元格的**行内渲染**(DOM 那一层)。
 *
 * 逻辑全在 {@link ./cell-inline}(纯函数,带单测);这里只做三件事:
 *   1. 用**配置过自定义语法**的解析器把单元格文本单独解析一遍;
 *   2. 交给决策层拿描述;
 *   3. 把节点树落成 DOM(公式走 Temml,与编辑器里同一个渲染器、同一套 CSS)。
 *
 * 为什么要单独成一个文件:它 import 了 Temml,而 `test/` 里没有 Temml 的解析路径
 * (构建工具链装在 `scripts/node_modules`,见 AGENTS)。纯逻辑分出去才能被单测覆盖。
 */

import temml from 'temml'

import { decideDecorations } from '../../../lib/markdown-render.js'
import { inlineNodes, type InlineNode, type InlineOp } from './cell-inline'

/**
 * 节点树 → DOM。
 *
 * **认不出来的 widget 一律退回原文**,绝不把内容吞掉(单元格里的图片/任务框/项目符号
 * 本来就没有意义,退回原文反而是最不容易出错的选择)。
 * @param nodes - {@link inlineNodes} 的输出。
 * @returns 可直接 append 到 `<th>` / `<td>` 的片段。
 */
export function renderInline(nodes: readonly InlineNode[]): DocumentFragment {
  const fragment = document.createDocumentFragment()
  for (const node of nodes) {
    if (node.kind === 'text') {
      fragment.appendChild(document.createTextNode(node.text))
      continue
    }
    if (node.kind === 'mark') {
      const span = document.createElement('span')
      if (node.cls !== '') span.className = node.cls
      span.appendChild(renderInline(node.children))
      fragment.appendChild(span)
      continue
    }
    fragment.appendChild(widgetNode(node))
  }
  return fragment
}

/** 单个 widget → DOM。 */
function widgetNode(node: Extract<InlineNode, { kind: 'widget' }>): Node {
  if (node.widget === 'math') {
    const span = document.createElement('span')
    span.className = 'dsh-cm-math'
    try {
      span.innerHTML = temml.renderToString(node.tex, { throwOnError: false })
    } catch {
      span.textContent = `$${node.tex}$`
    }
    return span
  }
  return document.createTextNode(node.raw)
}

/**
 * 一步到位:单元格原文 → DOM 片段。
 * @param text - 单元格原文。
 * @param parse - 解析器(`markdownLanguage.parser.configure(markdownSyntaxConfig())`)。
 * @param knownTitles - 已存在的笔记标题(双链上色用);不传就当全都不存在。
 * @returns DOM 片段。
 */
export function renderCell(
  text: string,
  parse: (source: string) => unknown,
  knownTitles: Set<string> = new Set(),
): DocumentFragment {
  const source = String(text ?? '')
  if (source === '') return document.createDocumentFragment()
  let ops: InlineOp[] = []
  try {
    // 单元格单独解析:表格里那一格本来就是一段**行内** markdown
    ops = decideDecorations({ tree: parse(source) as never, text: source, knownTitles }) as InlineOp[]
  } catch {
    // 解析/决策失败:退回原文显示 —— 一格 markdown 不该把整张表带崩
    return plainText(source)
  }
  return renderInline(inlineNodes(source, ops))
}

/** 兜底:一段纯文本。 */
function plainText(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  fragment.appendChild(document.createTextNode(source))
  return fragment
}
