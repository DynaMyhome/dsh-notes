/**
 * 笔记编辑区(CodeMirror 6,所见即所得)。
 *
 * 行为:
 *   - 打开即读正文 + **版本号**(与 save 同源);改字后 800ms 自动保存;
 *   - `Ctrl/Cmd+S` 立即保存(在 CM6 的 keymap 里);
 *   - 守卫式保存:版本不符 → **冲突条**(重新载入 / 覆盖),绝不静默覆盖;
 *   - 工具栏:粗体/斜体/高亮/H1-3/列表/引用/行内码/图片。
 *
 * 文件始终是纯 md:编辑器只改源码,渲染由 CM6 装饰层完成(见 editor/setup.ts)。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'

import { parseOutline } from '../../lib/outline.js'
import { RouteError, readNote, saveNote, uploadAsset, type TreeNote } from './api'
import {
  createEditor,
  historyRedo,
  historyUndo,
  insertCodeFence,
  insertHorizontalRule,
  insertImageSnippet,
  insertLink,
  insertMath,
  insertTable,
  insertWikiLinkSnippet,
  setHeading,
  toggleIndent,
  toggleLinePrefix,
  wrapSelection,
  type EditorHandle,
} from './editor/setup'
import { initialAnchor } from './editor/frontmatter'
import type { OutlineItem } from './OutlinePane'
import { ContextMenu, type MenuEntry } from './ContextMenu'
import { setSourceMode as applySourceMode } from './editor/mode'
import { buildNoteReference, headingBreadcrumb } from './editor/reference'
import {
  IconBold,
  IconCheck,
  IconCode,
  IconCodeBlock,
  IconHr,
  IconHighlight,
  IconImage,
  IconIndent,
  IconItalic,
  IconLink,
  IconList,
  IconMath,
  IconOrderedList,
  IconOutdent,
  IconQuote,
  IconRedo,
  IconStrike,
  IconTable,
  IconTaskList,
  IconUndo,
  IconWarn,
  IconWikiLink,
} from './icons'

/** 自动保存的静默时长(ms)。 */
const AUTOSAVE_MS = 800

/** 工具栏弹层:需要参数的命令(同一时刻只开一个)。 */
type ToolPopover = 'heading' | 'link' | 'table' | 'math' | null

/** 表格选择器的网格上限(行 × 列)。 */
const TABLE_ROWS = 6
const TABLE_COLS = 8

/** props。 */
export interface EditorPaneProps {
  t: (key: string) => string
  sessionId: string
  note: TreeNote
  /** 正文标题树变化(喂给左侧大纲)。 */
  onOutline?: (items: OutlineItem[]) => void
  /** 光标所在行变化(大纲高亮当前小节)。 */
  onCursorLine?: (line: number) => void
  /** 请求跳转到某一行(`nonce` 变化即触发一次)。 */
  jumpTo?: { line: number; nonce: number } | null
  /** 大纲拖拽重排章节的请求(`nonce` 变化即触发一次)。 */
  outlineMove?: { fromLine: number; toLine: number; mode: 'before' | 'after'; nonce: number } | null
  /** 点 `[[双链]]`(外壳决定打开还是新建)。 */
  onWikiLink?: (title: string) => void
  /** 当前工作区已知标题(双链上色用)。 */
  getKnownTitles?: () => Set<string>
  /**
   * 源码模式由**外壳**控制(分屏时两栏各自独立);不传就退回组件内部 state。
   * 切模式仍然靠重建编辑器(装饰与 StateField 都在扩展里,建好就定了)。
   */
  sourceMode?: boolean
  onToggleSourceMode?: () => void
  /**
   * 是否显示工具栏(默认 true)。
   *
   * 分屏时**只让聚焦栏显示**:两栏各一套工具既挤又容易点错目标;
   * 条本身在两边都保留(等高),所以切换聚焦时高度不会跳。
   */
  showToolbar?: boolean
}

/** 保存状态。 */
type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

/**
 * 编辑区。
 * @param props - 见 {@link EditorPaneProps}。
 */
export function EditorPane(props: EditorPaneProps): React.ReactElement {
  const { t, sessionId, note } = props
  const outlineRef = useRef(props.onOutline)
  const cursorRef = useRef(props.onCursorLine)
  outlineRef.current = props.onOutline
  cursorRef.current = props.onCursorLine
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<EditorHandle | null>(null)
  const versionRef = useRef<string>('')
  const timerRef = useRef<number | null>(null)
  const dirtyRef = useRef(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [conflict, setConflict] = useState<{ version: string; text: string | null } | null>(null)
  /** 一次性提示(如「已恢复 dsh-note-id」),3 秒后自动消失。 */
  const [notice, setNotice] = useState<string | null>(null)
  /** 右键菜单(位置 + 打开时的选区快照)。 */
  const [menu, setMenu] = useState<{ x: number; y: number; from: number; to: number } | null>(null)
  const [docPath, setDocPath] = useState<string | null>(null)
  const [length, setLength] = useState(0)
  /** 源码模式(Typora 式:默认预览,标记全隐藏;要看/改源码时切过来)。 */
  const [localSourceMode, setLocalSourceMode] = useState(false)
  const sourceMode = props.sourceMode ?? localSourceMode
  /** 当前打开的工具栏弹层(标题 / 链接 / 表格 / 公式)。 */
  const [popover, setPopover] = useState<ToolPopover>(null)
  /** 弹层左缘(相对编辑器条):开弹层时按按钮位置算一次,窄侧栏里夹回可见范围。 */
  const [popoverLeft, setPopoverLeft] = useState(8)
  const [linkText, setLinkText] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [mathTex, setMathTex] = useState('')
  /** 表格选择器里光标悬停到的 行×列。 */
  const [tablePick, setTablePick] = useState<{ rows: number; cols: number } | null>(null)
  /** 编辑器条(弹层的定位上下文 + 判断"点在外面"的边界)。 */
  const barRef = useRef<HTMLDivElement | null>(null)

  /** 保存(守卫式)。 */
  const save = useCallback(async (): Promise<void> => {
    const editor = editorRef.current
    if (editor === null || !dirtyRef.current) return
    const text = editor.getDoc()
    setSaveState('saving')
    try {
      const result = await saveNote(sessionId, note.path, text, versionRef.current)
      versionRef.current = String(result.version)
      dirtyRef.current = false
      setSaveState('saved')
      setConflict(null)
      // 身份标识被删/被改 → Host 已按索引写回:编辑区同步成磁盘内容,免得下一次
      // 自动保存又把它删掉(用户看不到的"来回打架")。
      if (result.restoredId === true && typeof result.text === 'string') {
        editor.setDoc(result.text)
        dirtyRef.current = false
        setNotice(t('editor.idRestored'))
      }
    } catch (caught) {
      if (caught instanceof RouteError && caught.code === 'FS_STALE_VERSION') {
        setConflict({ version: caught.currentVersion ?? '', text: caught.currentText ?? null })
        setSaveState('error')
        return
      }
      setError(caught instanceof Error ? caught.message : String(caught))
      setSaveState('error')
    }
  }, [note.path, sessionId])

  /** 载入笔记并挂上编辑器。 */
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setError(null)
    setConflict(null)
    dirtyRef.current = false
    setSaveState('idle')

    void (async () => {
      try {
        const loaded = await readNote(sessionId, note.path)
        if (cancelled) return
        versionRef.current = String(loaded.version)
        setDocPath(loaded.absolutePath)
        setLength(loaded.text.length)
        outlineRef.current?.(parseOutline(loaded.text))
        const host = hostRef.current
        if (host === null) return
        editorRef.current?.destroy()
        // 切模式靠重建编辑器:装饰插件与块级 StateField 都读这个标志
        applySourceMode(sourceMode)
        editorRef.current = createEditor({
          parent: host,
          doc: loaded.text,
          documentPath: loaded.absolutePath,
          sourceMode,
          onChange: () => {
            dirtyRef.current = true
            setSaveState('dirty')
            const text = editorRef.current?.getDoc() ?? ''
            setLength(text.length)
            outlineRef.current?.(parseOutline(text))
            if (timerRef.current !== null) window.clearTimeout(timerRef.current)
            timerRef.current = window.setTimeout(() => {
              void save()
            }, AUTOSAVE_MS)
          },
          onSelection: (line: number) => cursorRef.current?.(line),
          // 粘贴/拖入的图片 → 上传到资产目录 → 在光标处插入 markdown 链接
          onImageFile: (file: File) => {
            void (async () => {
              try {
                const asset = await uploadAsset(sessionId, note.id, file.name, file)
                const editor = editorRef.current
                if (editor === null) return
                const range = editor.view.state.selection.main
                editor.view.dispatch({
                  changes: { from: range.from, to: range.to, insert: asset.markdown },
                  selection: { anchor: range.from + asset.markdown.length },
                })
                editor.focus()
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : String(caught))
              }
            })()
          },
          onWikiLink: props.onWikiLink,
          getKnownTitles: props.getKnownTitles,
          onSave: () => {
            if (timerRef.current !== null) window.clearTimeout(timerRef.current)
            void save()
          },
        })
        // 光标别停在 frontmatter 里(否则"光标进去就展开"会让每次打开都摊开元数据)
        const anchor = initialAnchor(loaded.text)
        if (anchor > 0) editorRef.current?.view.dispatch({ selection: { anchor } })
        setStatus('ready')
      } catch (caught) {
        if (cancelled) return
        setError(caught instanceof Error ? caught.message : String(caught))
        setStatus('failed')
      }
    })()

    return () => {
      cancelled = true
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = null
      editorRef.current?.destroy()
      editorRef.current = null
      outlineRef.current?.([])
    }
  }, [note.path, save, sessionId, sourceMode])

  /** 大纲点击 → 跳到该标题行。 */
  useEffect(() => {
    const target = props.jumpTo
    if (target === null || target === undefined) return
    editorRef.current?.scrollToLine(target.line)
  }, [props.jumpTo])

  /** 大纲拖拽 → 在正文里搬移整个章节(纯文本搬移,见 lib/section.js,有单测)。 */
  useEffect(() => {
    const request = props.outlineMove
    if (request === null || request === undefined) return
    editorRef.current?.moveSection(request.fromLine, request.toLine, request.mode)
  }, [props.outlineMove])

  /** 冲突:用磁盘上的内容重新载入。 */
  const reload = useCallback(() => {
    const editor = editorRef.current
    if (editor === null || conflict === null) return
    if (conflict.text !== null) editor.setDoc(conflict.text)
    versionRef.current = conflict.version
    dirtyRef.current = false
    setConflict(null)
    setSaveState('saved')
    setLength(conflict.text?.length ?? 0)
  }, [conflict])

  /** 冲突:以本地内容覆盖(用磁盘版本作为前提)。 */
  const overwrite = useCallback(async () => {
    if (conflict === null) return
    versionRef.current = conflict.version
    dirtyRef.current = true
    setConflict(null)
    await save()
  }, [conflict, save])

  useEffect(() => {
    if (notice === null) return undefined
    const timer = window.setTimeout(() => setNotice(null), 3000)
    return () => window.clearTimeout(timer)
  }, [notice])

  /**
   * 执行一个工具栏命令。
   *
   * 顺手收起弹层:弹层与"直接生效"的命令是互斥的,留着它会挡住刚改过的正文。
   */
  /** 写剪贴板并给一句提示(失败也要说清楚,别静默)。 */
  const copyText = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
        setNotice(t('editor.copied'))
      } catch {
        setNotice(t('editor.copyFailed'))
      }
    },
    [t],
  )

  const apply = useCallback((action: (handle: EditorHandle) => void) => {
    setPopover(null)
    const editor = editorRef.current
    if (editor === null) return
    action(editor)
  }, [])

  /** 当前选区文本(链接弹层的默认"文字");换行折成空格,免得整段被塞进链接)。 */
  const selectionText = useCallback((): string => {
    const view = editorRef.current?.view
    if (view === undefined) return ''
    const range = view.state.selection.main
    return view.state.sliceDoc(range.from, range.to).replace(/\s*\n\s*/g, ' ')
  }, [])

  /**
   * 打开 / 收起弹层。
   *
   * 定位靠 `getBoundingClientRect` 算出的**相对编辑器条**左缘:弹层是编辑器条的绝对定位
   * 子节点,而不是工具栏的子节点 —— 工具栏为了横向滚动是 `overflow:auto`,弹层放里面会被裁掉。
   */
  const openPopover = useCallback(
    (kind: Exclude<ToolPopover, null>, element: HTMLElement, seed = '') => {
      setPopover((current) => (current === kind ? null : kind))
      // 每次打开都重置弹层自己的字段,免得上一次的输入惊喜地留在框里
      if (kind === 'link') {
        setLinkText(seed)
        setLinkUrl('')
      } else if (kind === 'math') {
        setMathTex('')
      } else if (kind === 'table') {
        setTablePick(null)
      }
      const bar = barRef.current
      if (bar === null) return
      const anchor = element.getBoundingClientRect()
      const bounds = bar.getBoundingClientRect()
      setPopoverLeft(Math.max(4, Math.min(anchor.left - bounds.left, Math.max(4, bounds.width - 272))))
    },
    [],
  )

  /** 弹层:点编辑器条之外收起,Escape 也收起(Enter 确认由各输入框自己处理)。 */
  useEffect(() => {
    if (popover === null) return undefined
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (target !== null && barRef.current?.contains(target) === true) return
      setPopover(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setPopover(null)
    }
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [popover])

  /** 链接弹层确认。 */
  const confirmLink = useCallback(() => {
    apply((e) => insertLink(e.view, linkText, linkUrl))
  }, [apply, linkText, linkUrl])

  /** 公式弹层确认(`block` = 块级 `$$…$$`)。 */
  const confirmMath = useCallback(
    (block: boolean) => {
      apply((e) => insertMath(e.view, mathTex, block))
    },
    [apply, mathTex],
  )

  /** 右键菜单:引用此处 + 文本格式 / 段落设置 / 插入(照 Obsidian 1.5 的原生三组)。 */
  const menuEntries = (snapshot: { from: number; to: number }): MenuEntry[] => {
    const editor = editorRef.current
    if (editor === null) return []
    const text = editor.getDoc()
    const run = (action: (handle: EditorHandle) => void): (() => void) => () => apply(action)
    const reference = (): void => {
      void copyText(
        buildNoteReference({
          relPath: note.relPath,
          text,
          from: snapshot.from,
          to: snapshot.to,
          heading: headingBreadcrumb(text, snapshot.from),
        }),
      )
    }
    return [
      { id: 'ref', label: t('menu.quoteHere'), shortcut: '⇧⌘C', action: reference },
      { id: 'path', label: t('menu.copyPath'), action: () => void copyText(note.relPath) },
      { id: 'title', label: t('menu.copyTitle'), action: () => void copyText(note.title) },
      { id: 'sep1', separator: true },
      {
        id: 'format',
        label: t('menu.format'),
        children: [
          { id: 'bold', label: t('editor.bold'), action: run((e) => wrapSelection(e.view, '**')) },
          { id: 'italic', label: t('editor.italic'), action: run((e) => wrapSelection(e.view, '*')) },
          { id: 'strike', label: t('editor.strike'), action: run((e) => wrapSelection(e.view, '~~')) },
          { id: 'highlight', label: t('editor.highlight'), action: run((e) => wrapSelection(e.view, '==')) },
          { id: 'code', label: t('editor.code'), action: run((e) => wrapSelection(e.view, '`')) },
          { id: 'math', label: t('editor.mathInline'), action: run((e) => insertMath(e.view, '', false)) },
          { id: 'link', label: t('editor.link'), action: run((e) => insertLink(e.view, '', '')) },
          { id: 'clear', label: t('menu.clearFormat'), action: run((e) => clearFormatting(e.view)) },
        ],
      },
      {
        id: 'paragraph',
        label: t('menu.paragraph'),
        children: [
          ...[0, 1, 2, 3, 4, 5, 6].map((level) => ({
            id: `h${level}`,
            label: level === 0 ? t('menu.paragraphText') : `H${level}`,
            shortcut: level === 0 ? undefined : `⌘${level}`,
            action: run((e) => setHeading(e.view, level)),
          })),
          { id: 'psep', separator: true },
          { id: 'bullet', label: t('editor.list'), action: run((e) => toggleLinePrefix(e.view, '- ')) },
          { id: 'ordered', label: t('editor.orderedList'), action: run((e) => toggleLinePrefix(e.view, '1. ')) },
          { id: 'task', label: t('editor.taskList'), action: run((e) => toggleLinePrefix(e.view, '- [ ] ')) },
          { id: 'quote', label: t('editor.quote'), action: run((e) => toggleLinePrefix(e.view, '> ')) },
          { id: 'indent', label: t('editor.indent'), action: run((e) => toggleIndent(e.view, false)) },
          { id: 'outdent', label: t('editor.outdent'), action: run((e) => toggleIndent(e.view, true)) },
        ],
      },
      {
        id: 'insert',
        label: t('menu.insert'),
        children: [
          { id: 'table', label: t('editor.table'), action: run((e) => insertTable(e.view, 3, 3)) },
          { id: 'image', label: t('editor.image'), action: run((e) => insertImageSnippet(e.view)) },
          { id: 'ilink', label: t('editor.link'), action: run((e) => insertLink(e.view, '', '')) },
          { id: 'wiki', label: t('editor.wikiLink'), action: run((e) => insertWikiLinkSnippet(e.view)) },
          { id: 'mathblock', label: t('editor.mathBlock'), action: run((e) => insertMath(e.view, '', true)) },
          { id: 'fence', label: t('editor.codeBlock'), action: run((e) => insertCodeFence(e.view)) },
          { id: 'hr', label: t('editor.horizontalRule'), action: run((e) => insertHorizontalRule(e.view)) },
        ],
      },
      { id: 'sep2', separator: true },
      { id: 'undo', label: t('editor.undo'), action: run((e) => historyUndo(e.view)) },
      { id: 'redo', label: t('editor.redo'), action: run((e) => historyRedo(e.view)) },
    ]
  }

  const stateText =
    status === 'loading'
      ? t('editor.loading')
      : saveState === 'saving'
        ? t('editor.saving')
        : saveState === 'dirty'
          ? t('editor.dirty')
          : saveState === 'error'
            ? t('editor.saveFailed')
            : t('editor.saved')

  return (
    <div className="dsh-notes-editor-pane">
      {/* 编辑器条是弹层的定位上下文(弹层挂在条上,不是挂在会滚动的工具栏里) */}
      <div className="dsh-notes-editor-bar" ref={barRef}>
        <span className="dsh-notes-editor-name" title={docPath ?? note.path}>
          {note.title}
        </span>
        <span className="dsh-notes-spacer" />
        {/* 一行命令:放不下就横向滚动(见 styles.ts),分组用细分隔线。
            分屏时只有聚焦栏渲染它(见 showToolbar),另一栏留一条等高的空条。 */}
        {props.showToolbar === false ? null : (
        <span className="dsh-notes-toolbar dsh-notes-editor-tools" role="toolbar">
          {/* 1 历史 */}
          <button type="button" className="dsh-notes-btn" title={t('editor.undo')} aria-label={t('editor.undo')} onClick={() => apply((e) => historyUndo(e.view))}>
            <IconUndo />
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.redo')} aria-label={t('editor.redo')} onClick={() => apply((e) => historyRedo(e.view))}>
            <IconRedo />
          </button>
          <span className="dsh-notes-sep" />

          {/* 2 标题:级别按行生效,正文 = 去掉标题 */}
          <button
            type="button"
            className="dsh-notes-btn"
            title={t('editor.headingMenu')}
            aria-label={t('editor.headingMenu')}
            aria-haspopup="menu"
            aria-expanded={popover === 'heading'}
            onClick={(event) => openPopover('heading', event.currentTarget)}
          >
            <span className="dsh-notes-h-mark">H</span>
            <span className="dsh-notes-caret-mark">▾</span>
          </button>
          <span className="dsh-notes-sep" />

          {/* 3 行内 */}
          <button type="button" className="dsh-notes-btn" title={t('editor.bold')} aria-label={t('editor.bold')} onClick={() => apply((e) => wrapSelection(e.view, '**'))}>
            <IconBold />
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.italic')} aria-label={t('editor.italic')} onClick={() => apply((e) => wrapSelection(e.view, '*'))}>
            <IconItalic />
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.strike')} aria-label={t('editor.strike')} onClick={() => apply((e) => wrapSelection(e.view, '~~'))}>
            <IconStrike />
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.highlight')} aria-label={t('editor.highlight')} onClick={() => apply((e) => wrapSelection(e.view, '=='))}>
            <IconHighlight />
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.code')} aria-label={t('editor.code')} onClick={() => apply((e) => wrapSelection(e.view, '`'))}>
            <IconCode />
          </button>
          <span className="dsh-notes-sep" />

          {/* 4 列表 */}
          <button type="button" className="dsh-notes-btn" title={t('editor.list')} aria-label={t('editor.list')} onClick={() => apply((e) => toggleLinePrefix(e.view, '- '))}>
            <IconList />
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.orderedList')} aria-label={t('editor.orderedList')} onClick={() => apply((e) => toggleLinePrefix(e.view, '1. '))}>
            <IconOrderedList />
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.taskList')} aria-label={t('editor.taskList')} onClick={() => apply((e) => toggleLinePrefix(e.view, '- [ ] '))}>
            <IconTaskList />
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.indent')} aria-label={t('editor.indent')} onClick={() => apply((e) => toggleIndent(e.view, false))}>
            <IconIndent />
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.outdent')} aria-label={t('editor.outdent')} onClick={() => apply((e) => toggleIndent(e.view, true))}>
            <IconOutdent />
          </button>
          <span className="dsh-notes-sep" />

          {/* 5 块 */}
          <button type="button" className="dsh-notes-btn" title={t('editor.quote')} aria-label={t('editor.quote')} onClick={() => apply((e) => toggleLinePrefix(e.view, '> '))}>
            <IconQuote />
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.codeBlock')} aria-label={t('editor.codeBlock')} onClick={() => apply((e) => insertCodeFence(e.view))}>
            <IconCodeBlock />
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.hr')} aria-label={t('editor.hr')} onClick={() => apply((e) => insertHorizontalRule(e.view))}>
            <IconHr />
          </button>
          <span className="dsh-notes-sep" />

          {/* 6 插入:需要参数的三条走弹层 */}
          <button
            type="button"
            className="dsh-notes-btn"
            title={t('editor.link')}
            aria-label={t('editor.link')}
            aria-haspopup="dialog"
            aria-expanded={popover === 'link'}
            onClick={(event) => openPopover('link', event.currentTarget, selectionText())}
          >
            <IconLink />
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.image')} aria-label={t('editor.image')} onClick={() => apply((e) => insertImageSnippet(e.view))}>
            <IconImage />
          </button>
          <button
            type="button"
            className="dsh-notes-btn"
            title={t('editor.table')}
            aria-label={t('editor.table')}
            aria-haspopup="dialog"
            aria-expanded={popover === 'table'}
            onClick={(event) => openPopover('table', event.currentTarget)}
          >
            <IconTable />
          </button>
          <button
            type="button"
            className="dsh-notes-btn"
            title={t('editor.math')}
            aria-label={t('editor.math')}
            aria-haspopup="dialog"
            aria-expanded={popover === 'math'}
            onClick={(event) => openPopover('math', event.currentTarget)}
          >
            <IconMath />
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.wikiLink')} aria-label={t('editor.wikiLink')} onClick={() => apply((e) => insertWikiLinkSnippet(e.view))}>
            <IconWikiLink />
          </button>
          <span className="dsh-notes-sep" />

          {/* 7 视图 */}
          <button
            type="button"
            className="dsh-notes-btn"
            title={sourceMode ? t('editor.previewMode') : t('editor.sourceMode')}
            aria-label={sourceMode ? t('editor.previewMode') : t('editor.sourceMode')}
            aria-pressed={sourceMode}
            onClick={() => {
              if (props.onToggleSourceMode !== undefined) props.onToggleSourceMode()
              else setLocalSourceMode((current) => !current)
            }}
          >
            {sourceMode ? t('editor.modeSourceShort') : t('editor.modePreviewShort')}
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.saveNow')} aria-label={t('editor.saveNow')} onClick={() => void save()}>
            <IconCheck />
          </button>
        </span>
        )}

        {/* 标题级别 */}
        {popover === 'heading' ? (
          <div className="dsh-notes-popover" role="menu" aria-label={t('editor.headingMenu')} style={{ left: popoverLeft }}>
            {[0, 1, 2, 3, 4, 5, 6].map((level) => (
              <button
                key={level}
                type="button"
                role="menuitem"
                className="dsh-notes-popover-item"
                onClick={() => apply((e) => setHeading(e.view, level))}
              >
                {level === 0 ? t('editor.bodyText') : `H${level}`}
              </button>
            ))}
          </div>
        ) : null}

        {/* 链接:文字 + URL,回车即插入 */}
        {popover === 'link' ? (
          <div className="dsh-notes-popover dsh-notes-popover-form" role="dialog" aria-label={t('editor.link')} style={{ left: popoverLeft }}>
            <input
              className="dsh-notes-input dsh-notes-popover-input"
              autoFocus
              value={linkText}
              placeholder={t('editor.linkText')}
              aria-label={t('editor.linkText')}
              onChange={(event) => setLinkText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                confirmLink()
              }}
            />
            <input
              className="dsh-notes-input dsh-notes-popover-input"
              value={linkUrl}
              placeholder={t('editor.linkUrl')}
              aria-label={t('editor.linkUrl')}
              onChange={(event) => setLinkUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                confirmLink()
              }}
            />
            <div className="dsh-notes-popover-row">
              <button type="button" className="dsh-notes-btn" onClick={confirmLink}>
                {t('editor.confirm')}
              </button>
              <button type="button" className="dsh-notes-btn" onClick={() => setPopover(null)}>
                {t('editor.cancel')}
              </button>
            </div>
          </div>
        ) : null}

        {/* 表格:拖动网格选行×列(最多 6×8) */}
        {popover === 'table' ? (
          <div className="dsh-notes-popover" role="dialog" aria-label={t('editor.table')} style={{ left: popoverLeft }}>
            <div className="dsh-notes-popover-label">
              {tablePick === null
                ? t('editor.tableHint')
                : t('editor.tableSize').replace('{r}', String(tablePick.rows)).replace('{c}', String(tablePick.cols))}
            </div>
            <div className="dsh-notes-grid" onMouseLeave={() => setTablePick(null)}>
              {Array.from({ length: TABLE_ROWS }, (_, row) => (
                <div className="dsh-notes-grid-row" key={row}>
                  {Array.from({ length: TABLE_COLS }, (_, col) => (
                    <button
                      key={col}
                      type="button"
                      className={`dsh-notes-grid-cell${
                        tablePick !== null && row < tablePick.rows && col < tablePick.cols ? ' dsh-notes-grid-cell-on' : ''
                      }`}
                      aria-label={`${row + 1} × ${col + 1}`}
                      onMouseEnter={() => setTablePick({ rows: row + 1, cols: col + 1 })}
                      onFocus={() => setTablePick({ rows: row + 1, cols: col + 1 })}
                      onClick={() => apply((e) => insertTable(e.view, row + 1, col + 1))}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* 公式:TeX + 行内/块级;回车默认插入行内 */}
        {popover === 'math' ? (
          <div className="dsh-notes-popover dsh-notes-popover-form" role="dialog" aria-label={t('editor.math')} style={{ left: popoverLeft }}>
            <input
              className="dsh-notes-input dsh-notes-popover-input"
              autoFocus
              value={mathTex}
              placeholder={t('editor.mathTex')}
              aria-label={t('editor.mathTex')}
              onChange={(event) => setMathTex(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                confirmMath(false)
              }}
            />
            <div className="dsh-notes-popover-row">
              <button type="button" className="dsh-notes-btn" onClick={() => confirmMath(false)}>
                {t('editor.mathInline')}
              </button>
              <button type="button" className="dsh-notes-btn" onClick={() => confirmMath(true)}>
                {t('editor.mathBlock')}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {notice !== null ? <div className="dsh-notes-notice">{notice}</div> : null}
      {menu === null ? null : (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu)} onClose={() => setMenu(null)} />
      )}
      {conflict !== null ? (
        <div className="dsh-notes-conflict">
          <IconWarn size={14} />
          <span className="dsh-notes-conflict-text">{t('editor.conflict')}</span>
          <button type="button" className="dsh-notes-btn" onClick={reload}>
            {t('editor.reload')}
          </button>
          <button type="button" className="dsh-notes-btn" onClick={() => void overwrite()}>
            {t('editor.overwrite')}
          </button>
        </div>
      ) : null}

      {status === 'failed' ? (
        <div className="dsh-notes-error">{error ?? t('editor.loadFailed')}</div>
      ) : (
        <div
          className="dsh-notes-editor-host"
          ref={hostRef}
          onContextMenu={(event) => {
            const editor = editorRef.current
            if (editor === null) return
            event.preventDefault()
            const range = editor.view.state.selection.main
            setMenu({ x: event.clientX, y: event.clientY, from: range.from, to: range.to })
          }}
        />
      )}

      <div className="dsh-notes-editor-status">
        <span>{stateText}</span>
        <span className="dsh-notes-spacer" />
        <span className="dsh-notes-dim">{t('editor.chars').replace('{n}', String(length))}</span>
        <span className="dsh-notes-dim dsh-notes-mono">{note.relPath}</span>
      </div>
    </div>
  )
}
