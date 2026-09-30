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
import { HighlightStyle, syntaxTree, ensureSyntaxTree, syntaxHighlighting } from '@codemirror/language'
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'

import { isSourceMode } from './mode'
import { isDelimiterRow, parseTable, type TableModel } from './table-model'
import { frontmatterEndOf } from './frontmatter'
import { jsxLanguage, tsxLanguage, javascript, javascriptLanguage, typescriptLanguage } from '@codemirror/lang-javascript'
import { json, jsonLanguage } from '@codemirror/lang-json'
import { python, pythonLanguage } from '@codemirror/lang-python'
import { highlightTree, tagHighlighter, tags as tokenTags } from '@lezer/highlight'
import temml from 'temml'

/** 一个单元格:文本 + 它在**文档中的绝对范围**。 */
/** 当前打开的单元格输入框(切换单元格时用来避免互相抢焦点)。 */
const openCellInputs = new Set<HTMLInputElement>()

/**
 * 块级公式 widget(独占整行的 `$$…$$`,含多行写法)。
 *
 * 为什么必须在这里(StateField):插件层只允许**行内**替换,`$$` 跨行会被 CM6 拒绝
 * ("Decorations that replace line breaks may not be specified via plugins")。用户实测
 * "`$$\na=1\n$$` 完全渲染不出来"就是因为这条路径以前根本没有。
 */
class BlockMathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly from: number,
  ) {
    super()
  }

  eq(other: BlockMathWidget): boolean {
    return other.tex === this.tex && other.from === this.from
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('div')
    box.className = 'dsh-cm-math-block'
    box.title = '点击展开源码'
    try {
      box.innerHTML = temml.renderToString(this.tex, { displayMode: true, throwOnError: false })
    } catch {
      box.textContent = this.tex
    }
    // 点公式 → 光标进入这一块 → 显示 `$$…$$` 源码(与其他块级对象一致)
    box.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      view.dispatch({ selection: { anchor: Math.min(this.from, view.state.doc.length) } })
      view.focus()
    })
    return box
  }

  ignoreEvent(): boolean {
    // 自己处理 mousedown,不让 CM6 再接管
    return true
  }
}

/**
 * frontmatter 折叠成的一行 chip(预览模式)。
 *
 * 文件里仍然保留 `dsh-note-id` 等键值(可恢复、Agent 也能读),只是界面干净;
 * 点一下把光标送进 frontmatter,按既有 reveal 规则展开成源码再改。
 */
class FrontmatterWidget extends WidgetType {
  constructor(readonly summary: string) {
    super()
  }

  eq(other: FrontmatterWidget): boolean {
    return other.summary === this.summary
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('div')
    box.className = 'dsh-cm-meta-chip'
    box.textContent = '⋯ 元数据'
    box.title = this.summary === '' ? '点击展开源码' : this.summary
    box.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true })
      view.focus()
    })
    return box
  }
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
      const hit = event.target as HTMLElement | null
      if (hit !== null && hit.closest('input, textarea') !== null) return
      event.preventDefault()
      const host = event.currentTarget as HTMLElement
      // 输入框**绝对定位铺满单元格**(样式见 theme 里的 .dsh-cm-table-input):
      // 它对布局零影响 —— 不撑列、不撑行、不把下方内容顶走,也不会把文字裁掉。
      // 单元格里原来那串文本**保留**(绝对定位元素不参与布局,列宽仍由文本决定),
      // 输入框自己带底色盖在上面;取消编辑时只要移除输入框即可还原。
      // 编辑时把单元格原来那串文本**变透明**:主题的 layer 色是半透明的,输入框的
      // background 挡不住下面的文字 → 打字时上下两层叠在一起(用户实测"重影")。
      // 文本仍在(列宽由它决定),只是不可见;结束编辑时还原。
      const previousColor = host.style.color
      host.style.color = 'transparent'
      const input = document.createElement('input')
      input.className = 'dsh-cm-table-input'
      input.size = 1
      input.value = cell.text
      // 提交只能发生一次:Esc 取消时我们会 `input.remove()` + `view.focus()`,而
      // `view.focus()` 会让这个输入框 **blur**,blur 处理器再提交一次 —— 结果"取消"
      // 反而把值写进了文档(实测)。用 done 标记把后续的 blur 挡掉。
      let done = false
      const commit = (save: boolean): void => {
        if (done) return
        done = true
        const value = input.value
        openCellInputs.delete(input)
        host.style.color = previousColor
        if (save && value !== cell.text) {
          // 有改动:dispatch 会让 StateField 重建 widget,DOM 自然还原。
          // 偏移是**打开输入框那一刻**记下的:`cell.from/to` 期间可能已被别处的改动挪走,
          // 越界的 change 会让 dispatch 抛错(而这里在 blur 处理器里,抛出去就没人接 ——
          // 输入框会留在界面上接着吃按键)。先按当前文档长度夹一次。
          const length = view.state.doc.length
          const from = Math.max(0, Math.min(cell.from, length))
          const to = Math.max(from, Math.min(cell.to, length))
          try {
            view.dispatch({ changes: { from, to, insert: value } })
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error('[dsh-notes] 单元格写回失败(已忽略):', error)
            input.remove()
          }
        } else {
          // 没改动(或取消):把输入框摘掉即可,底下的文本一直在
          input.remove()
        }
        // 只有"没有别的单元格还在编辑"时才把焦点还给编辑器 —— 否则从 A 格直接点到
        // B 格时,A 的 blur 会把焦点抢回 CM6,刚打开的 B 输入框就失焦了(实测踩到)。
        if (openCellInputs.size === 0) view.focus()
      }
      input.addEventListener('keydown', (keyEvent) => {
        keyEvent.stopPropagation()
        if (keyEvent.key === 'Enter') {
          keyEvent.preventDefault()
          commit(true)
        } else if (keyEvent.key === 'Escape') {
          keyEvent.preventDefault()
          commit(false)
        }
      })
      input.addEventListener('blur', () => commit(true))
      host.appendChild(input)
      openCellInputs.add(input)
      input.focus()
      // 不全选(用户反馈"蓝色选中是什么鬼"):光标落末尾
      input.setSelectionRange(input.value.length, input.value.length)
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
    // 把这块表在源码里的范围挂到 DOM 上:右键菜单要靠它把"插行/插列"写回源文档
    const last = this.model.rows[this.model.rows.length - 1]
    table.dataset.dshFrom = String(this.from)
    table.dataset.dshTo = String(last === undefined || last.length === 0 ? this.from : last[last.length - 1].to)
    wrap.appendChild(table)
    return wrap
  }

  ignoreEvent(): boolean {
    // widget 内部有自己的交互(输入框/复选框),不让 CM6 再处理这些事件
    return true
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
export function buildTableDecorations(state: EditorState, sourceMode: boolean = isSourceMode()): DecorationSet {
  // 源码模式:不加任何块级装饰(按**这个编辑器**的模式,不再读全局单例 —— 两栏分屏时
  // 左边预览、右边源码是常态)
  if (sourceMode) return Decoration.none
  const ranges = []
  // frontmatter(文档开头)→ 预览时收成一行「⋯ 元数据」chip。
  // 它是**整行替换**,必须由 StateField 提供(插件层不允许替换换行)。
  const metaEnd = frontmatterEndOf(state)
  if (metaEnd !== null && !selectionTouches(state, 0, metaEnd)) {
    const body = state.doc.sliceString(0, metaEnd)
    const summary = body
      .replace(/^---\r?\n?/, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && line !== '---')
      .join(' · ')
    ranges.push(Decoration.replace({ widget: new FrontmatterWidget(summary), block: true }).range(0, metaEnd))
  }
  const tree = ensureSyntaxTree(state, state.doc.length, 60)
  if (tree === null) return RangeSet.of(ranges, true)
  tree.iterate({
    enter: (node) => {
      // 公式块 `$$ … $$`:**独占整行(可多行)就渲染成块级 widget,前后不必空行**。
      // 必须在 StateField:插件层不能跨行替换。判据是"节点从行首开始、到行尾结束",
      // 不能要求"整个 Paragraph 就是一个公式" —— `$$` 紧挨着正文时整段是一个
      // Paragraph,那样会整块落空、原样显示(用户实测:必须前后空行才能渲染)。
      if (node.name === 'BlockMath') {
        const first = state.doc.lineAt(node.from)
        const last = state.doc.lineAt(Math.max(node.from, node.to - 1))
        const fromLineStart = state.doc.sliceString(first.from, node.from).trim() === ''
        const toLineEnd = state.doc.sliceString(node.to, last.to).trim() === ''
        const tex = state.doc.sliceString(node.from + 2, node.to - 2).trim()
        if (fromLineStart && toLineEnd && tex !== '') {
          if (!selectionTouches(state, first.from, last.to)) {
            ranges.push(
              Decoration.replace({ widget: new BlockMathWidget(tex, first.from), block: true }).range(first.from, last.to),
            )
          }
          return false // 子节点不再处理
        }
      }
      // 表格:渲染成真 <table>(预览模式**永不翻回源码**,单元格就地编辑,见 TableWidget)
      if (node.name === 'Table') {
        // 范围必须夹到"最后一行含 | 的行":解析器的 Table 节点会把紧跟表格的那一行
        // 也算进来,而这里是**整块 replace** → 那行文字会被隐藏(用户实测)。
        const range = clampTableRange(state, node.from, node.to)
        const source = state.doc.sliceString(range.from, range.to)
        const model = parseTable(source, range.from)
        if (model.header.length === 0) return
        ranges.push(Decoration.replace({ widget: new TableWidget(model, range.from), block: true }).range(range.from, range.to))
        // 跳过该节点的子节点(表格内部不需要行内装饰)。注意:解析器的 Table 节点包含紧跟
        // 表格的那一行,所以那一行也拿不到行内装饰 —— 这是**已知未修**的问题,靶子见
        // test/markdown-render.test.mjs 的 skip 用例。此前我改成"不 return + 记录范围"，
        // 结果编辑时装饰重建变慢/卡死(用户实测"设一次格式就卡住"),故撤回。
        return
      }
      // 代码围栏:渲染成卡片(顶栏 = 语言 + 复制按钮,正文 = 等宽代码);
      // **光标进入这块时收起卡片、显示源码** —— 编辑交给编辑器本体(多行选择/中文输入法/
      // 撤销/搜索全原生)。这是 Obsidian Live Preview 的做法,比在 widget 里嵌编辑器稳。
      if (node.name === 'FencedCode') {
        if (selectionTouches(state, node.from, node.to)) return
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


/** 内层编辑器用的语言扩展(函数形式才是合法的 Extension)。 */
/** 内层编辑器的高亮(颜色与卡片一致,走主题变量)。 */
/** 内层编辑器的外观:与卡片正文同观感(透明底、等宽、无额外内边距)。 */
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
    return other.source === this.source && other.from === this.from
  }

  toDOM(view: EditorView): HTMLElement {
    const { language, code } = this.parts()
    const first = this.source.split('\n')[0] ?? ''
    const fence = /^\s*(```|~~~)/.exec(first)?.[1] ?? '```'

    // 外层只负责**上下留白**,留白必须用 padding 而不是 margin:
    // CM6 的行高测量只取 widget 的边框盒高度(不含外边距),一旦用了 margin,
    // 每个代码块就会让其后所有行的"点击落点"整体上移 ~12px —— 表现就是
    // "鼠标明明在这一行,稍微往下一点就选中了下一行"。内层才是视觉上的卡片。
    const root = document.createElement('div')
    root.className = 'dsh-cm-code-card'
    const card = document.createElement('div')
    card.className = 'dsh-cm-code-card-inner'
    const bar = document.createElement('div')
    bar.className = 'dsh-cm-code-bar'
    const label = document.createElement('span')
    label.className = 'dsh-cm-code-lang-label'
    label.textContent = language === '' ? 'text' : language
    label.title = '点击修改语言'
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'dsh-cm-code-copy'
    copy.textContent = '复制'
    copy.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void navigator.clipboard?.writeText(code)
      copy.textContent = '已复制'
      window.setTimeout(() => {
        copy.textContent = '复制'
      }, 1200)
    })
    // 语言名就地改(写回围栏首行)
    label.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const box = document.createElement('input')
      box.className = 'dsh-cm-code-lang-input'
      box.value = language
      const commitLang = (save: boolean): void => {
        const next = box.value.trim()
        if (save && next !== language) {
          view.dispatch({ changes: { from: this.from, to: this.from + first.length, insert: fence + next } })
        } else {
          bar.replaceChild(label, box)
        }
        view.focus()
      }
      box.addEventListener('keydown', (keyEvent) => {
        keyEvent.stopPropagation()
        if (keyEvent.key === 'Enter') {
          keyEvent.preventDefault()
          commitLang(true)
        } else if (keyEvent.key === 'Escape') {
          keyEvent.preventDefault()
          commitLang(false)
        }
      })
      box.addEventListener('blur', () => commitLang(true))
      bar.replaceChild(box, label)
      box.focus()
      box.setSelectionRange(box.value.length, box.value.length)
    })
    bar.append(label, copy)

    const body = document.createElement('div')
    body.className = 'dsh-cm-code-body'
    const pre = document.createElement('pre')
    pre.className = 'dsh-cm-code-pre'
    const codeEl = document.createElement('code')
    paintCode(codeEl, code, language)
    pre.appendChild(codeEl)
    body.appendChild(pre)

    // 点正文 → 光标进入这一块(围栏内),卡片随即收起、显示源码,由编辑器本体编辑
    body.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const anchor = Math.min(this.from + 3, view.state.doc.length)
      view.dispatch({ selection: { anchor } })
      view.focus()
    })

    card.append(bar, body)
    root.appendChild(card)
    return root
  }

  ignoreEvent(): boolean {
    // 卡片内部有输入框/复制按钮,不让外层 CM6 处理这些事件
    return true
  }
}

/**
 * 热路径兜底:块级装饰构建抛错**不能把整次事务带崩**。
 *
 * 为什么必须兜:`tableBlocks` 是 StateField,它的 `update` 在**每一次文档变更/选区变更**
 * 时同步调用,而 StateField 里抛出的异常会让这次 `view.dispatch` 整个失败 —— 状态与 DOM
 * 就此不同步,表现就是"编辑器卡死,只能切到别的笔记再切回来(重建 EditorView)才恢复"。
 * ViewPlugin 那条路已有 `safeBuild` 兜住,这里补齐。
 * @param state - 编辑器状态。
 * @param sourceMode - 这个编辑器是不是源码模式。
 * @returns 装饰集;构建失败时返回空集(宁可少渲染,不可卡死)。
 */
function safeTableDecorations(state: EditorState, sourceMode: boolean): DecorationSet {
  try {
    return buildTableDecorations(state, sourceMode)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[dsh-notes] 块级装饰构建失败(本次跳过):', error)
    return Decoration.none
  }
}

export function tableBlocks(sourceMode: boolean = isSourceMode()): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => safeTableDecorations(state, sourceMode),
    // sourceMode 必须一并转发:早先这里漏了,于是任何一次改动都会按**模块级**默认值重建,
    // 两栏分屏时"源码栏被预览装饰覆盖"就是这么来的。
    update: (value, transaction) =>
      transaction.docChanged || transaction.selection !== undefined
        ? safeTableDecorations(transaction.state, sourceMode)
        : value,
    provide: (field) => EditorView.decorations.from(field),
  })
}

/** 找到光标所在的表格节点。 */
function enclosingTable(state: EditorState, pos: number): { from: number; to: number } | null {
  let node = syntaxTree(state).resolveInner(pos, 1)
  while (node !== null) {
    if (node.name === 'Table') return clampTableRange(state, node.from, node.to)
    node = node.parent
  }
  return null
}

/**
 * 把语法树的 Table 节点范围**夹到真正的表格行**上。
 *
 * 为什么需要:解析器的 Table 节点会把"表格下面紧跟的那一行"也算进去,而我们的 widget 是
 * **整块 replace**,于是那行文字被直接隐藏掉(用户实测:表格下写 `端到端`,渲染后它没了)。
 * 表格行一定含 `|`,所以从末尾往前找到最后一个含 `|` 的行即可。
 * @param state - 编辑器状态。
 * @param from - 节点起点。
 * @param to - 节点终点。
 * @returns 夹好的范围。
 */
function clampTableRange(state: EditorState, from: number, to: number): { from: number; to: number } {
  const text = state.doc.sliceString(from, to)
  const lines = text.split('\n')
  let last = lines.length - 1
  while (last >= 0 && !lines[last].includes('|')) last -= 1
  if (last < 0) return { from, to }
  return { from, to: from + lines.slice(0, last + 1).join('\n').length }
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
