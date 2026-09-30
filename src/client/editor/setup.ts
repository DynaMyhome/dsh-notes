/**
 * CodeMirror 6 编辑器装配 —— 目标:接近 Typora 的「所见即所得」源码视图。
 *
 * 做法(不自己造编辑器,只加一层装饰):
 *   1. `markdown()` 语言 + 语法树;
 *   2. **隐藏标记符号**(`**`、`*`、`` ` ``、`==`、`~~`、`#`、链接 URL)——
 *      只在光标所在行显示源标记,其它行直接呈现效果(Typora 的核心手感);
 *   3. 行级装饰:标题字号、引用条、分隔线;
 *   4. widget:任务列表复选框(可点)、图片(本地相对路径解析成 `api/file?path=`);
 *   5. 主题走宿主 token(`--dsw-alias-*`),不写死颜色。
 *
 * 说明:这里只做「阅读态渲染 + 直接改源码」,不做富文本块模型 —— 笔记文件始终是纯 md。
 */

import {
  EditorState,
  RangeSet,
  type Extension,
  type Text,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  rectangularSelection,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import {
  deleteMarkupBackward,
  insertNewlineContinueMarkup,
  markdown,
  markdownKeymap,
  markdownLanguage,
} from '@codemirror/lang-markdown'
import { openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { tags as tag } from '@lezer/highlight'

import { moveSection as moveSectionText } from '../../../lib/section.js'
import { markdownSyntaxConfig } from '../../../lib/markdown-syntax.js'
import { decorateFromTree } from './decorate'
import { tableBlocks, tableTab } from './table'

/** 行内隐藏/标记装饰。 */
const markStrong = Decoration.mark({ class: 'dsh-cm-strong' })
const markEm = Decoration.mark({ class: 'dsh-cm-em' })
const markCode = Decoration.mark({ class: 'dsh-cm-code' })
const markStrike = Decoration.mark({ class: 'dsh-cm-strike' })
const markHighlight = Decoration.mark({ class: 'dsh-cm-highlight' })
const markLink = Decoration.mark({ class: 'dsh-cm-link' })
const markUrl = Decoration.mark({ class: 'dsh-cm-url' })
/** `[[双链]]`:已存在 / 还没建。 */
const markWiki = Decoration.mark({ class: 'dsh-cm-wiki' })
const markWikiNew = Decoration.mark({ class: 'dsh-cm-wiki-new' })
const hide = Decoration.replace({})

/** 行级装饰(标题/引用/分隔线)。 */
const lineDecorations: Record<string, Decoration> = {
  h1: Decoration.line({ class: 'dsh-cm-h1' }),
  h2: Decoration.line({ class: 'dsh-cm-h2' }),
  h3: Decoration.line({ class: 'dsh-cm-h3' }),
  h4: Decoration.line({ class: 'dsh-cm-h4' }),
  h5: Decoration.line({ class: 'dsh-cm-h5' }),
  h6: Decoration.line({ class: 'dsh-cm-h6' }),
  quote: Decoration.line({ class: 'dsh-cm-quote' }),
  rule: Decoration.line({ class: 'dsh-cm-rule' }),
  code: Decoration.line({ class: 'dsh-cm-code-line' }),
  /** 代码围栏的开头行:隐藏 ``` 之后只剩语言名,给它一个 chip 样式。 */
  codeLang: Decoration.line({ class: 'dsh-cm-code-lang' }),
  /** markdown 表格的分隔行 `|---|`。 */
  tableDelim: Decoration.line({ class: 'dsh-cm-table-delim' }),
  /** 表格表头行 / 数据行(块级 widget 需要 StateField,先做行级渲染)。 */
  tableHead: Decoration.line({ class: 'dsh-cm-table-head' }),
  tableRow: Decoration.line({ class: 'dsh-cm-table-row' }),
  frontmatter: Decoration.line({ class: 'dsh-cm-frontmatter' }),
}

/**
 * 文档开头的 YAML frontmatter 区间。
 *
 * 必须单独认出来:lezer 会把 `dsh-note-id: x` + 收尾 `---` 解析成 **SetextHeading2**,
 * 不处理的话笔记元数据会被渲染成一个二级标题(实测就是这样)。
 * @param doc - 文档。
 * @returns 区间与末行号;没有 frontmatter 时返回 null。
 */
function frontmatterRange(doc: Text): { to: number; lastLine: number } | null {
  if (doc.lines < 2) return null
  if (doc.line(1).text.trim() !== '---') return null
  const limit = Math.min(doc.lines, 60)
  for (let number = 2; number <= limit; number += 1) {
    const text = doc.line(number).text.trim()
    if (text === '---' || text === '...') return { to: doc.line(number).to, lastLine: number }
  }
  return null
}

/** 需要连同标记一起隐藏的节点(标记名 → 装饰)。 */
const INLINE_MARKS: Record<string, Decoration> = {
  StrongEmphasis: markStrong,
  Emphasis: markEm,
  InlineCode: markCode,
  Strikethrough: markStrike,
}

/** 隐藏标记的子节点名(非活动行隐藏;`ListMark` 例外,保留列表符号)。 */
const MARKER_NODES = new Set([
  'EmphasisMark',
  'CodeMark',
  'StrikethroughMark',
  'HeaderMark',
  'QuoteMark',
  'LinkMark',
  'ListMark',
  // 自定义行内语法(lib/markdown-syntax.js)的标记
  'HighlightMark',
  'WikiLinkMark',
])

/** 标题节点名 → 行装饰键。 */
const HEADING_LINES: Record<string, string> = {
  ATXHeading1: 'h1',
  ATXHeading2: 'h2',
  ATXHeading3: 'h3',
  ATXHeading4: 'h4',
  ATXHeading5: 'h5',
  ATXHeading6: 'h6',
  SetextHeading1: 'h1',
  SetextHeading2: 'h2',
}

/**
 * 解析图片地址:本地相对路径 → 宿主同源 `api/file?path=`。
 * @param documentPath - 当前笔记的绝对路径(用于解析相对路径)。
 * @param destination - md 里写的地址。
 * @returns 可用于 `<img src>` 的地址,或 undefined。
 */
/** 最近一次 mousedown 的位置(用于区分「点击」与「拖选」)。 */
let pressAt: { x: number; y: number } | null = null

export function resolveImageUrl(documentPath: string | null, destination: string): string | undefined {
  const raw = String(destination ?? '').trim()
  if (raw === '') return undefined
  if (/^https?:\/\//i.test(raw) || raw.startsWith('data:')) return raw
  const cleaned = raw.replace(/^<|>$/g, '').split(/[?#]/)[0]
  if (cleaned === '') return undefined
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(cleaned) || cleaned.startsWith('/')
  let absolute = cleaned.replace(/\\/g, '/')
  if (!isAbsolute) {
    if (documentPath === null) return undefined
    const dir = documentPath.replace(/\\/g, '/').replace(/\/[^/]*$/, '')
    absolute = `${dir}/${cleaned}`
    // 归一化 ./ 与 ../
    const parts: string[] = []
    for (const segment of absolute.split('/')) {
      if (segment === '.' || segment === '') continue
      if (segment === '..') parts.pop()
      else parts.push(segment)
    }
    absolute = `${absolute.startsWith('/') ? '/' : ''}${parts.join('/')}`
  }
  const query = absolute.replace(/^<|>$/g, '')
  return `api/file?path=${encodeURIComponent(query)}`
}

/** 无序列表的项目符号(`-`/`*`/`+` → `•`,和 Typora 一致)。 */
class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const dot = document.createElement('span')
    dot.className = 'dsh-cm-bullet'
    dot.textContent = '•'
    return dot
  }

  ignoreEvent(): boolean {
    return false
  }
}

/**
 * markdown 表格 → 真 `<table>`(保留给下一步:块级装饰必须走 StateField)。
 *
 * ⚠️ **暂时不要用 ViewPlugin 把它接上** —— 跨行替换会被 CM6 拒绝:
 * "Decorations that replace line breaks may not be specified via plugins"。
 * 搬进 StateField 后再启用(见 buildDecorations 里 Table 分支的说明)。
 */
class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
  ) {
    super()
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'dsh-cm-table-wrap'
    const rows = this.source
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .filter((line) => !/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line))
      .map((line) =>
        line
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim()),
      )
    if (rows.length === 0) return wrap
    const table = document.createElement('table')
    table.className = 'dsh-cm-table'
    const head = document.createElement('thead')
    const headRow = document.createElement('tr')
    for (const cell of rows[0]) {
      const th = document.createElement('th')
      th.textContent = cell
      headRow.appendChild(th)
    }
    head.appendChild(headRow)
    table.appendChild(head)
    const body = document.createElement('tbody')
    for (const row of rows.slice(1)) {
      const tr = document.createElement('tr')
      for (const cell of row) {
        const td = document.createElement('td')
        td.textContent = cell
        tr.appendChild(td)
      }
      body.appendChild(tr)
    }
    table.appendChild(body)
    wrap.appendChild(table)
    // 点表格 = 把光标送到表格源码开头(那一行进入活动态 → 自动显示源码)
    wrap.addEventListener('mousedown', (event) => {
      event.preventDefault()
      view.dispatch({ selection: { anchor: Math.min(this.from, view.state.doc.length) } })
      view.focus()
    })
    return wrap
  }

  ignoreEvent(): boolean {
    return false
  }
}

/** 行内图片 widget。 */
class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
  ) {
    super()
  }

  eq(other: ImageWidget): boolean {
    return other.url === this.url && other.alt === this.alt
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'dsh-cm-image'
    const img = document.createElement('img')
    img.src = this.url
    img.alt = this.alt
    img.loading = 'lazy'
    const caption = document.createElement('span')
    caption.className = 'dsh-cm-image-caption'
    caption.textContent = this.alt === '' ? '' : this.alt
    wrap.append(img, caption)
    return wrap
  }

  ignoreEvent(): boolean {
    return false
  }
}

/** 任务列表复选框 widget(点一下切换源码)。 */
class TaskWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super()
  }

  eq(other: TaskWidget): boolean {
    return other.checked === this.checked && other.from === this.from && other.to === this.to
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'dsh-cm-task'
    box.checked = this.checked
    box.addEventListener('mousedown', (event) => {
      event.preventDefault()
      view.dispatch({ changes: { from: this.from, to: this.to, insert: this.checked ? '[ ]' : '[x]' } })
    })
    return box
  }

  ignoreEvent(): boolean {
    return false
  }
}

/** 收集光标/选区所在行(这些行保留源码标记)。 */
function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>()
  for (const range of state.selection.ranges) {
    const from = state.doc.lineAt(range.from).number
    const to = state.doc.lineAt(range.to).number
    for (let line = from; line <= to; line += 1) lines.add(line)
  }
  return lines
}

/** 计算一次可见区的装饰集。 */
function buildDecorations(
  view: EditorView,
  documentPath: string | null,
  getKnownTitles?: () => Set<string>,
): DecorationSet {
  const state = view.state
  // 先收集、最后统一由 `RangeSet.of(..., true)` 排序:
  // 行装饰与同一位置的「标记替换」会落在**同一个 from**,用 RangeSetBuilder
  // 顺序追加会抛 "Ranges must be added sorted" —— 实测后果是整个装饰层静默消失
  // (h1Count=0,而且不报错)。
  const list: Array<{ from: number; to: number; deco: Decoration }> = []
  const add = (from: number, to: number, deco: Decoration): void => {
    list.push({ from, to, deco })
  }
  const keepSource = activeLines(state)
  const codeRanges: Array<{ from: number; to: number }> = []
  const inlineHighlights: Array<{ from: number; to: number }> = []
  const frontmatter = frontmatterRange(state.doc)

  if (frontmatter !== null) {
    for (let number = 1; number <= frontmatter.lastLine; number += 1) {
      const line = state.doc.line(number)
      add(line.from, line.from, lineDecorations.frontmatter)
    }
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name
        // frontmatter 区间内一律不装饰(否则元数据会被当成 Setext 标题/分隔线)
        if (frontmatter !== null && node.from < frontmatter.to) return
        const line = state.doc.lineAt(node.from)
        const onActiveLine = keepSource.has(line.number)

        // 列表符号:非活动行把 `-`/`*`/`+` 渲染成项目符号 `•`;
        // 任务项(`- [ ] x`)连符号一起换成复选框,不留 `-`;有序列表保留数字。
        if (!onActiveLine && name === 'ListMark') {
          const mark = state.doc.sliceString(node.from, node.to).trim()
          const lineText = state.doc.lineAt(node.from).text
          if (/^[-*+]$/.test(mark)) {
            if (/^\s*[-*+]\s+\[[ xX]\]/.test(lineText)) add(node.from, node.to, hide)
            else add(node.from, node.to, Decoration.replace({ widget: new BulletWidget() }))
          }
          return
        }

        // 标记符号:非活动行隐藏(Typora 的核心手感)。
        //
        // 关键事实:本环境里 **`SyntaxNode.children` 恒为 null**(实测:Document 也是 null);
        // lezer 只通过 `firstChild`/`nextSibling` 暴露子节点。所以"遍历 children 找标记"
        // 的写法永远找不到东西 —— 这也是「装饰都在、只有 `**`/`#`/`` ` `` 不消失」的原因。
        // 正确做法:按节点名在 enter 里逐个处理(标记节点会作为独立节点被访问)。
        // `ListMark`(`- `)保留:列表符号本身是有用信息。
        if (!onActiveLine && MARKER_NODES.has(name)) {
          if (name !== 'ListMark') add(node.from, node.to, hide)
          return
        }

        // 行级:标题 / 引用 / 分隔线
        const lineKey = HEADING_LINES[name]
        if (lineKey !== undefined) {
          add(line.from, line.from, lineDecorations[lineKey])
        } else if (name === 'Blockquote') {
          add(line.from, line.from, lineDecorations.quote)
        } else if (name === 'HorizontalRule') {
          add(line.from, line.from, lineDecorations.rule)
          return
        } else if (name === 'FencedCode' || name === 'CodeBlock') {
          // 整个代码块**每一行**都要代码样式 —— 之前只给 node.from 那一行加,
          // 结果是围栏首行有底色、正文没有(用户截图里那个"js 一条灰底")。
          const first = state.doc.lineAt(node.from).number
          const last = state.doc.lineAt(Math.max(node.from, node.to - 1)).number
          for (let number = first; number <= last; number += 1) {
            const item = state.doc.line(number)
            add(item.from, item.from, number === first ? lineDecorations.codeLang : lineDecorations.code)
          }
          codeRanges.push({ from: node.from, to: node.to })
          return
        }

        // 行内:加粗/斜体/行内码/删除线
        const mark = INLINE_MARKS[name]
        if (mark !== undefined) {
          add(node.from, node.to, mark)
          if (name === 'InlineCode') codeRanges.push({ from: node.from, to: node.to })
          return
        }

        // 高亮 `==…==`:真语法节点(见 lib/markdown-syntax.js),不再用正则二次扫描。
        // 两侧的 `==` 由下面的 MARKER_NODES 通用规则(HighlightMark)在非活动行隐藏。
        if (name === 'Highlight') {
          add(node.from, node.to, markHighlight)
          return
        }

        // 双链 `[[标题]]`:同上;命中已存在标题 = 实色,否则虚线
        if (name === 'WikiLink') {
          const inner = state.doc.sliceString(node.from + 2, node.to - 2)
          const target = (inner.split('|')[0] ?? '').trim()
          const known = getKnownTitles?.() ?? new Set<string>()
          add(node.from + 2, node.to - 2, known.has(target) ? markWiki : markWikiNew)
          if (!onActiveLine) {
            add(node.from, node.from + 2, hide)
            add(node.to - 2, node.to, hide)
          }
          return
        }

        // 链接:文字着色;链接里的 URL 在非活动行隐藏(见下面 URL 分支)
        if (name === 'Link') {
          add(node.from, node.to, markLink)
          return
        }
        if (name === 'URL') {
          const parent = node.node.parent?.name
          if (!onActiveLine && (parent === 'Link' || parent === 'Image')) {
            add(node.from, node.to, hide)
            return
          }
          // 裸 URL 仍显示,只弱化
          add(node.from, node.to, markUrl)
          return
        }

        // 表格:**只做行级渲染**。
        //
        // 这里踩过一个 CM6 硬约束:"Decorations that replace line breaks may not be
        // specified via plugins" —— 用 ViewPlugin 提供**跨行替换**(整块换成 <table>)
        // 会直接报错。跨行/块级替换必须来自 StateField,所以表格的 widget 化要和
        // 装饰层一起搬进 StateField(见本文件顶部说明),在那之前先给每行上样式:
        // 表头加粗、分隔行弱化,读起来仍是表格。
        if (name === 'Table') {
          const startLine = state.doc.lineAt(node.from).number
          const endLine = state.doc.lineAt(node.to).number
          for (let number = startLine; number <= endLine; number += 1) {
            const item = state.doc.line(number)
            if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(item.text)) add(item.from, item.from, lineDecorations.tableDelim)
            else add(item.from, item.from, number === startLine ? lineDecorations.tableHead : lineDecorations.tableRow)
          }
          return
        }

        // 图片:整段替换为图片(仅非活动行,便于改路径)
        if (name === 'Image') {
          const raw = state.doc.sliceString(node.from, node.to)
          const match = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(raw)
          const url = match === null ? undefined : resolveImageUrl(documentPath, match[2])
          if (url !== undefined && !onActiveLine) {
            add(node.from, node.to, Decoration.replace({ widget: new ImageWidget(url, match?.[1] ?? '') }))
          } else if (url !== undefined) {
            add(node.from, node.to, markLink)
          }
          return
        }

        // 任务框
        if (name === 'TaskMarker') {
          const raw = state.doc.sliceString(node.from, node.to)
          add(
            node.from,
            node.to,
            Decoration.replace({ widget: new TaskWidget(/\[[xX]\]/.test(raw), node.from, node.to) }),
          )
          return
        }

        // `==高亮==`:lezer markdown 不认这个语法,单独用区间收集
        if (name === 'InlineCode') return
      },
    })
  }

  return RangeSet.of(
    list.map((item) => item.deco.range(item.from, item.to)),
    true,
  )
}

/**
 * 安全的装饰构建:装饰层出错不能把整个编辑器带崩,也不能只留一句
 * `CodeMirror plugin crashed: {}`(CM6 会吞掉错误对象)。
 */
function safeBuild(
  view: EditorView,
  documentPath: string | null,
  getKnownTitles?: () => Set<string>,
): DecorationSet {
  try {
    // 装饰决策已全部交给纯决策层(lib/markdown-render.js + editor/decorate.ts):
    // 保证"测试里验证过的行为"就是"编辑器里的行为",这里不再有自己的规则。
    return decorateFromTree(view, documentPath, getKnownTitles)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[dsh-notes] 新装饰层失败,回退旧构建器:', error)
    try {
      return buildDecorations(view, documentPath, getKnownTitles)
    } catch (inner) {
      // eslint-disable-next-line no-console
      console.error('[dsh-notes] 旧装饰层也失败,退化为纯源码视图:', inner)
      return Decoration.none
    }
  }
}

/** 在当前选区插入图片片段,并**选中占位路径**便于直接替换。 */
/**
 * 在空行敲 ``` / ```lang 后回车:自动补上**收尾围栏**,光标停在中间 —— Typora/Obsidian 手感。
 * @returns 是否消费了这次回车。
 */
export function insertFence(view: EditorView): boolean {
  const state = view.state
  const range = state.selection.main
  if (!range.empty) return false
  const line = state.doc.lineAt(range.head)
  if (range.head !== line.to) return false
  const match = /^(\s*)(`{3,}|~{3,})(\S*)\s*$/.exec(line.text)
  if (match === null) return false
  // 只有"这一行就是围栏的**起始行**"才补收尾围栏。
  // 在代码块内部(包括收尾围栏那一行)回车必须是**普通换行** —— 否则在收尾围栏末尾
  // 回车会又补出一对围栏(用户实测:莫名其妙多了一个代码块)。
  let node: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(range.head, -1)
  while (node !== null) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
      if (state.doc.lineAt(node.from).number !== line.number) return false
      break
    }
    node = node.parent
  }
  const indent = match[1] ?? ''
  const fence = match[2] ?? '```'
  view.dispatch({
    changes: { from: line.to, insert: `\n\n${indent}${fence}` },
    selection: { anchor: line.to + 1 },
  })
  return true
}

export function insertImageSnippet(view: EditorView): void {
  const range = view.state.selection.main
  const snippet = '![](图片路径)'
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: snippet },
    selection: { anchor: range.from + 4, head: range.from + snippet.length - 1 },
  })
  view.focus()
}

/** 装饰插件。 */
function livePreview(documentPath: string | null, getKnownTitles?: () => Set<string>): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = safeBuild(view, documentPath, getKnownTitles)
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = safeBuild(update.view, documentPath, getKnownTitles)
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  )
}

/** 宿主 token 主题。 */
const theme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13.5px',
    color: 'var(--dsw-alias-label-primary)',
    backgroundColor: 'transparent',
  },
  '.cm-scroller': {
    fontFamily: 'var(--dsw-font, inherit)',
    lineHeight: '1.7',
    // 内边距必须放**内容区里面**:放在 scroller 上时,那片空白不属于 .cm-content,
    // 点击不会落光标、鼠标也不是文本光标(实测 Obsidian 是 I 形且点了落到文末)。
    padding: '0',
    cursor: 'text',
  },
  // min-height:100% 让内容区铺满编辑区 —— 点最后一行下方的空白也能落光标(Obsidian 手感)
  // min-height:100% + padding 都在内容区上:最后一行下方的空白也能落光标(Obsidian 手感)
  '.cm-content': { caretColor: 'var(--dsw-alias-brand-primary)', maxWidth: '860px', minHeight: '100%', padding: '10px 14px 40vh' },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor,.cm-dropCursor': { borderLeftColor: 'var(--dsw-alias-brand-primary)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--dsw-alias-bg-layer-2)',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-gutters': { display: 'none' },
  '.dsh-cm-h1': { fontSize: '1.9em', fontWeight: '700', lineHeight: '1.35', boxShadow: 'inset 0 -1px 0 0 var(--dsw-alias-border-l1)' },
  '.dsh-cm-h2': { fontSize: '1.5em', fontWeight: '680', lineHeight: '1.4', boxShadow: 'inset 0 -1px 0 0 var(--dsw-alias-border-l1)' },
  '.dsh-cm-h3': { fontSize: '1.28em', fontWeight: '650', lineHeight: '1.45' },
  '.dsh-cm-h4': { fontSize: '1.12em', fontWeight: '650', color: 'var(--dsw-alias-label-primary)' },
  '.dsh-cm-h5': { fontSize: '1em', fontWeight: '600', letterSpacing: '.01em', color: 'var(--dsw-alias-label-secondary)' },
  '.dsh-cm-h6': { fontSize: '.95em', fontWeight: '600', letterSpacing: '.02em', color: 'var(--dsw-alias-label-secondary)' },
  '.dsh-cm-quote': {
    borderLeft: '2px solid var(--dsw-alias-border-l2)',
    paddingLeft: '10px',
    color: 'var(--dsw-alias-label-secondary)',
  },
  '.dsh-cm-strong': { fontWeight: '700' },
  '.dsh-cm-em': { fontStyle: 'italic' },
  '.dsh-cm-code': {
    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
    fontSize: '0.92em',
    background: 'var(--dsw-alias-bg-layer-2)',
    padding: '1px 4px',
    borderRadius: '4px',
  },
  '.dsh-cm-strike': { textDecoration: 'line-through', color: 'var(--dsw-alias-label-secondary)' },
  '.dsh-cm-highlight': {
    background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 28%, transparent)',
    borderRadius: '3px',
    padding: '1px 0',
  },
  '.dsh-cm-link': { color: 'var(--dsw-alias-brand-primary)', textDecoration: 'none' },
  '.dsh-cm-wiki': {
    color: 'var(--dsw-alias-brand-primary)',
    borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent)',
    cursor: 'pointer',
  },
  '.dsh-cm-wiki-new': {
    color: 'var(--dsw-alias-label-secondary)',
    borderBottom: '1px dashed var(--dsw-alias-border-l2)',
    cursor: 'pointer',
  },
  '.dsh-cm-url': { color: 'var(--dsw-alias-label-secondary)' },
  '.dsh-cm-rule': { borderTop: '1px solid var(--dsw-alias-border-l1)' },
  '.dsh-cm-frontmatter': {
    color: 'var(--dsw-alias-label-secondary)',
    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
    fontSize: '0.86em',
    background: 'var(--dsw-alias-bg-layer-1)',
  },
  '.dsh-cm-code-line': {
    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
    background: 'var(--dsw-alias-bg-layer-1)',
  },
  '.dsh-cm-code-lang': {
    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
    fontSize: '0.78em',
    letterSpacing: '.04em',
    textTransform: 'uppercase',
    color: 'var(--dsw-alias-label-secondary)',
    background: 'var(--dsw-alias-bg-layer-1)',
    borderTopLeftRadius: '6px',
    borderTopRightRadius: '6px',
  },
  '.dsh-cm-code-end': {
    // 收尾围栏行:折叠成一条细缝,视觉上不留空行
    height: '0',
    lineHeight: '0',
    overflow: 'hidden',
    background: 'var(--dsw-alias-bg-layer-1)',
    borderBottomLeftRadius: '6px',
    borderBottomRightRadius: '6px',
  },
  // 代码块卡片(块级 widget):圆角 + 顶栏(语言 / 复制)+ 等宽正文
  '.dsh-cm-code-card': {
    margin: '6px 0',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '8px',
    overflow: 'hidden',
    background: 'var(--dsw-alias-bg-layer-1)',
  },
  '.dsh-cm-code-bar': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '4px 10px',
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-2)',
  },
  '.dsh-cm-code-lang-label': {
    flex: '1 1 auto',
    fontSize: '11px',
    letterSpacing: '.04em',
    textTransform: 'uppercase',
    color: 'var(--dsw-alias-label-secondary)',
  },
  '.dsh-cm-code-copy': {
    appearance: 'none',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    font: 'inherit',
    fontSize: '11px',
    padding: '1px 8px',
    borderRadius: '5px',
    cursor: 'pointer',
  },
  '.dsh-cm-code-copy:hover': { color: 'var(--dsw-alias-label-primary)' },
  '.dsh-cm-code-body': {
    margin: '0',
    padding: '8px 12px',
    overflow: 'auto',
    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
    fontSize: '0.9em',
    lineHeight: '1.6',
  },
  // 代码高亮的 token 颜色。
  // 注意:这几个变量**必须是有定义的**(实测 --dsw-alias-label-success/warning/danger
  // 在本主题里是空的,写了等于没写,颜色会回落到继承值);brand-primary 在亮色主题里
  // 就是近黑色 #0f1115,所以关键字用 state-business-primary / onboarding-accent 这类真正的彩色 token。
  '.dsh-cm-code-body .tok-keyword': { color: 'var(--dsw-alias-onboarding-accent)' },
  '.dsh-cm-code-body .tok-string': { color: 'var(--dsw-alias-state-success-primary)' },
  '.dsh-cm-code-body .tok-number, .dsh-cm-code-body .tok-type, .dsh-cm-code-body .tok-constant': { color: 'var(--dsw-alias-state-business-primary)' },
  '.dsh-cm-code-body .tok-comment': { color: 'var(--dsw-alias-label-caption)', fontStyle: 'italic' },
  '.dsh-cm-code-body .tok-operator, .dsh-cm-code-body .tok-def, .dsh-cm-code-body .tok-separator': { color: 'var(--dsw-alias-label-secondary)' },
  '.dsh-cm-code-body .tok-atom': { color: 'var(--dsw-alias-onboarding-accent)' },
  '.dsh-cm-code-body .tok-invalid': { color: 'var(--dsw-alias-state-error-primary)' },
  '.dsh-cm-math': { padding: '0 1px' },
  '.dsh-cm-math math': { fontSize: '1.02em' },
  '.dsh-cm-code-input': {
    display: 'block',
    width: '100%',
    boxSizing: 'border-box',
    border: 'none',
    outline: 'none',
    resize: 'none',
    overflow: 'auto',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    lineHeight: 'inherit',
    padding: '0',
    margin: '0',
  },
  '.dsh-cm-code-lang-input': {
    flex: '1 1 auto',
    width: '7em',
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: '11px',
    letterSpacing: '.04em',
    textTransform: 'uppercase',
  },
  // 表格单元格就地编辑的输入框
  '.dsh-cm-table-input': {
    boxSizing: 'border-box',
    minWidth: '0',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '3px',
    padding: '0 3px',
    margin: '0',
    font: 'inherit',
    lineHeight: 'inherit',
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    verticalAlign: 'baseline',
    outline: 'none',
  },
  '.dsh-cm-table-delim': { color: 'var(--dsw-alias-label-secondary)', opacity: '.45' },
  '.dsh-cm-table-head': {
    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
    fontWeight: '600',
    background: 'var(--dsw-alias-bg-layer-2)',
  },
  '.dsh-cm-table-row': { fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)' },
  '.dsh-cm-bullet': { color: 'var(--dsw-alias-label-secondary)', paddingRight: '2px' },
  '.dsh-cm-table-wrap': { padding: '4px 0' },
  '.dsh-cm-table': {
    borderCollapse: 'collapse',
    fontSize: '0.95em',
    width: 'fit-content',
    maxWidth: '100%',
  },
  '.dsh-cm-table th, .dsh-cm-table td': {
    border: '1px solid var(--dsw-alias-border-l1)',
    padding: '3px 10px',
    textAlign: 'left',
    verticalAlign: 'top',
  },
  '.dsh-cm-table th': {
    fontWeight: '600',
    background: 'var(--dsw-alias-bg-layer-2)',
  },
  '.dsh-cm-task': { verticalAlign: 'middle', marginRight: '6px', accentColor: 'var(--dsw-alias-brand-primary)' },
  '.dsh-cm-image': { display: 'inline-flex', flexDirection: 'column', gap: '2px', verticalAlign: 'middle' },
  '.dsh-cm-image img': { maxWidth: '100%', maxHeight: '320px', borderRadius: '6px', display: 'block' },
  '.dsh-cm-image-caption': { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
})

/** 语法着色(代码块/行内 token)。 */
const highlight = HighlightStyle.define([
  { tag: tag.heading, fontWeight: '700' },
  { tag: tag.strong, fontWeight: '700' },
  { tag: tag.emphasis, fontStyle: 'italic' },
  { tag: tag.link, color: 'var(--dsw-alias-brand-primary)' },
  { tag: tag.monospace, fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)' },
  { tag: tag.comment, color: 'var(--dsw-alias-label-secondary)' },
  { tag: tag.keyword, color: 'var(--dsw-alias-brand-primary)' },
  { tag: tag.string, color: 'var(--dsw-alias-state-success-primary)' },
  { tag: tag.number, color: 'var(--dsw-alias-state-warn-primary)' },
])

/** 编辑器句柄。 */
export interface EditorHandle {
  view: EditorView
  setDoc: (text: string) => void
  focus: () => void
  destroy: () => void
  getDoc: () => string
  /** 把光标放到某一行并滚到可视区顶部(大纲跳转用)。 */
  scrollToLine: (line: number) => void
  /** 按大纲把某个章节搬到另一个标题前/后(纯文本级搬移,见 lib/section.js)。 */
  moveSection: (fromLine: number, toLine: number, mode: 'before' | 'after') => boolean
}

/** 创建编辑器。 */
export function createEditor(options: {
  parent: HTMLElement
  doc: string
  documentPath: string | null
  onChange: () => void
  onSave: () => void
  onSelection?: (line: number) => void
  /** 粘贴/拖入图片时回调(外壳负责上传到资产目录并插入链接)。 */
  onImageFile?: (file: File) => void
  /** 点击 `[[双链]]` 时回调(外壳决定打开还是新建)。 */
  onWikiLink?: (title: string) => void
  /** 当前工作区已知的笔记标题(双链能不能对上)。 */
  getKnownTitles?: () => Set<string>
}): EditorHandle {
  const state = EditorState.create({
    doc: options.doc,
    extensions: [
      history(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      EditorView.lineWrapping,
      // 自动配对 `*`/`_`/`[`/`(` 等;配合 markdown 的续写命令
      closeBrackets(),
      // `[[` 补全笔记名:光标前是 `[[xxx` 时就列出现有标题,选中补 `标题]]`
      autocompletion({
        override: [
          (context: CompletionContext): CompletionResult | null => {
            const before = context.matchBefore(/\[\[[^\]\n]{0,200}$/)
            if (before === null) return null
            const titles = Array.from(options.getKnownTitles?.() ?? [])
            if (titles.length === 0) return null
            return {
              from: before.from + 2,
              options: titles.map((title) => ({ label: title, apply: `${title}]]` })),
              validFor: /^[^\]\n]*$/,
            }
          },
        ],
        activateOnTyping: true,
      }),
      markdown({ base: markdownLanguage, addKeymap: false, extensions: [markdownSyntaxConfig()] }),
      syntaxHighlighting(highlight),
      search({ top: true }),
      livePreview(options.documentPath, options.getKnownTitles),
      // 块级装饰必须来自 StateField(CM6 禁止插件提供跨行替换):真表格 + 单元格交互
      tableBlocks(),
      // 点击落点校正:
      //   a) 内容区之外(下方空白/右侧留白)→ 光标落文末(Obsidian 手感);
      //   b) 内容区内 → 按行盒中点判定行:浏览器默认取最近的文字位置,行高 1.7 时
      //      指针在同一行里稍微下移就会跳到下一行(用户反馈很反逻辑)。
      // 只纠正点击(位移 <4px),拖选一律不拦,避免破坏选词/选段。
      EditorView.domEventHandlers({
        mousedown(event) {
          pressAt = { x: event.clientX, y: event.clientY }
          return false
        },
        mouseup(event, view) {
          const start = pressAt
          pressAt = null
          if (start === null) return false
          if (Math.abs(event.clientY - start.y) > 4 || Math.abs(event.clientX - start.x) > 4) return false
          const target = event.target as HTMLElement | null
          if (target === null) return false
          // widget(表格/代码卡片/图片/复选框/项目符号)有自己的交互,不拦
          if (target.closest('.dsh-cm-table, .dsh-cm-code-card, .dsh-cm-image, .dsh-cm-task, .dsh-cm-bullet') !== null) return false
          const content = view.contentDOM
          const contentRect = content.getBoundingClientRect()
          const outside =
            event.clientY > contentRect.bottom ||
            event.clientX > contentRect.right ||
            event.clientY < contentRect.top ||
            target.closest('.cm-content') === null
          if (outside) {
            view.dispatch({ selection: { anchor: view.state.doc.length } })
            view.focus()
            return true
          }
          // 用 elementFromPoint **精确命中指针所在的那一行**。
          // (早先是遍历所有行的矩形来找,代码块这种"行背景连成一片"的区域会选错行 ——
          //  实测点 `test、` 后面会被丢到块尾 `丢掉` 后面,怎么点都回不去。)
          const hitLine = (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)?.closest(
            '.cm-line',
          ) as HTMLElement | null
          if (hitLine === null) return false
          const rect = hitLine.getBoundingClientRect()
          // y 夹在这一行内部再解析位置:指针在这一行里就归这一行(修"下移一点就跳下一行")
          const y = Math.min(Math.max(event.clientY, rect.top + 2), rect.bottom - 2)
          const pos = view.posAtCoords({ x: event.clientX, y })
          if (pos === null) return false
          view.dispatch({ selection: { anchor: pos } })
          view.focus()
          return true
        },
      }),
      theme,
      // 图片:粘贴或拖入 → 交给外壳上传(见 NotesPane)
      EditorView.domEventHandlers({
        paste: (event) => {
          const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'))
          if (files.length === 0) return false
          event.preventDefault()
          for (const file of files) options.onImageFile?.(file)
          return true
        },
        drop: (event) => {
          const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith('image/'))
          if (files.length === 0) return false
          event.preventDefault()
          for (const file of files) options.onImageFile?.(file)
          return true
        },
        mousedown: (event, view) => {
          if (options.onWikiLink === undefined) return false
          const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
          if (position === null) return false
          const line = view.state.doc.lineAt(position)
          const offset = position - line.from
          const re = /\[\[([^\]\n|]{1,200})(\|[^\]\n]{0,200})?\]\]/g
          let match: RegExpExecArray | null
          while ((match = re.exec(line.text)) !== null) {
            if (offset >= match.index && offset <= match.index + match[0].length) {
              event.preventDefault()
              options.onWikiLink(match[1].trim())
              return true
            }
          }
          return false
        },
      }),
      keymap.of([
        // 保存 / 搜索
        { key: 'Mod-s', preventDefault: true, run: () => (options.onSave(), true) },
        { key: 'Mod-f', preventDefault: true, run: openSearchPanel },
        // markdown 续写:Enter 续列表/引用、空项退出;Backspace 删标记(官方实现)
        // 空行里的 ``` 回车 → 自动补收尾围栏(必须在 markdown 续行命令之前)
        { key: 'Enter', run: insertFence },
        { key: 'Enter', run: insertNewlineContinueMarkup },
        { key: 'Shift-Enter', run: insertNewlineContinueMarkup },
        { key: 'Backspace', run: deleteMarkupBackward },
        // 行内/行首快捷键:对齐 Typora / Obsidian 的习惯
        { key: 'Mod-b', preventDefault: true, run: (view) => (wrapSelection(view, '**'), true) },
        { key: 'Mod-i', preventDefault: true, run: (view) => (wrapSelection(view, '*'), true) },
        { key: 'Mod-e', preventDefault: true, run: (view) => (wrapSelection(view, '`'), true) },
        { key: 'Mod-Shift-h', preventDefault: true, run: (view) => (wrapSelection(view, '=='), true) },
        { key: 'Mod-1', preventDefault: true, run: (view) => (setHeading(view, 1), true) },
        { key: 'Mod-2', preventDefault: true, run: (view) => (setHeading(view, 2), true) },
        { key: 'Mod-3', preventDefault: true, run: (view) => (setHeading(view, 3), true) },
        { key: 'Mod-4', preventDefault: true, run: (view) => (setHeading(view, 4), true) },
        { key: 'Mod-5', preventDefault: true, run: (view) => (setHeading(view, 5), true) },
        { key: 'Mod-6', preventDefault: true, run: (view) => (setHeading(view, 6), true) },
        { key: 'Mod-0', preventDefault: true, run: (view) => (setHeading(view, 0), true) },
        // 表格内 Tab = 跳单元格(末格追加一行);不在表格里才走缩进
        { key: 'Tab', preventDefault: true, run: (view) => tableTab(view, false) },
        { key: 'Shift-Tab', preventDefault: true, run: (view) => tableTab(view, true) },
        { key: 'Tab', preventDefault: true, run: indentMore },
        { key: 'Shift-Tab', preventDefault: true, run: indentLess },
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...searchKeymap,
        ...markdownKeymap,
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) options.onChange()
        if (update.selectionSet && options.onSelection !== undefined) {
          options.onSelection(update.state.doc.lineAt(update.state.selection.main.head).number)
        }
      }),
    ],
  })
  const view = new EditorView({ state, parent: options.parent })
  return {
    view,
    setDoc: (text: string) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
    getDoc: () => view.state.doc.toString(),
    moveSection: (fromLine: number, toLine: number, mode: 'before' | 'after') => {
      const result = moveSectionText(view.state.doc.toString(), fromLine, toLine, mode)
      if (result === null) return false
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: result.text } })
      view.dispatch({
        selection: { anchor: view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, result.line))).from },
        effects: EditorView.scrollIntoView(view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, result.line))).from, {
          y: 'start',
          yMargin: 56,
        }),
      })
      view.focus()
      return true
    },
    scrollToLine: (line: number) => {
      const total = view.state.doc.lines
      const target = Math.max(1, Math.min(total, line))
      const position = view.state.doc.line(target).from
      view.dispatch({
        selection: { anchor: position },
        effects: EditorView.scrollIntoView(position, { y: 'start', yMargin: 56 }),
      })
      view.focus()
    },
  }
}

/** 把选中行设成 N 级标题(`0` = 取消标题);与 Typora 的 Ctrl+1..6 / Ctrl+0 一致。 */
export function setHeading(view: EditorView, level: number): void {
  const { state } = view
  const changes: Array<{ from: number; to: number; insert: string }> = []
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let number = first; number <= last; number += 1) {
      const line = state.doc.line(number)
      const stripped = line.text.replace(/^\s*#{1,6}\s+/, '')
      const prefix = level === 0 ? '' : `${'#'.repeat(Math.max(1, Math.min(6, level)))} `
      changes.push({ from: line.from, to: line.to, insert: prefix + stripped })
    }
  }
  view.dispatch({ changes })
  view.focus()
}

/** 在选区两侧包一层标记(`**粗体**` 之类)。 */
export function wrapSelection(view: EditorView, before: string, after = before): void {
  const changes = view.state.changeByRange((range) => ({
    changes: [
      { from: range.from, insert: before },
      { from: range.to, insert: after },
    ],
    range: EditorSelectionRange(range.from + before.length, range.to + before.length),
  }))
  view.dispatch(changes)
  view.focus()
}

/** 简化版选区构造(避免额外 import)。 */
function EditorSelectionRange(anchor: number, head: number): { anchor: number; head: number } {
  return { anchor, head } as never
}

/** 给当前行(或选中行)加前缀(`# `、`- `、`> ` 等);已有同样前缀则去掉。 */
export function toggleLinePrefix(view: EditorView, prefix: string): void {
  const { state } = view
  const lines: Array<{ from: number; text: string }> = []
  for (const range of state.selection.ranges) {
    const start = state.doc.lineAt(range.from).number
    const end = state.doc.lineAt(range.to).number
    for (let number = start; number <= end; number += 1) {
      const line = state.doc.line(number)
      lines.push({ from: line.from, text: line.text })
    }
  }
  const allHave = lines.every((line) => line.text.startsWith(prefix))
  const changes = lines.map((line) =>
    allHave
      ? { from: line.from, to: line.from + prefix.length, insert: '' }
      : { from: line.from, to: line.from, insert: prefix },
  )
  view.dispatch({ changes })
  view.focus()
}
