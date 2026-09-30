/**
 * 装饰绑定层:把**纯决策层**(`lib/markdown-render.js`)的描述翻译成 CM6 装饰。
 *
 * 这一层只做三件事:语义树 → 描述(决策层负责)、描述 → Decoration(这里)、
 * 以及把 widget 的点击行为接到源码上。所有"该藏还是该露"的判断都在决策层,
 * 有 14 条单测兜着;这里不再有第二套规则。
 *
 * 约束提醒:CM6 **不允许 ViewPlugin 提供跨行替换**装饰,所以这里只做
 * 行级/行内替换;块级 widget(表格 = 真 `<table>`)必须等 StateField 化之后再说。
 */

import { EditorState, RangeSet, type Extension } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'

import { HIDE, LINE, MARK, WIDGET, decideDecorations } from '../../../lib/markdown-render.js'
import temml from 'temml'

import { isSourceMode } from './mode'
import { resolveImageUrl } from './setup'

/** 行装饰类名映射(与 setup.ts 的 theme 对应)。 */
const LINE_CLASS: Record<string, string> = {
  h1: 'dsh-cm-h1',
  h2: 'dsh-cm-h2',
  h3: 'dsh-cm-h3',
  h4: 'dsh-cm-h4',
  h5: 'dsh-cm-h5',
  h6: 'dsh-cm-h6',
  quote: 'dsh-cm-quote',
  rule: 'dsh-cm-rule',
  code: 'dsh-cm-code-line',
  codeLang: 'dsh-cm-code-lang',
  codeEnd: 'dsh-cm-code-end',
  frontmatter: 'dsh-cm-frontmatter',
  tableHead: 'dsh-cm-table-head',
  tableRow: 'dsh-cm-table-row',
  tableDelim: 'dsh-cm-table-delim',
}

/** 行内装饰类名映射。 */
const MARK_CLASS: Record<string, string> = {
  strong: 'dsh-cm-strong',
  em: 'dsh-cm-em',
  code: 'dsh-cm-code',
  strike: 'dsh-cm-strike',
  highlight: 'dsh-cm-highlight',
  link: 'dsh-cm-link',
  wiki: 'dsh-cm-wiki',
  wikiNew: 'dsh-cm-wiki-new',
}

/** 无序列表的项目符号。 */
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

/** 任务列表复选框(点一下改源码)。 */
class TaskWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super()
  }

  eq(other: TaskWidget): boolean {
    return other.checked === this.checked && other.from === this.from
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

/** 行内图片(widget 只出现一次,点击即还原成源码)。 */
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
    caption.textContent = this.alt
    wrap.append(img, caption)
    return wrap
  }

  ignoreEvent(): boolean {
    return false
  }
}

/** 选区(标准化成 from <= to)。 */
function selectionRanges(state: EditorState): Array<{ from: number; to: number }> {
  return state.selection.ranges.map((range) => ({
    from: Math.min(range.from, range.to),
    to: Math.max(range.from, range.to),
  }))
}

/** 构建装饰集(决策层给描述,这里只翻译)。 */
export function decorateFromTree(
  view: EditorView,
  documentPath: string | null,
  getKnownTitles?: () => Set<string>,
): DecorationSet {
  const state = view.state
  // 源码模式:一个装饰都不加(看到的就是磁盘上的纯 markdown)
  if (isSourceMode()) return Decoration.none
  // 全量解析(带 timeout 兜底:解析不出来就当没装饰,绝不阻塞输入)
  const tree = ensureSyntaxTree(state, state.doc.length, 60)
  if (tree === null) return Decoration.none
  const text = state.doc.toString()
  const descriptions = decideDecorations({
    tree,
    text,
    selection: selectionRanges(state),
    knownTitles: getKnownTitles?.() ?? new Set<string>(),
    // Typora 式:光标进入时**行内标记与公式**展开成源码;表格/代码块/图片这类块级
    // 结构由 StateField 的 widget 兜住,永远保持渲染(不是所有都展开,也不是都不展开)
    reveal: true,
  })
  const ranges = []
  for (const description of descriptions) {
    const from = Math.max(0, Math.min(description.from, state.doc.length))
    const to = Math.max(from, Math.min(description.to, state.doc.length))
    if (description.kind === LINE) {
      ranges.push((Decoration.line({ class: LINE_CLASS[description.cls ?? ''] ?? 'dsh-cm-dim' }) as Decoration).range(from))
      continue
    }
    if (description.kind === HIDE) {
      if (to > from) ranges.push(Decoration.replace({}).range(from, to))
      continue
    }
    if (description.kind === MARK) {
      ranges.push(Decoration.mark({ class: MARK_CLASS[description.cls ?? ''] ?? 'dsh-cm-dim' }).range(from, to))
      continue
    }
    if (description.kind === WIDGET) {
      if (description.widget === 'bullet') {
        ranges.push(Decoration.replace({ widget: new BulletWidget() }).range(from, to))
      } else if (description.widget === 'task') {
        const checked = description.data?.checked === true
        ranges.push(Decoration.replace({ widget: new TaskWidget(checked, from, to) }).range(from, to))
      } else if (description.widget === 'math') {
        ranges.push(Decoration.replace({ widget: new MathWidget(String(description.data?.tex ?? '')) }).range(from, to))
      } else if (description.widget === 'image') {
        const destination = String(description.data?.destination ?? '')
        const url = resolveImageUrl(documentPath, destination)
        if (url !== undefined) {
          ranges.push(Decoration.replace({ widget: new ImageWidget(url, String(description.data?.alt ?? '')) }).range(from, to))
        }
      }
    }
  }
  return RangeSet.of(ranges, true)
}

/** ViewPlugin 包装。 */
export function treeDecorations(documentPath: string | null, getKnownTitles?: () => Set<string>): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = decorateFromTree(view, documentPath, getKnownTitles)
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = decorateFromTree(update.view, documentPath, getKnownTitles)
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  )
}


/**
 * 公式 widget:Temml 把 TeX 渲染成 **MathML**(浏览器原生渲染,不需要外部字体 —— 这也是
 * 这里选 Temml 而不是 KaTeX 的原因:KaTeX 依赖自带字体文件,插件里没法可靠提供)。
 */
class MathWidget extends WidgetType {
  constructor(readonly tex: string) {
    super()
  }

  eq(other: MathWidget): boolean {
    return other.tex === this.tex
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'dsh-cm-math'
    try {
      span.innerHTML = temml.renderToString(this.tex, { throwOnError: false })
    } catch {
      span.textContent = this.tex
    }
    return span
  }

  ignoreEvent(): boolean {
    return false
  }
}
