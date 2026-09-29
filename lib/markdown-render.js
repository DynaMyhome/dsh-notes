/**
 * Markdown 渲染决策层 —— **纯函数**。
 *
 * 输入:语法树 + 文本 + 选区;输出:一串「装饰描述」(普通对象,不含 CM6 类型)。
 * 运行时(src/client/editor/setup.ts)把它翻译成 CodeMirror 的 Decoration;
 * 测试在 Node 里用 `@lezer/markdown` 的真语法树跑,**不需要 DOM**。
 *
 * 为什么这么分层:渲染出问题必须能"一条规则一个用例",而不是靠人盯着截图看。
 *
 * 两条关键约定(与 Obsidian / cm6-live-preview 一致):
 *   1. **还原源码的唯一条件是 `cursorInRange`**(选区与目标范围相交),不再按"所在行"判定;
 *   2. **块级标记(标题/引用/列表/围栏)看整行**,行内标记(加粗/斜体/行内码/链接)看自身范围。
 */

/** 描述类型。 */
export const LINE = 'line'
export const HIDE = 'hide'
export const MARK = 'mark'
export const WIDGET = 'widget'

/** 判定选区是否与 `[from, to]` 相交。 */
export function cursorInRange(selection, from, to) {
  for (const range of selection) {
    if (range.from <= to && range.to >= from) return true
  }
  return false
}

/** 行索引(供纯逻辑使用,不依赖 CM6 的 Text)。 */
export function lineIndex(text) {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1)
  }
  return {
    count: starts.length,
    start: (line) => starts[Math.max(0, Math.min(starts.length - 1, line - 1))],
    end: (line) =>
      line >= starts.length ? text.length : Math.max(starts[line - 1], starts[line] - 1),
    lineOf: (pos) => {
      let low = 0
      let high = starts.length - 1
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        if (starts[mid] <= pos) low = mid
        else high = mid - 1
      }
      return low + 1
    },
    text: (line) => text.slice(starts[line - 1], line >= starts.length ? text.length : starts[line] - 1),
  }
}

/** 遍历直接子节点(`SyntaxNode.children` 在本环境恒为 null,只能用 firstChild/nextSibling)。 */
function childrenOf(node) {
  const out = []
  for (let child = node.firstChild; child !== null; child = child.nextSibling) out.push(child)
  return out
}

/** 文档开头的 frontmatter(`---` … `---`)。 */
function frontmatter(lines) {
  if (lines.count < 2) return null
  if (lines.text(1).trim() !== '---') return null
  const limit = Math.min(lines.count, 60)
  for (let number = 2; number <= limit; number += 1) {
    const value = lines.text(number).trim()
    if (value === '---' || value === '...') return { to: lines.end(number), lastLine: number }
  }
  return null
}

/** 标题节点 → 行装饰类。 */
const HEADINGS = {
  ATXHeading1: 'h1',
  ATXHeading2: 'h2',
  ATXHeading3: 'h3',
  ATXHeading4: 'h4',
  ATXHeading5: 'h5',
  ATXHeading6: 'h6',
  SetextHeading1: 'h1',
  SetextHeading2: 'h2',
}

/** 行内标记节点 → 类名(标记符号在非还原态隐藏)。 */
const INLINE = {
  StrongEmphasis: 'strong',
  Emphasis: 'em',
  InlineCode: 'code',
  Strikethrough: 'strike',
}

/** 解析图片地址(与运行时一致:相对路径交给外壳解析成同源 URL 时用)。 */
export function parseImage(raw) {
  const match = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(raw)
  if (match === null) return null
  return { alt: match[1], destination: match[2] }
}

/**
 * 计算整篇文档的装饰描述。
 *
 * @param {object} input - `{ tree, text, selection, knownTitles }`。
 * @param {import('@lezer/common').Tree} input.tree - 语法树(`parser.parse(text)`)。
 * @param {string} input.text - 正文。
 * @param {Array<{from:number,to:number}>} [input.selection] - 选区(默认文档开头的空选区)。
 * @param {Set<string>} [input.knownTitles] - 已存在的笔记标题(双链上色用)。
 * @returns {Array<{kind:string, from:number, to:number, cls?:string, widget?:string, data?:object}>}
 */
export function decideDecorations({
  tree,
  text,
  selection = [{ from: 0, to: 0 }],
  knownTitles = new Set(),
  reveal = false,
}) {
  const out = []
  const lines = lineIndex(text)
  const front = frontmatter(lines)
  // 预览模式(Typora 式)默认 **不还原源码**:标记一律隐藏,文字照样能编辑。
  // 只有 `reveal: true`(源码模式 / 显式要求)才用选区判定还原。
  const activeSelection = reveal ? selection : []
  const add = (kind, from, to, extra = {}) => {
    out.push({ kind, from, to, ...extra })
  }
  /** 块级标记是否该还原(看整行)。 */
  const revealLine = (pos) => {
    const number = lines.lineOf(pos)
    return cursorInRange(activeSelection, lines.start(number), lines.end(number))
  }

  if (front !== null) {
    for (let number = 1; number <= front.lastLine; number += 1) {
      add(LINE, lines.start(number), lines.start(number), { cls: 'frontmatter' })
    }
  }

  const walk = (node) => {
    const name = node.name
    // 只跳过**完全落在** frontmatter 里的节点 —— 早期写成 `node.from < front.to`
    // 会把 Document 根节点也拦掉,结果整篇除了 frontmatter 什么都不渲染(已修)。
    if (front !== null && name !== 'Document' && node.to <= front.to) return
    const raw = text.slice(node.from, node.to)

    // 行级块
    const heading = HEADINGS[name]
    if (heading !== undefined) {
      add(LINE, lines.start(lines.lineOf(node.from)), lines.start(lines.lineOf(node.from)), { cls: heading })
    } else if (name === 'Blockquote') {
      const start = lines.lineOf(node.from)
      const end = lines.lineOf(node.to)
      for (let number = start; number <= end; number += 1) {
        add(LINE, lines.start(number), lines.start(number), { cls: 'quote' })
      }
    } else if (name === 'HorizontalRule') {
      add(LINE, lines.start(lines.lineOf(node.from)), lines.start(lines.lineOf(node.from)), { cls: 'rule' })
      return
    } else if (name === 'FencedCode' || name === 'CodeBlock') {
      const start = lines.lineOf(node.from)
      const end = lines.lineOf(Math.max(node.from, node.to - 1))
      for (let number = start; number <= end; number += 1) {
        const value = lines.text(number)
        // 首行 = 语言 chip;末行若本身是围栏(` ``` `)= 折叠掉(视觉上不留空行)
        const isFence =
          number === end && end > start && /^\s*(```|~~~)/.test(value)
        const cls = number === start ? 'codeLang' : isFence ? 'codeEnd' : 'code'
        add(LINE, lines.start(number), lines.start(number), { cls })
      }
      for (const child of childrenOf(node)) {
        if (child.name === 'CodeMark' && !revealLine(child.from)) add(HIDE, child.from, child.to)
      }
      return
    } else if (name === 'Table') {
      const start = lines.lineOf(node.from)
      const end = lines.lineOf(node.to)
      for (let number = start; number <= end; number += 1) {
        const value = lines.text(number)
        const cls = /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(value)
          ? 'tableDelim'
          : number === start
            ? 'tableHead'
            : 'tableRow'
        add(LINE, lines.start(number), lines.start(number), { cls })
      }
      return
    }

    // 行内标记:加粗/斜体/行内码/删除线
    const inline = INLINE[name]
    if (inline !== undefined) {
      add(MARK, node.from, node.to, { cls: inline })
      if (!cursorInRange(activeSelection, node.from, node.to)) {
        for (const child of childrenOf(node)) {
          if (child.name === 'EmphasisMark' || child.name === 'CodeMark' || child.name === 'StrikethroughMark') {
            add(HIDE, child.from, child.to)
          }
        }
      }
      for (const child of childrenOf(node)) walk(child)
      return
    }

    // 高亮 `==…==`(需要 parseInline 扩展;没有该节点时这里自然不会触发)
    if (name === 'Highlight') {
      add(MARK, node.from, node.to, { cls: 'highlight' })
      if (!cursorInRange(activeSelection, node.from, node.to)) {
        for (const child of childrenOf(node)) {
          if (child.name === 'HighlightMark') add(HIDE, child.from, child.to)
        }
      }
      return
    }

    // 双链 `[[标题]]`
    if (name === 'WikiLink') {
      const inner = childrenOf(node).find((child) => child.name === 'WikiLinkTarget')
      const target = inner === undefined ? raw.replace(/^\[\[|\]\]$/g, '') : text.slice(inner.from, inner.to)
      add(MARK, node.from + 2, node.to - 2, { cls: knownTitles.has(target.trim()) ? 'wiki' : 'wikiNew' })
      if (!cursorInRange(activeSelection, node.from, node.to)) {
        add(HIDE, node.from, node.from + 2)
        add(HIDE, node.to - 2, node.to)
      }
      return
    }

    // 链接:文字着色;非还原态隐藏标记与地址
    if (name === 'Link') {
      add(MARK, node.from, node.to, { cls: 'link' })
      if (!cursorInRange(activeSelection, node.from, node.to)) {
        for (const child of childrenOf(node)) {
          if (child.name === 'LinkMark' || child.name === 'URL') add(HIDE, child.from, child.to)
        }
      }
      return
    }

    // 图片:行内 widget(单行,不跨行替换 —— CM6 不允许插件跨行替换)
    if (name === 'Image') {
      const parsed = parseImage(raw)
      if (parsed !== null) {
        if (cursorInRange(activeSelection, node.from, node.to)) add(MARK, node.from, node.to, { cls: 'link' })
        else add(WIDGET, node.from, node.to, { widget: 'image', data: parsed })
      }
      return
    }

    // 任务框
    if (name === 'TaskMarker') {
      if (cursorInRange(activeSelection, node.from, node.to)) return
      add(WIDGET, node.from, node.to, { widget: 'task', data: { checked: /\[[xX]\]/.test(raw) } })
      return
    }

    // 列表符号:无序 → `•`;任务项 → 连符号一起隐藏;有序 → 保留数字
    if (name === 'ListMark') {
      const mark = raw.trim()
      if (!/^[-*+]$/.test(mark)) return
      const lineText = lines.text(lines.lineOf(node.from))
      if (revealLine(node.from)) return
      if (/^\s*[-*+]\s+\[[ xX]\]/.test(lineText)) add(HIDE, node.from, node.to)
      else add(WIDGET, node.from, node.to, { widget: 'bullet' })
      return
    }

    // 引用符号 `>`(标题的 `#` 在下面统一处理)
    if (name === 'QuoteMark') {
      if (!revealLine(node.from)) add(HIDE, node.from, node.to)
      return
    }
    if (name === 'HeaderMark') {
      if (!revealLine(node.from)) add(HIDE, node.from, node.to)
      return
    }

    for (const child of childrenOf(node)) walk(child)
  }

  walk(tree.topNode)

  out.sort((left, right) => left.from - right.from || left.to - right.to)
  return out
}
