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
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { tags as tag } from '@lezer/highlight'

/** 行内隐藏/标记装饰。 */
const markStrong = Decoration.mark({ class: 'dsh-cm-strong' })
const markEm = Decoration.mark({ class: 'dsh-cm-em' })
const markCode = Decoration.mark({ class: 'dsh-cm-code' })
const markStrike = Decoration.mark({ class: 'dsh-cm-strike' })
const markHighlight = Decoration.mark({ class: 'dsh-cm-highlight' })
const markLink = Decoration.mark({ class: 'dsh-cm-link' })
const markUrl = Decoration.mark({ class: 'dsh-cm-url' })
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

/** 隐藏标记的子节点名。 */
const MARKER_NODES = new Set(['EmphasisMark', 'CodeMark', 'StrikethroughMark', 'HeaderMark', 'QuoteMark', 'ListMark'])

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
function buildDecorations(view: EditorView, documentPath: string | null): DecorationSet {
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
          add(line.from, line.from, lineDecorations.code)
          codeRanges.push({ from: node.from, to: node.to })
          return
        }

        // 行内:加粗/斜体/行内码/删除线
        const mark = INLINE_MARKS[name]
        if (mark !== undefined) {
          add(node.from, node.to, mark)
          if (name === 'InlineCode') codeRanges.push({ from: node.from, to: node.to })
          // 标记符号:非活动行隐藏
          if (!onActiveLine) {
            for (const child of node.node.children) {
              if (MARKER_NODES.has(child.name)) add(child.from, child.to, hide)
            }
          }
          return
        }

        // 标题的 `#`:非活动行隐藏
        if (HEADING_LINES[name] !== undefined && !onActiveLine) {
          for (const child of node.node.children) {
            if (child.name === 'HeaderMark') add(child.from, child.to, hide)
          }
          return
        }

        // 链接:隐藏 URL 部分(保留文字)
        if (name === 'Link') {
          add(node.from, node.to, markLink)
          if (!onActiveLine) {
            for (const child of node.node.children) {
              if (child.name === 'URL') add(child.from, child.to, hide)
            }
          }
          return
        }
        if (name === 'URL' && !onActiveLine) {
          // 裸 URL 仍显示,只弱化
          add(node.from, node.to, markUrl)
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

  // `==高亮==` 的正则补充(跳过代码区)
  for (const { from, to } of view.visibleRanges) {
    const text = state.doc.sliceString(from, to)
    const re = /==([^=\n]{1,400})==/g
    let match: RegExpExecArray | null
    while ((match = re.exec(text)) !== null) {
      const start = from + match.index
      const end = start + match[0].length
      if (codeRanges.some((range) => start < range.to && end > range.from)) continue
      const line = state.doc.lineAt(start)
      const onActiveLine = keepSource.has(line.number)
      inlineHighlights.push({ from: start + 2, to: end - 2 })
      if (!onActiveLine) {
        inlineHighlights.push({ from: start, to: start + 2 }, { from: end - 2, to: end })
      }
    }
  }
  for (const range of inlineHighlights) {
    const isMarker = range.to - range.from === 2
    add(range.from, range.to, isMarker ? hide : markHighlight)
  }

  return RangeSet.of(
    list.map((item) => item.deco.range(item.from, item.to)),
    true,
  )
}

/** 装饰插件。 */
function livePreview(documentPath: string | null): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, documentPath)
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = buildDecorations(update.view, documentPath)
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
    padding: '10px 14px 40vh',
  },
  '.cm-content': { caretColor: 'var(--dsw-alias-brand-primary)', maxWidth: '860px' },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor,.cm-dropCursor': { borderLeftColor: 'var(--dsw-alias-brand-primary)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--dsw-alias-bg-layer-2)',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-gutters': { display: 'none' },
  '.cm-dsh-h1': { fontSize: '1.6em', fontWeight: '700', lineHeight: '1.4' },
  '.cm-dsh-h2': { fontSize: '1.35em', fontWeight: '700', lineHeight: '1.4' },
  '.cm-dsh-h3': { fontSize: '1.18em', fontWeight: '650', lineHeight: '1.45' },
  '.cm-dsh-h4': { fontSize: '1.05em', fontWeight: '650' },
  '.cm-dsh-quote': {
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
  '.dsh-cm-url': { color: 'var(--dsw-alias-label-secondary)' },
  '.cm-dsh-rule': { borderTop: '1px solid var(--dsw-alias-border-l1)' },
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
}

/** 创建编辑器。 */
export function createEditor(options: {
  parent: HTMLElement
  doc: string
  documentPath: string | null
  onChange: () => void
  onSave: () => void
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
      markdown({ base: markdownLanguage, addKeymap: false }),
      syntaxHighlighting(highlight),
      livePreview(options.documentPath),
      theme,
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => (options.onSave(), true) },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) options.onChange()
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
  }
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
