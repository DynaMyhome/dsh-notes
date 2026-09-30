/**
 * 块级装饰:把 markdown 表格渲染成**真 `<table>`**,并支持单元格交互。
 *
 * 为什么必须放这里(StateField)而不是 ViewPlugin:
 * CM6 明确禁止**插件**提供跨行替换 —— "Decorations that replace line breaks may not be
 * specified via plugins"(我实测撞过,报错就是这个)。跨行块级装饰必须由 StateField 提供,
 * 且要用 `Decoration.replace({ block: true })`。
 *
 * 表格模型解析(`parseTable`)是纯函数,带单测(见 test/table.test.mjs)。
 */

import { EditorState, RangeSet, StateField, type Extension } from '@codemirror/state'
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'

import { isSourceMode } from './mode'
import { jsxLanguage, tsxLanguage, javascriptLanguage, typescriptLanguage } from '@codemirror/lang-javascript'
import { jsonLanguage } from '@codemirror/lang-json'
import { pythonLanguage } from '@codemirror/lang-python'
import { highlightTree, tagHighlighter, tags as tokenTags } from '@lezer/highlight'

/** 一个单元格:文本 + 它在**文档中的绝对范围**。 */
export interface TableCell {
  text: string
  from: number
  to: number
}

/** 表格模型。 */
export interface TableModel {
  header: TableCell[]
  rows: TableCell[][]
}

/** `|---|:--|` 这种分隔行。 */
export function isDelimiterRow(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line)
}

/** 把一行的 `|a|b|` 切成单元格文本。 */
function splitCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

/**
 * 解析表格源码(相对偏移 + `base` = 表格在文档里的起点)。
 * @param source - 表格文本(不含前后空行)。
 * @param base - 该文本在文档中的起始位置。
 */
export function parseTable(source: string, base: number): TableModel {
  const header: TableCell[] = []
  const rows: TableCell[][] = []
  let offset = 0
  let seenHeader = false
  for (const line of source.split(/\r?\n/)) {
    const lineStart = base + offset
    offset += line.length + 1 // +1 = 换行
    if (line.trim() === '') continue
    if (isDelimiterRow(line)) continue
    // 逐个单元格算出绝对范围:按 `|` 切,并把相对位置加回 base
    const cells: TableCell[] = []
    let cursor = 0
    const parts = line.split('|')
    for (const part of parts) {
      const partStart = cursor
      cursor += part.length + 1
      if (part.trim() === '' && (partStart === 0 || partStart + part.length >= line.length)) continue
      cells.push({
        text: part.trim(),
        from: lineStart + partStart + (line[partStart] === ' ' ? 1 : 0),
        to: lineStart + partStart + part.length,
      })
    }
    if (cells.length === 0) continue
    if (!seenHeader) {
      header.push(...cells)
      seenHeader = true
    } else {
      rows.push(cells)
    }
  }
  return { header, rows }
}

/** 真表格 widget:点单元格把光标送进去(那一行进入活动态 → 自动显示源码)。 */
class TableWidget extends WidgetType {
  constructor(
    readonly model: TableModel,
    readonly from: number,
  ) {
    super()
  }

  eq(other: TableWidget): boolean {
    return other.from === this.from && JSON.stringify(other.model) === JSON.stringify(this.model)
  }

  toDOM(view: EditorView): HTMLElement {
    const table = document.createElement('table')
    table.className = 'dsh-cm-table'
    // 点单元格 = **就地编辑**(预览模式下表格不翻回源码):该格换成 input,
    // Enter/失焦提交、Esc 取消,提交后写回源码对应区间(靠 from/to 精确定位)。
    const editCell = (cell: TableCell) => (event: Event) => {
      event.preventDefault()
      const host = event.currentTarget as HTMLElement
      const input = document.createElement('input')
      input.className = 'dsh-cm-table-input'
      input.value = cell.text
      const commit = (save: boolean): void => {
        const value = input.value
        if (save && value !== cell.text) {
          // 有改动:dispatch 会让 StateField 重建 widget,DOM 自然还原
          view.dispatch({ changes: { from: cell.from, to: cell.to, insert: value } })
        } else {
          // 没改动(或取消):**手动把 input 换回文本**。不然连点几个单元格
          // 就会留下一排输入框(不 dispatch 就不会重建)—— 这是实测踩到的。
          host.replaceChildren(document.createTextNode(cell.text))
        }
        view.focus()
      }
      input.addEventListener('keydown', (keyEvent) => {
        if (keyEvent.key === 'Enter') {
          keyEvent.preventDefault()
          commit(true)
        } else if (keyEvent.key === 'Escape') {
          keyEvent.preventDefault()
          commit(false)
        }
      })
      input.addEventListener('blur', () => commit(true))
      host.replaceChildren(input)
      input.focus()
      input.select()
    }
    if (this.model.header.length > 0) {
      const head = document.createElement('thead')
      const tr = document.createElement('tr')
      for (const cell of this.model.header) {
        const th = document.createElement('th')
        th.textContent = cell.text
        th.addEventListener('mousedown', editCell(cell))
        tr.appendChild(th)
      }
      head.appendChild(tr)
      table.appendChild(head)
    }
    const body = document.createElement('tbody')
    for (const row of this.model.rows) {
      const tr = document.createElement('tr')
      for (const cell of row) {
        const td = document.createElement('td')
        td.textContent = cell.text
        td.addEventListener('mousedown', editCell(cell))
        tr.appendChild(td)
      }
      body.appendChild(tr)
    }
    table.appendChild(body)
    const wrap = document.createElement('div')
    wrap.className = 'dsh-cm-table-wrap'
    wrap.appendChild(table)
    return wrap
  }

  ignoreEvent(): boolean {
    return false
  }
}

/** 光标是否落在表格所在的行区间里(落进去就显示源码)。 */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    const start = Math.min(range.from, range.to)
    const end = Math.max(range.from, range.to)
    if (start <= to && end >= from) return true
  }
  return false
}

/** 构建所有块级表格装饰。 */
export function buildTableDecorations(state: EditorState): DecorationSet {
  // 源码模式:不加任何块级装饰
  if (isSourceMode()) return Decoration.none
  const tree = ensureSyntaxTree(state, state.doc.length, 60)
  if (tree === null) return Decoration.none
  const ranges = []
  tree.iterate({
    enter: (node) => {
      // 表格:渲染成真 <table>(预览模式**永不翻回源码**,单元格就地编辑,见 TableWidget)
      if (node.name === 'Table') {
        const source = state.doc.sliceString(node.from, node.to)
        const model = parseTable(source, node.from)
        if (model.header.length === 0) return
        ranges.push(Decoration.replace({ widget: new TableWidget(model, node.from), block: true }).range(node.from, node.to))
        return
      }
      // 代码围栏:渲染成卡片(顶栏 = 语言 + 复制按钮,正文 = 等宽代码)
      if (node.name === 'FencedCode') {
        const source = state.doc.sliceString(node.from, node.to)
        ranges.push(Decoration.replace({ widget: new CodeCardWidget(source, node.from), block: true }).range(node.from, node.to))
      }
    },
  })
  return RangeSet.of(ranges, true)
}

/**
 * 代码高亮:用 lezer 解析 + `highlightTree` 生成带类名的 span。
 *
 * 为什么不自己写正则:语法高亮本身就是"语法树 → 类名"的映射,lezer 已经有各语言文法,
 * 复用它可以避免"关键字认错、字符串里的关键字也上色"这类老问题。
 */
const CODE_HIGHLIGHTER = tagHighlighter([
  { tag: tokenTags.keyword, class: 'tok-keyword' },
  { tag: [tokenTags.name, tokenTags.deleted, tokenTags.character, tokenTags.propertyName, tokenTags.macroName], class: 'tok-name' },
  { tag: [tokenTags.function(tokenTags.variableName), tokenTags.labelName], class: 'tok-function' },
  { tag: [tokenTags.color, tokenTags.constant(tokenTags.name), tokenTags.standard(tokenTags.name)], class: 'tok-constant' },
  { tag: [tokenTags.definition(tokenTags.name), tokenTags.separator], class: 'tok-def' },
  { tag: [tokenTags.typeName, tokenTags.className, tokenTags.number, tokenTags.changed, tokenTags.annotation, tokenTags.modifier, tokenTags.self, tokenTags.namespace], class: 'tok-type' },
  { tag: [tokenTags.operator, tokenTags.operatorKeyword, tokenTags.url, tokenTags.escape, tokenTags.regexp, tokenTags.link, tokenTags.special(tokenTags.string)], class: 'tok-operator' },
  { tag: [tokenTags.meta, tokenTags.comment], class: 'tok-comment' },
  { tag: [tokenTags.atom, tokenTags.bool, tokenTags.special(tokenTags.variableName)], class: 'tok-atom' },
  { tag: [tokenTags.processingInstruction, tokenTags.string, tokenTags.inserted], class: 'tok-string' },
  { tag: tokenTags.invalid, class: 'tok-invalid' },
])

/** 语言别名 → lezer 文法(没装的语法就退回纯文本,不猜)。 */
const CODE_LANGUAGES: Record<string, { parser: { parse: (input: string) => unknown } }> = {
  js: javascriptLanguage as never,
  javascript: javascriptLanguage as never,
  mjs: javascriptLanguage as never,
  cjs: javascriptLanguage as never,
  jsx: jsxLanguage as never,
  ts: typescriptLanguage as never,
  typescript: typescriptLanguage as never,
  tsx: tsxLanguage as never,
  json: jsonLanguage as never,
  jsonc: jsonLanguage as never,
  py: pythonLanguage as never,
  python: pythonLanguage as never,
}

/** 把代码写进 `<code>`:有文法就上色,否则纯文本。 */
function paintCode(target: HTMLElement, code: string, language: string): void {
  const grammar = CODE_LANGUAGES[language.toLowerCase()]
  if (grammar === undefined) {
    target.textContent = code
    return
  }
  try {
    const tree = grammar.parser.parse(code) as Parameters<typeof highlightTree>[0]
    let cursor = 0
    highlightTree(tree, CODE_HIGHLIGHTER, (from, to, classes) => {
      if (from > cursor) target.appendChild(document.createTextNode(code.slice(cursor, from)))
      const span = document.createElement('span')
      span.className = classes
      span.textContent = code.slice(from, to)
      target.appendChild(span)
      cursor = to
    })
    if (cursor < code.length) target.appendChild(document.createTextNode(code.slice(cursor)))
  } catch {
    target.textContent = code
  }
}

/**
 * 代码块卡片:圆角 + 顶栏(语言名 / 复制按钮)+ 等宽正文。
 *
 * 说明:按语言**上色**需要各语言的解析器(未安装),所以正文先给等宽 + 主题底色;
 * 复制按钮走剪贴板,复制的是去掉围栏后的纯代码。
 */
class CodeCardWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
  ) {
    super()
  }

  /** 拆出语言与代码正文。 */
  private parts(): { language: string; code: string } {
    const lines = this.source.split(/\r?\n/)
    const first = lines[0] ?? ''
    const last = lines[lines.length - 1] ?? ''
    const language = /^\s*(?:```|~~~)\s*(\S*)/.exec(first)?.[1] ?? ''
    const body = /^\s*(?:```|~~~)/.test(last) ? lines.slice(1, -1) : lines.slice(1)
    return { language, code: body.join('\n') }
  }

  eq(other: CodeCardWidget): boolean {
    return other.source === this.source
  }

  toDOM(): HTMLElement {
    const { language, code } = this.parts()
    const card = document.createElement('div')
    card.className = 'dsh-cm-code-card'
    const bar = document.createElement('div')
    bar.className = 'dsh-cm-code-bar'
    const label = document.createElement('span')
    label.className = 'dsh-cm-code-lang-label'
    label.textContent = language === '' ? 'text' : language
    label.title = '点击修改语言'
    // 点语言名 → 就地改围栏首行(方便换语言,不用切源码模式)
    label.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const first = this.source.split('\n')[0] ?? ''
      const fence = /^\s*(```|~~~)/.exec(first)?.[1] ?? '```'
      const box = document.createElement('input')
      box.className = 'dsh-cm-code-lang-input'
      box.value = language
      const commit = (save: boolean): void => {
        const next = box.value.trim()
        if (save && next !== language) {
          view.dispatch({ changes: { from: this.from, to: this.from + first.length, insert: fence + next } })
        } else {
          bar.replaceChild(label, box)
        }
        view.focus()
      }
      box.addEventListener('keydown', (keyEvent) => {
        if (keyEvent.key === 'Enter') {
          keyEvent.preventDefault()
          commit(true)
        } else if (keyEvent.key === 'Escape') {
          keyEvent.preventDefault()
          commit(false)
        }
      })
      box.addEventListener('blur', () => commit(true))
      bar.replaceChild(box, label)
      box.focus()
      box.select()
    })
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'dsh-cm-code-copy'
    copy.textContent = '复制'
    copy.addEventListener('mousedown', (event) => {
      event.preventDefault()
      void navigator.clipboard?.writeText(code)
      copy.textContent = '已复制'
      window.setTimeout(() => {
        copy.textContent = '复制'
      }, 1200)
    })
    bar.append(label, copy)
    const pre = document.createElement('pre')
    pre.className = 'dsh-cm-code-body'
    const codeEl = document.createElement('code')
    paintCode(codeEl, code, language)
    pre.appendChild(codeEl)
    // 就地编辑:点正文 → 换成 textarea(提交后写回围栏内的正文区间)
    pre.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const box = document.createElement('textarea')
      box.className = 'dsh-cm-code-input'
      box.value = code
      // 行数贴合原代码 → 进入编辑时高度不变,下面的内容不会被顶走(踩过)
      box.rows = Math.max(1, code.split('\n').length)
      const lines = this.source.split('\n')
      const first = lines[0] ?? ''
      const last = lines[lines.length - 1] ?? ''
      const bodyFrom = this.from + first.length + 1
      const bodyTo = /^\s*(?:```|~~~)/.test(last) ? this.from + this.source.length - last.length - 1 : this.from + this.source.length
      let done = false
      const commit = (save: boolean): void => {
        if (done) return
        done = true
        if (save && box.value !== code) {
          view.dispatch({ changes: { from: bodyFrom, to: bodyTo, insert: box.value } })
        } else {
          pre.replaceChildren(codeEl)
        }
        view.focus()
      }
      box.addEventListener('keydown', (keyEvent) => {
        if (keyEvent.key === 'Escape' || (keyEvent.key === 'Enter' && (keyEvent.metaKey || keyEvent.ctrlKey))) {
          keyEvent.preventDefault()
          commit(keyEvent.key !== 'Escape')
        }
      })
      box.addEventListener('blur', () => commit(true))
      pre.replaceChildren(box)
      box.focus()
      box.setSelectionRange(box.value.length, box.value.length)
    })
    card.append(bar, pre)
    return card
  }

  ignoreEvent(): boolean {
    return false
  }
}

/** 导出成扩展(塞进编辑器 extensions 即可)。 */
export function tableBlocks(): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => buildTableDecorations(state),
    update: (value, transaction) => (transaction.docChanged || transaction.selection !== undefined ? buildTableDecorations(transaction.state) : value),
    provide: (field) => EditorView.decorations.from(field),
  })
}

/** 找到光标所在的表格节点。 */
function enclosingTable(state: EditorState, pos: number): { from: number; to: number } | null {
  let node = syntaxTree(state).resolveInner(pos, 1)
  while (node !== null) {
    if (node.name === 'Table') return { from: node.from, to: node.to }
    node = node.parent
  }
  return null
}

/** 当前光标在哪个单元格(行优先展平后的下标)。 */
function cellAt(model: TableModel, pos: number): number {
  const flat: TableCell[] = [...model.header, ...model.rows.flat()]
  for (let index = 0; index < flat.length; index += 1) {
    if (pos >= flat[index].from - 1 && pos <= flat[index].to + 1) return index
  }
  return flat.length > 0 ? flat.length - 1 : -1
}

/**
 * 表格里的 `Tab` / `Shift-Tab`:跳到下一个/上一个单元格;最后一个单元格再按 Tab 就**追加一行**。
 * @returns 是否消费了这次按键。
 */
export function tableTab(view: EditorView, backwards = false): boolean {
  const state = view.state
  const pos = state.selection.main.head
  const table = enclosingTable(state, pos)
  if (table === null) return false
  const model = parseTable(state.doc.sliceString(table.from, table.to), table.from)
  const flat = [...model.header, ...model.rows.flat()]
  if (flat.length === 0) return false
  const current = cellAt(model, pos)
  const next = backwards ? current - 1 : current + 1
  if (next >= 0 && next < flat.length) {
    view.dispatch({ selection: { anchor: Math.min(flat[next].from, state.doc.length) } })
    view.focus()
    return true
  }
  if (backwards) return true
  // 末格 Tab → 追加一行(列数与表头一致)
  const columns = model.header.length
  const template = `\n|${'  |'.repeat(columns)}`
  const insertAt = table.to
  view.dispatch({
    changes: { from: insertAt, insert: template },
    selection: { anchor: insertAt + 1 + (columns === 0 ? 0 : 1) },
  })
  view.focus()
  return true
}
