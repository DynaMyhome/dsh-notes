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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { parseOutline } from '../../lib/outline.js'
import {
  RouteError,
  fetchHistory,
  readNote,
  saveNote,
  saveNoteBeacon,
  undoExternalChange,
  uploadAsset,
  type TreeNote,
} from './api'
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
import { initialAnchor, normalizedLength } from './editor/frontmatter'
import { applyTableAction, type TableActionKind } from './editor/table-model'
import type { WidgetStrings } from './editor/table'
import type { OutlineItem } from './OutlinePane'
import { ContextMenu, type MenuEntry } from './ContextMenu'
import { HistoryPanel } from './HistoryPanel'
import { setSourceMode as applySourceMode } from './editor/mode'
import { buildNoteReference, headingBreadcrumb } from './editor/reference'
import {
  IconBold,
  IconCheck,
  IconCode,
  IconCodeBlock,
  IconHistory,
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
  /**
   * 工具栏「撤销」的前置钩子:返回 true 表示这次撤销被外壳接管了
   * (例如这个标签是点 `[[链接]]` 跳过来的,撤销应当回到上一个笔记)。
   */
  onBack?: () => boolean
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
  /**
   * 磁盘上这篇笔记的版本号(外壳每 1.5s 探一次;见 `NotesPane` 的 `probeExternal`)。
   *
   * 三种取值:`undefined` = 还没探到(不动);`string` = 磁盘当前版本;`null` = 文件
   * 不在了(被移走/删掉)。版本与手里的一致就什么都不做。
   */
  externalVersion?: string | null
  /** 这个标签是不是**它所在栏**的活动标签(隐藏标签不处理外部改动)。 */
  active?: boolean
  /**
   * 「打开历史面板」的信号(树右键 →「历史版本…」;`nonce` 变了就弹一次)。
   * 面板本体在编辑器里,所以外壳只发意图、由这里弹。
   */
  historyRequest?: { nonce: number } | null
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
  /**
   * 正在保存(守卫式 save 在飞行中)。
   *
   * 外部改动探针要靠它:保存请求发出去、响应还没回来的那一小段时间里,磁盘版本已经变了
   * 但 `versionRef` 还是旧值 —— 不跳过就会把自己刚写的内容当成"外部改动",误报冲突。
   */
  const savingRef = useRef(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [conflict, setConflict] = useState<{ version: string; text: string | null } | null>(null)
  /** 磁盘上的文件不见了(被移走/删掉):常驻一条提示,回来了自动消失。 */
  const [gone, setGone] = useState(false)
  /** 历史版本面板开着没有。 */
  const [historyOpen, setHistoryOpen] = useState(false)
  /**
   * 冲突横幅里「撤销这次外部改动」能不能点。
   *
   * 进冲突态时查一次历史(便宜的一次 GET):**没有更早的状态就不显示这个按钮** ——
   * 宁可少一个按钮,也不要给一个点了必然报错的入口。
   */
  const [canUndoExternal, setCanUndoExternal] = useState(false)
  /** 「撤销这次外部改动」的二次确认(它会覆盖编辑器内容,包括没保存的编辑)。 */
  const [undoConfirm, setUndoConfirm] = useState(false)
  /** 一次性提示(如「已恢复 dsh-note-id」),3 秒后自动消失。 */
  const [notice, setNotice] = useState<string | null>(null)
  /** 右键菜单(位置 + 打开时的选区快照)。 */
  const [menu, setMenu] = useState<{
    x: number
    y: number
    from: number
    to: number
    /** 点在表格里时带上:这块表的源范围与该单元格的行/列。 */
    table?: { from: number; to: number; row: number; col: number }
  } | null>(null)
  const [docPath, setDocPath] = useState<string | null>(null)
  /** 绝对路径的镜像:`attachEditor` 建于磁盘读取之后,只能从 ref 拿(见下)。 */
  const docPathRef = useRef<string | null>(null)
  const [length, setLength] = useState(0)
  /** 源码模式(Typora 式:默认预览,标记全隐藏;要看/改源码时切过来)。 */
  const [localSourceMode, setLocalSourceMode] = useState(false)
  const sourceMode = props.sourceMode ?? localSourceMode
  /**
   * CM6 装饰层里的文案(代码卡的复制按钮、元数据 chip…)。
   *
   * widget 是命令式 DOM,以前把中文写死在 `table.ts` 里 → 英文界面里冒出「复制」「⋯ 元数据」。
   * 这里按当前语言算一份,经 `createEditor({ strings })` 传下去。
   */
  const widgetStrings = useMemo<WidgetStrings>(
    () => ({
      chipMeta: t('editor.chipMeta'),
      chipExpand: t('editor.chipExpand'),
      codeCopy: t('editor.codeCopy'),
      codeCopied: t('editor.codeCopied'),
      codeLang: t('editor.codeLang'),
    }),
    [t],
  )
  const widgetStringsRef = useRef(widgetStrings)
  useEffect(() => {
    widgetStringsRef.current = widgetStrings
  }, [widgetStrings])
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

  /**
   * 保存(守卫式)。`text` 省略时取编辑器当前内容。
   *
   * 为什么要能**传入文本**:卸载(`unmount`)/关页面(`pagehide`)时要先把内容取出来再
   * 销毁编辑器,不能等 `editorRef.current` 变空。
   */
  const saveText = useCallback(async (text?: string): Promise<void> => {
    const editor = editorRef.current
    if (!dirtyRef.current) return
    const payload = text ?? editor?.getDoc()
    if (payload === undefined) return
    setSaveState('saving')
    savingRef.current = true
    try {
      const result = await saveNote(sessionId, note.path, payload, versionRef.current)
      versionRef.current = String(result.version)
      dirtyRef.current = false
      setSaveState('saved')
      setConflict(null)
      // 身份标识被删/被改 → Host 已按索引写回:编辑区同步成磁盘内容,免得下一次
      // 自动保存又把它删掉(用户看不到的"来回打架")。
      if (result.restoredId === true && typeof result.text === 'string') {
        editorRef.current?.setDoc(result.text)
        dirtyRef.current = false
        setNotice(t('editor.idRestored'))
      }
    } catch (caught) {
      if (caught instanceof RouteError && caught.code === 'FS_STALE_VERSION') {
        // **自愈**:磁盘上的内容 == 我们正要写的内容 → 那是**我们自己**刚写下去的
        // (关页面时的 sendBeacon / 另一个标签页 / 上一次超时重试),只是版本号没对上。
        // 这种情况只对齐版本、算保存成功 —— 不该弹"文件已被外部修改"吓用户
        // (真正的**外部**改动内容必然不同,下面那条分支照旧走)。
        if (caught.currentText !== undefined && caught.currentText === payload) {
          versionRef.current = caught.currentVersion ?? versionRef.current
          dirtyRef.current = false
          setSaveState('saved')
          setConflict(null)
          return
        }
        setConflict({ version: caught.currentVersion ?? '', text: caught.currentText ?? null })
        setSaveState('error')
        return
      }
      setError(caught instanceof Error ? caught.message : String(caught))
      setSaveState('error')
    } finally {
      // 无论成功/冲突/失败都要落回 false:探针靠它区分"自己写的"与"外部改的"。
      savingRef.current = false
    }
  }, [note.path, sessionId, t])

  /** 保存当前编辑器内容。 */
  const save = useCallback((): Promise<void> => saveText(), [saveText])

  /**
   * 把编辑器挂到宿主元素上(**载入**与**切模式**共用)。
   *
   * **不读磁盘**:文本由调用方给。切模式时必须传"当前文档",否则 800ms 自动保存窗口里
   * 没落盘的编辑会被磁盘内容覆盖掉(实测:切一次「源码/预览」,刚打的字静默回退)。
   * @param text - 要装进编辑器的 markdown。
   * @param anchor - 初始光标位置。
   * @param scrollTop - 保留的滚动位置(切模式用;载入时为 0)。
   */
  const attachEditor = useCallback(
    (text: string, anchor: number, scrollTop = 0): void => {
      const host = hostRef.current
      if (host === null) return
      editorRef.current?.destroy()
      // 装饰插件与块级 StateField 都读这个模块级标志,所以换模式必须重建编辑器
      applySourceMode(sourceMode)
      editorRef.current = createEditor({
        parent: host,
        doc: text,
        documentPath: docPathRef.current,
        sourceMode,
        strings: widgetStringsRef.current,
        onChange: () => {
          dirtyRef.current = true
          setSaveState('dirty')
          const current = editorRef.current?.getDoc() ?? ''
          setLength(current.length)
          outlineRef.current?.(parseOutline(current))
          if (timerRef.current !== null) window.clearTimeout(timerRef.current)
          timerRef.current = window.setTimeout(() => {
            void saveRef.current()
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
          void saveRef.current()
        },
      })
      // 夹到文档长度再 dispatch:**CM6 的 `Selection points outside of document`
      // 是硬抛错**,会把整个编辑器带崩。CRLF 笔记以前就踩在这上面(见
      // editor/frontmatter.ts 的 initialAnchor 注释)。别处每个 dispatch 也都有同样的夹取。
      const length = editorRef.current?.view.state.doc.length ?? 0
      const clamped = Math.max(0, Math.min(anchor, length))
      if (clamped > 0) editorRef.current?.view.dispatch({ selection: { anchor: clamped } })
      if (scrollTop > 0) editorRef.current.view.scrollDOM.scrollTop = scrollTop
    },
    [note.id, props.getKnownTitles, props.onWikiLink, sessionId, sourceMode],
  )

  // 回调镜像:载入 effect 的依赖必须**只有**「换笔记 / 换会话」,它内部一律走 ref 取最新回调
  const saveRef = useRef<(text?: string) => Promise<void>>(async () => {})
  useEffect(() => {
    saveRef.current = saveText
  }, [saveText])
  const attachRef = useRef<(text: string, anchor: number, scrollTop?: number) => void>(() => {})
  useEffect(() => {
    attachRef.current = attachEditor
  }, [attachEditor])

  /**
   * 载入笔记并挂上编辑器。
   *
   * **依赖只有 `[note.path, sessionId]`**:把 `sourceMode` / 回调放进依赖,它们一变就会
   * 重读磁盘并重建编辑器 —— 那正是"切模式丢字"的根因。切模式改走下面那条 effect(用当前文档)。
   */
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
        docPathRef.current = loaded.absolutePath
        setDocPath(loaded.absolutePath)
        setLength(normalizedLength(loaded.text))
        outlineRef.current?.(parseOutline(loaded.text))
        // 光标别停在 frontmatter 里(否则"光标进去就展开"会让每次打开都摊开元数据)
        attachRef.current(loaded.text, initialAnchor(loaded.text))
        setStatus('ready')
      } catch (caught) {
        if (cancelled) return
        setError(caught instanceof Error ? caught.message : String(caught))
        setStatus('failed')
      }
    })()

    return () => {
      cancelled = true
      // **卸载前必须把没保存的编辑交出去**:旧实现只 clearTimeout + destroy,
      // 800ms 自动保存窗口里的输入就这么没了(关标签 / 收分屏 / 切工作区实测)。
      const editor = editorRef.current
      const text = editor?.getDoc()
      const dirty = dirtyRef.current
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = null
      editorRef.current = null
      editor?.destroy()
      outlineRef.current?.([])
      if (dirty && text !== undefined) void saveRef.current(text)
    }
  }, [note.path, sessionId])

  /**
   * 切「预览/源码」:用**当前文档**重建编辑器。
   *
   * 重建是必须的(见 `attachEditor` 的注释),但**绝不能再读一次磁盘** ——
   * 版本号与脏标记原样保留,所以刚打的字还在,800ms 后照样自动保存。
   */
  const modeRef = useRef(sourceMode)
  useEffect(() => {
    if (modeRef.current === sourceMode) return
    modeRef.current = sourceMode
    const editor = editorRef.current
    if (editor === null) return
    attachRef.current(editor.getDoc(), editor.view.state.selection.main.head, editor.view.scrollDOM.scrollTop)
  }, [sourceMode])

  /**
   * 关页面 / 切到后台时的**尽力落盘**。
   *
   * 卸载 flush 只在组件真的被卸载时发生;关标签页、刷新、切到别的应用时只有
   * `pagehide` / `visibilitychange` 会来,而这两个时机里 async fetch 可能被浏览器掐掉,
   * 所以走 `navigator.sendBeacon`(见 `api.saveNoteBeacon`)。
   *
   * 副作用要自己收干净:beacon **拿不到响应**,编辑器手里的版本号因此会过期 ——
   * 回到前台后第一次保存就会误报"文件已被外部修改"。所以这里记下发出去的内容,
   * 并在 hidden → visible 时**静默对一次版本**(见下面那条 effect)。
   */
  const beaconTextRef = useRef<string | null>(null)
  useEffect(() => {
    const flush = (): void => {
      if (!dirtyRef.current) return
      const text = editorRef.current?.getDoc()
      if (text === undefined) return
      beaconTextRef.current = text
      saveNoteBeacon(sessionId, note.path, text, versionRef.current)
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [note.path, sessionId])

  /**
   * 回到前台时把版本号对齐(只在隐藏期间发过 beacon 时才做)。
   *
   * 磁盘内容 == 我们 beacon 写下去的内容 → 那是自己的写入,只需 adopt 新版本
   * (`dirty` 保持 true,后面继续保存);内容不同 → 不动,交给既有的冲突流程。
   */
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      const sent = beaconTextRef.current
      if (sent === null) return
      void (async () => {
        try {
          const loaded = await readNote(sessionId, note.path)
          if (sent === loaded.text) {
            versionRef.current = String(loaded.version)
            beaconTextRef.current = null
          }
        } catch {
          /* 读不到就留着,下次回到前台再试;真写不进去时会走冲突流程 */
        }
      })()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', onVisible)
    }
  }, [note.path, sessionId])

  /** 大纲点击 → 跳到该标题行。 */
  useEffect(() => {
    const target = props.jumpTo
    if (target === null || target === undefined) return
    editorRef.current?.scrollToLine(target.line)
  }, [props.jumpTo])

  /** 树右键「历史版本…」→ 弹出历史面板(信号按 nonce 触发一次)。 */
  useEffect(() => {
    if (props.historyRequest === null || props.historyRequest === undefined) return
    setHistoryOpen(true)
  }, [props.historyRequest])

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
    setLength(normalizedLength(conflict.text ?? ''))
  }, [conflict])

  /** 冲突:以本地内容覆盖(用磁盘版本作为前提)。 */
  const overwrite = useCallback(async () => {
    if (conflict === null) return
    versionRef.current = conflict.version
    dirtyRef.current = true
    setConflict(null)
    await save()
  }, [conflict, save])

  /**
   * 把磁盘上的新内容装进编辑器(**外部改动自动同步**),光标与滚动位置保留。
   *
   * `setDoc` 会触发 `onChange`(把 dirty 置 true、排一次 800ms 自动保存)—— 与既有
   * `reload()` 同一套路:紧接着把状态改回"干净、已同步",那次定时器到点会因为
   * `dirty === false` 直接返回,不会把刚读进来的内容又写回去。
   * @param text - 磁盘内容(LF 形态)。
   * @param version - 该内容的版本号。
   */
  const applyExternalText = useCallback(
    (text: string, version: string): void => {
      const editor = editorRef.current
      if (editor === null) return
      const head = editor.view.state.selection.main.head
      const scrollTop = editor.view.scrollDOM.scrollTop
      editor.setDoc(text)
      // 夹取再 dispatch:CM6 的 `Selection points outside of document` 是**硬抛错**
      // (项目里每一处 dispatch 都这么夹一次,别再漏)。
      const length = editor.view.state.doc.length
      editor.view.dispatch({ selection: { anchor: Math.max(0, Math.min(head, length)) } })
      if (scrollTop > 0) editor.view.scrollDOM.scrollTop = scrollTop
      versionRef.current = version
      dirtyRef.current = false
      setSaveState('saved')
      setConflict(null)
      setLength(normalizedLength(text))
      outlineRef.current?.(parseOutline(text))
      setNotice(t('editor.synced'))
    },
    [t],
  )

  /**
   * 外部改动(agent / Obsidian / 另一个窗口 / bash)自动同步。
   *
   * 判据是**磁盘版本号**(外壳每 1.5s 探一次,见 `NotesPane.probeExternal`),不是猜:
   * 与手里的一致就什么都不做。三种处理:
   *   - 编辑器**干净** → 静默重载(保留光标与滚动)—— 这就是"Typora 式"的立刻可见;
   *   - 有**未保存的编辑** → 只弹既有冲突横幅(重新载入 / 用我的覆盖),绝不静默覆盖输入;
   *   - 文件**不在了** → 常驻一条提示,不销毁编辑器。
   *
   * 两个"不要误报"的护栏(都是实测会踩的):
   *   1. 保存飞行中(`savingRef`)跳过 —— 那时磁盘版本已经变了、`versionRef` 还没跟上;
   *   2. 还有一次 beacon 写入没被认领(`beaconTextRef`)时跳过 —— 回到前台时那条
   *      hidden→visible 的静默对账会先把它 adopt 掉,不跳的话会把自己写的内容当外部改动。
   */
  useEffect(() => {
    if (props.active === false) return
    if (props.externalVersion === undefined) return
    if (status !== 'ready' || savingRef.current || beaconTextRef.current !== null) return
    if (props.externalVersion !== null && props.externalVersion === versionRef.current) {
      setGone(false)
      return
    }
    if (props.externalVersion === null) {
      setGone(true)
      return
    }
    const version = props.externalVersion
    setGone(false)
    if (dirtyRef.current || conflict !== null) {
      // 已经在为这个版本弹横幅了就别重复读盘
      if (conflict !== null && conflict.version === version) return
      void readNote(sessionId, note.path)
        .then((loaded) => setConflict({ version: String(loaded.version), text: loaded.text }))
        .catch(() => setConflict({ version, text: null }))
      return
    }
    void readNote(sessionId, note.path)
      .then((loaded) => {
        const loadedVersion = String(loaded.version)
        if (loadedVersion === versionRef.current) return
        // 读盘这段时间里用户可能已经开始打字/保存 → 转横幅,绝不覆盖
        if (dirtyRef.current || savingRef.current) {
          setConflict({ version: loadedVersion, text: loaded.text })
          return
        }
        applyExternalText(loaded.text, loadedVersion)
      })
      .catch(() => {
        /* 读不到就算了:下一 tick 会再试,不为一次抖动打扰用户 */
      })
  }, [applyExternalText, conflict, note.path, props.active, props.externalVersion, sessionId, status])

  /**
   * 冲突横幅里的「撤销这次外部改动」有没有可回退的历史?
   *
   * 进冲突态时查一次(便宜的一次 GET),**没有更早的状态就不显示这个按钮** ——
   * 宁可少一个按钮,也不要给一个点了必然报错的入口。
   */
  useEffect(() => {
    if (conflict === null) {
      setCanUndoExternal(false)
      setUndoConfirm(false)
      return undefined
    }
    let cancelled = false
    void fetchHistory(sessionId, note.id)
      .then((result) => {
        if (!cancelled) setCanUndoExternal(result.entries.length > 0)
      })
      .catch(() => {
        if (!cancelled) setCanUndoExternal(false)
      })
    return () => {
      cancelled = true
    }
  }, [conflict, note.id, sessionId])

  /**
   * 撤销这次外部改动:回到当前磁盘内容**之前**那一次观察到的状态。
   *
   * 语义在 Host 侧(`predecessorOf`:按 entry 的 `version` 找,不是"倒数第二条")——
   * agent 写前钩子记的那条带的正是**写之前的版本**,所以命中的就是"这次 agent 修改之前"。
   */
  const undoExternal = useCallback(async (): Promise<void> => {
    try {
      const result = await undoExternalChange(sessionId, note.id)
      applyExternalText(result.text, String(result.version))
      setUndoConfirm(false)
      setNotice(t('editor.undoExternalDone'))
    } catch (caught) {
      setUndoConfirm(false)
      setNotice(caught instanceof Error ? caught.message : String(caught))
    }
  }, [applyExternalText, note.id, sessionId, t])

  useEffect(() => {
    if (notice === null) return undefined
    const timer = window.setTimeout(() => setNotice(null), 3000)
    return () => window.clearTimeout(timer)
  }, [notice])

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

  /**
   * 执行一个工具栏命令。
   *
   * 顺手收起弹层:弹层与"直接生效"的命令是互斥的,留着它会挡住刚改过的正文。
   * 命令里抛错必须**看得见**:以前是静默的,用户只会看到"编辑器没反应/像卡住了",
   * 既没有提示也没有线索。
   */
  const apply = useCallback(
    (action: (handle: EditorHandle) => void) => {
      setPopover(null)
      const editor = editorRef.current
      if (editor === null) return
      try {
        action(editor)
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught)
        setError(t('editor.commandFailed').replace('{message}', message))
        // eslint-disable-next-line no-console
        console.error('[dsh-notes] 编辑器命令失败:', caught)
      }
    },
    [t],
  )

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
  const menuEntries = (snapshot: { from: number; to: number; table?: { from: number; to: number; row: number; col: number } }): MenuEntry[] => {
    const editor = editorRef.current
    if (editor === null) return []
    const text = editor.getDoc()
    // 表格内右键:先给"插行/插列/删行/删列"(Typora 的手感)
    if (snapshot.table !== undefined && snapshot.table.to > snapshot.table.from) {
      const spec = snapshot.table
      const run = (kind: 'rowAbove' | 'rowBelow' | 'colLeft' | 'colRight' | 'rowDelete' | 'colDelete'): (() => void) => () =>
        tableAction(spec.from, spec.to, spec.row, spec.col, kind)
      return [
        { id: 'tRowAbove', label: t('table.rowAbove'), action: run('rowAbove') },
        { id: 'tRowBelow', label: t('table.rowBelow'), action: run('rowBelow') },
        { id: 'tColLeft', label: t('table.colLeft'), action: run('colLeft') },
        { id: 'tColRight', label: t('table.colRight'), action: run('colRight') },
        { id: 'tSep', separator: true },
        { id: 'tRowDelete', label: t('table.rowDelete'), action: run('rowDelete') },
        { id: 'tColDelete', label: t('table.colDelete'), action: run('colDelete') },
      ]
    }
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

  /**
   * 表格操作(右键表内):插/删行与列**直接改源码**那一块表。
   *
   * 块计算是 `table-model.ts` 的纯函数 `applyTableAction`(有单测),这里只负责取块、
   * 派发、还焦点。**行号语义**:数据行 = `<tbody>` 内下标(0 = 第一个数据行),
   * 表头 = **-1** —— 见 `TableActionTarget.row` 的注释(旧代码拿节点在父元素里的下标当
   * 行号,`<thead>`/`<tbody>` 各自从 0 开始 → "删第一行"被当成删表头、"删第二行"删错行)。
   * @param from - 表格块起点(文档位置)。
   * @param to - 表格块终点。
   * @param rowIndex - 见上(表头 = -1)。
   * @param colIndex - 列下标(0 = 第一列,含表头行)。
   * @param kind - 动作。
   */
  const tableAction = useCallback(
    (from: number, to: number, rowIndex: number, colIndex: number, kind: TableActionKind) => {
      const editor = editorRef.current
      if (editor === null) return
      const view = editor.view
      const block = view.state.sliceDoc(from, to)
      const next = applyTableAction({ block, row: rowIndex, col: colIndex, kind })
      // null = 动不了(删表头 / 下标越界 / 块不成表):**不写文档**,也不改选区
      if (next === null) return
      view.dispatch({ changes: { from, to, insert: next } })
      view.focus()
      setMenu(null)
    },
    [],
  )

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
          <button
            type="button"
            className="dsh-notes-btn"
            title={t('editor.undo')}
            aria-label={t('editor.undo')}
            onClick={() => {
              // 没有编辑、但有"跳转历史"时,撤销 = 回到上一个笔记
              if (props.onBack?.() === true) return
              apply((e) => historyUndo(e.view))
            }}
          >
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
        </span>
        )}
        {/* 7 视图 + 保存:**整篇动作**,固定在右侧、不参与横向滚动。
            它们以前排在工具栏末尾 → 默认侧栏宽度下被挤出可视区(用户审计:工具栏 662/334,
            「预览/源码」与「保存」在屏幕外)。 */}
        {props.showToolbar === false ? null : (
          <span className="dsh-notes-toolbar dsh-notes-editor-actions">
            <button
              type="button"
              className="dsh-notes-btn"
              title={t('history.open')}
              aria-label={t('history.open')}
              disabled={status !== 'ready'}
              onClick={() => setHistoryOpen(true)}
            >
              <IconHistory />
            </button>
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
      {historyOpen ? (
        <HistoryPanel
          t={t}
          sessionId={sessionId}
          noteId={note.id}
          title={note.title}
          onClose={() => setHistoryOpen(false)}
          onRestored={(result) => {
            // 恢复本身就是一次写盘:把结果**直接装进编辑器**(不经过保存),
            // 否则 800ms 后自动保存又会把当前内容写回去。
            applyExternalText(result.text, result.version)
            setNotice(t('history.restored'))
          }}
        />
      ) : null}
      {gone ? (
        // 文件被移走/删掉:常驻一条提示(复用冲突条的样式,不新造一套视觉)。
        // 不销毁编辑器 —— 用户可能只是把它挪了个位置,回来了这条自动消失。
        <div className="dsh-notes-conflict">
          <IconWarn size={14} />
          <span className="dsh-notes-conflict-text">{t('editor.externalGone')}</span>
        </div>
      ) : null}
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
          {canUndoExternal ? (
            <button
              type="button"
              className={`dsh-notes-btn${undoConfirm ? ' dsh-notes-trash-danger' : ''}`}
              onClick={() => {
                // 二次确认:这一步会把编辑器内容换成"改动之前"的那一份,
                // 包括还没保存的编辑 —— 值得多点一下。
                if (!undoConfirm) {
                  setUndoConfirm(true)
                  return
                }
                void undoExternal()
              }}
            >
              {undoConfirm ? t('editor.undoExternalConfirm') : t('editor.undoExternal')}
            </button>
          ) : null}
        </div>
      ) : null}

      {status === 'failed' ? (
        <div className="dsh-notes-error">{error ?? t('editor.loadFailed')}</div>
      ) : (
        <div
          className="dsh-notes-editor-host"
          ref={hostRef}
          // 从左侧栏把笔记**拖进正文** = 在这里插入 `[[标题]]`(不是新开标签,
          // 也不能塞原始 id);拖到标签栏才是新开标签。
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('text/x-dsh-note-id')) {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
            }
          }}
          onDrop={(event) => {
            if (event.dataTransfer.getData('text/x-dsh-note-id') === '') return
            // **不自己插入**:CM6 自带的 drop 处理已经会用 text/plain(= `[[标题]]`)
            // 在落点插入一次;我们之前又手动插了一次 → 变成两份(用户实测"重复了")。
            // 这里只要阻止事件继续冒泡,免得 pane 层再开一个标签。
            event.stopPropagation()
          }}
          onContextMenu={(event) => {
            const editor = editorRef.current
            if (editor === null) return
            event.preventDefault()
            const range = editor.view.state.selection.main
            const cell = (event.target as HTMLElement | null)?.closest?.('.dsh-cm-table') as HTMLElement | null
            if (cell !== null && cell !== undefined) {
              const table = cell.tagName === 'TABLE' ? cell : (cell.closest('table') as HTMLElement | null)
              const tr = (event.target as HTMLElement).closest('tr')
              const tds = tr === null ? [] : [...tr.children]
              const index = tds.indexOf((event.target as HTMLElement).closest('td, th') as Element)
              setMenu({
                x: event.clientX,
                y: event.clientY,
                from: range.from,
                to: range.to,
                table: {
                  from: Number(table?.dataset.dshFrom ?? '0'),
                  to: Number(table?.dataset.dshTo ?? '0'),
                  // 行号语义:表头 = -1,数据行 = 它在 `<tbody>` 里的下标。
                  // 不能直接用"节点在父元素里的下标" —— `<thead>` 与 `<tbody>` 各自从 0 开始,
                  // 表头和第一个数据行都会是 0(旧代码就是这么错位的)。
                  row: tr === null || tr.parentElement?.tagName === 'THEAD'
                    ? -1
                    : [...(tr.parentElement?.children ?? [])].indexOf(tr),
                  col: index < 0 ? 0 : index,
                },
              })
              return
            }
            setMenu({ x: event.clientX, y: event.clientY, from: range.from, to: range.to })
          }}
        />
      )}

      {/* 状态条永远**一行**:窄了就省略(路径最先被截),完整内容放 title 里悬停看。
          以前会折成两行,在窄栏里看起来像个多余的小悬浮框。 */}
      <div className="dsh-notes-editor-status">
        <span className="dsh-notes-status-state" title={stateText}>
          {stateText}
        </span>
        <span className="dsh-notes-spacer" />
        <span className="dsh-notes-dim dsh-notes-status-chars" title={t('editor.chars').replace('{n}', String(length))}>
          {t('editor.chars').replace('{n}', String(length))}
        </span>
        <span className="dsh-notes-dim dsh-notes-mono dsh-notes-status-path" title={note.path}>
          {note.relPath}
        </span>
      </div>
    </div>
  )
}
