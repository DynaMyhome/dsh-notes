/**
 * 笔记区域的外壳(位置决定见下)。
 *
 * 布局:右侧栏「笔记」tab 内部自成分栏 —— [ 可收起的笔记树 | 编辑区 ]。
 * 中央对话与 composer 完全不动;树与编辑区都在本 tab 内,不新开 tab、不新开会话。
 *
 * P1:接索引(树 + 未归类 + 跨工作区映射)+ 新建笔记/分类 + 重扫;
 * P2 起把编辑区换成 CodeMirror 6。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'

import {
  call,
  createNotesDir,
  fetchFiles,
  fetchWorkspaces,
  openWorkspace,
  setActiveWorkspace,
  setNotesRoot,
  setScanRoots,
  statNotes,
  type WorkspaceInfo,
  fetchTrash,
  fetchTree,
  ignorePaths,
  importNote,
  includePaths,
  purgeTrash,
  restoreTrash,
  trashNote,
  type FileScan,
  type TrashEntry,
  type Tree,
  type TreeNote,
  type TreeRef,
  type TreeUnfiled,
} from './api'
import { EditorArea } from './EditorArea'
import { setSourceMode as applySourceMode } from './editor/mode'
import {
  activateTab,
  emptyLayout,
  loadLayout,
  migrateLayout,
  moveTab,
  openTab,
  pruneTabsForWorkspace,
  saveLayout,
  tabKeyOf,
  type LayoutState,
  type NoteTab,
} from './editor/tabs'
import {
  IconCollapse,
  IconExpand,
  IconInbox,
  IconNewFolder,
  IconNewNote,
  IconTrash,
} from './icons'
import { OutlinePane, type OutlineItem } from './OutlinePane'
import { QuickOpen } from './QuickOpen'
import { ScaleControl } from './ScaleControl'
import { readScale, scaleVars, writeScale } from './scale'
import { CandidatesPanel } from './CandidatesPanel'
import { relativeToRoot } from './browse-path'
import { TrashPane } from './TrashPane'
import { TreePane } from './TreePane'

/** 笔记树的宽度范围(px)。 */
const TREE_MIN = 160
/** 见 {@link TREE_MIN}。 */
const TREE_MAX = 420
/** 默认宽度(px):够看清层级,又不挤压编辑区。 */
const TREE_DEFAULT = 220
/**
 * 外部改动探针的间隔(毫秒)。
 *
 * 为什么是 1.5s(比树轮询的 4s 快):树轮询管的是"列表有没有变",这条管的是
 * **打开着的正文**有没有变 —— agent 改完要让用户"立刻看到"(照 Typora 的手感)。
 * 一次请求问完两栏所有打开标签,Host 侧只 `stat` 不读正文,所以这个频率是安全的。
 */
const EXTERNAL_POLL_MS = 1500

/** 槽位 props(只声明本组件真正用到的字段)。 */
export interface NotesPaneProps {
  /** 框架按注册时的 `locale` 注入的翻译函数。 */
  t: (key: string) => string
  /** 当前会话(决定工作区;右栏 tab 是 session 作用域)。 */
  sessionId?: string
  /**
   * 座位注入的 tab 信息钩子(`sidebar.right.pane.tab` 的 `hooks.tabInfo`)。
   *
   * 只读 `tab.visible` —— "这个正文此刻真的在显示吗"。tab 类型声明了
   * `keepMounted: true`(见 main.tsx):切到别的 tab 只是**隐藏**,组件不卸载,
   * 所以隐藏期间的后台活儿(4s 轮询)必须自己按这个标志停下。
   */
  useTabInfo?: () => { tab?: { visible?: boolean } }
  /**
   * 官方 Client 服务 `uiWorkspace`(可选)。
   *
   * **刻意用可选属性而不是硬依赖**:`dsh.client.inject` 里挂上它,最小组合里缺这个包时
   * 整个插件都起不来;而且本 profile 组合的是 `browse` 后端,`pickDirectory()` 本来就会被
   * `directory-picker/unavailable` 拒绝 —— 所以只用 `listDirectory`,拿不到就**藏起入口**
   * (官方对未知 capability 的口径就是"藏起可选项,而不是失败")。
   */
  uiWorkspace?: {
    /** 列一层目录(绝对路径;缺省 = Host 家目录)。 */
    listDirectory?: (path?: string, signal?: AbortSignal) => Promise<unknown>
  }
}

/** 新建输入条的两种模式。 */
type ComposeMode = 'note' | 'collection'

/**
 * 笔记区域外壳。
 * @param props - 槽位组合 props。
 */
export function NotesPane(props: NotesPaneProps): React.ReactElement {
  const t = props.t
  const sessionId = props.sessionId ?? ''
  /**
   * 本正文此刻是否真的在显示。
   *
   * **必须无条件调用**(和 `NotesChipTitle` 里那次一样):它内部是框架的订阅钩子,
   * 条件调用会打破 Hooks 的调用顺序。座位没注入时用常量兜底(单测/旧宿主)。
   */
  const readTabInfo = props.useTabInfo ?? ((): { tab?: { visible?: boolean } } => ({ tab: { visible: true } }))
  const visible = readTabInfo().tab?.visible ?? true
  const [treeOpen, setTreeOpen] = useState(true)
  const [treeWidth, setTreeWidth] = useState(TREE_DEFAULT)
  const [tree, setTree] = useState<Tree | null>(null)
  const [loading, setLoading] = useState(false)
  /** 面板根节点(键盘手势判断焦点在不在我们这里)。 */
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** 树的镜像(给 refresh 判断"是不是首次加载",不参与渲染)。 */
  const treeRef = useRef<Tree | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  /** 当前笔记区域在看哪个工作区(null = 会话自己的工作区)。 */
  const [workspaceKey, setWorkspaceKey] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [wsMenu, setWsMenu] = useState(false)
  const [wsDraft, setWsDraft] = useState('')
  /** 每栏的源码/预览模式:分屏时左边预览、右边源码是常态,所以按栏存。 */
  const [sourceModeByPane, setSourceModeByPane] = useState<Record<'p1' | 'p2', boolean>>({ p1: false, p2: false })
  /** 「这个工作区还没有笔记根」卡片:本会话内忽略(不写盘)。 */
  const [missingDismissed, setMissingDismissed] = useState(false)
  const [dirDraft, setDirDraft] = useState('')
  const [dirBusy, setDirBusy] = useState(false)

  /**
   * 标签/分栏布局(按工作区持久化;切换工作区各用各的)。
   *
   * 初值**不能**读 `workspaceKey` —— 那个 state 在上面还没声明,初始化器先跑会命中
   * TDZ(`Cannot access 'workspaceKey' before initialization`,实测整个面板渲染失败)。
   * 真实布局由下面 `[layoutKey]` 的 effect 挂载后立即载入。
   */
  const [layout, setLayoutState] = useState<LayoutState>(emptyLayout)
  /**
   * 工作区列表解析完之前**不碰布局**。
   *
   * 挂载瞬间还不知道工作区键,标签会先落在 `session` 键下;若这时就按 `session` 建标签、
   * 等键解析出来再按新键清理,标签会被整批误删(用户实测:"打开笔记几秒后自己关了")。
   */
  const [layoutReady, setLayoutReady] = useState(false)
  const [activePane, setActivePane] = useState<'p1' | 'p2'>('p1')
  /**
   * 工作区解析完了没有。
   *
   * 挂载后**先** `loadWorkspaces()`,再取树:`fetchTree` 带的是**模块级**
   * `activeWorkspaceKey`(见 api.ts),刚挂载时它可能还是上一个会话/工作区留下的值 ——
   * 抢跑一次不但白跑,还可能取到别的工作区的树。所以首次取树等这个闸门。
   */
  const [wsReady, setWsReady] = useState(false)
  /**
   * 新建笔记后等树刷新再打开它(创建响应只有 id,没有 path/title)。
   *
   * 用 **ref 而不是 state**:写它的地方(`startCreate` 的回调)与读它的地方(`refresh`)
   * 在同一条异步链上 —— `await call('create')` → 回调 → `await refresh()`,中间**不会**
   * 经过一次渲染,state 那时还没生效(旧代码读的就是这个初值 null,于是"＋ 建了笔记但不打开")。
   */
  const pendingOpenRef = useRef<string | null>(null)
  /** 笔记区的字号/图标微调系数(0.85–1.5;见 src/client/scale.ts)。 */
  const [scale, setScale] = useState<number>(() => readScale())
  /** 让**已挂载**的编辑器重量一次尺寸的信号:切回可见、或改了字号时 +1。 */
  const [measureNonce, setMeasureNonce] = useState(0)
  /**
   * 各标签的磁盘版本号(键 = 笔记绝对路径)。
   *
   * 只有**变化时**才替换这个对象(`probeExternal` 里做了 shallow-compare),否则
   * 1.5s 一次 setState 会让整个笔记区白重渲染一遍。
   */
  const [externalVersions, setExternalVersions] = useState<Record<string, string | null>>({})
  /**
   * 「打开历史面板」的信号(树右键 →「历史版本…」)。
   *
   * 历史面板住在**编辑器**里(恢复要直接落到编辑器内容上),所以这里只发意图:
   * 先把笔记打开,再用 nonce 把信号传下去 —— 与 `jumpTo` / `outlineMove` 同一套路。
   */
  const [historyRequest, setHistoryRequest] = useState<{ noteId: string; nonce: number } | null>(null)
  const layoutKey = workspaceKey ?? 'session'

  /** 布局与聚焦栏的镜像(键盘手势在事件里读最新值,不进依赖)。
   *  注意:必须声明在 `layout`/`activePane` **之后**(useRef 的初值会立刻读它们)。 */
  const layoutRef = useRef(layout)
  const activePaneRef = useRef(activePane)
  /**
   * 可见性镜像:轮询 effect 的事件里读最新值,**不要**把 `visible` 写进依赖 ——
   * 那会和 `refresh` 一样把定时器每次渲染重建(踩过的坑,见下面的 `refreshRef`)。
   */
  const visibleRef = useRef(visible)

  // 键盘手势读的是"最新值",用镜像而不是依赖(否则每渲染都要重挂监听)
  useEffect(() => {
    layoutRef.current = layout
  }, [layout])
  useEffect(() => {
    activePaneRef.current = activePane
  }, [activePane])


  const applyLayout = useCallback(
    (next: LayoutState) => {
      setLayoutState(next)
      saveLayout(layoutKey, next)
    },
    [layoutKey],
  )

  // 切换工作区 → 换一套布局(各自独立,互不干扰)
  useEffect(() => {
    if (!layoutReady) return
    const loaded = typeof window === 'undefined' ? emptyLayout() : loadLayout(layoutKey)
    setLayoutState(loaded)
    setActivePane(loaded.activePane)
  }, [layoutKey, layoutReady])

  /** 当前栏 + 当前标签(其余都是派生值,方便老代码继续用 `selected`)。 */
  const currentPane = layout.panes.find((item) => item.id === activePane) ?? layout.panes[0]
  const activeTab: NoteTab | null = currentPane?.tabs.find((tab) => tab.key === currentPane.active) ?? null
  /**
   * 工作区相对路径。
   *
   * 先看标签自己存的(新开的标签有),再回落到**树里的那条**(树总是带 relPath),
   * 都没有才用绝对路径 —— 引用载荷要的是相对路径,而老布局里的标签没有这个字段。
   */
  const relPathOf = (tab: NoteTab): string =>
    tab.relPath !== undefined && tab.relPath !== '' ? tab.relPath : (tree?.notes.find((item) => item.id === tab.noteId)?.relPath ?? tab.path)
  const selected: TreeNote | null =
    activeTab !== null && activeTab.ref !== true
      ? { id: activeTab.noteId, title: activeTab.title, path: activeTab.path, relPath: relPathOf(activeTab), collectionId: null, pinned: false }
      : null
  const selectedRef: TreeRef | null =
    activeTab !== null && activeTab.ref === true
      ? {
          noteId: activeTab.noteId,
          title: activeTab.title,
          path: activeTab.path,
          relPath: relPathOf(activeTab),
          workspaceKey: activeTab.workspaceKey,
          workspaceName: '',
          collectionId: null,
        }
      : null

  /** 打开一篇笔记:`reuse` 替换当前标签 / `tab` 新标签 / `split` 进第 2 栏。 */
  /** 每个标签的"跳转历史"(tabKey → 走过的 noteId):撤销用它回到上一个笔记。 */
  const tabHistory = useRef<Record<string, string[]>>({})

  const openNote = useCallback(
    (note: TreeNote, mode: 'reuse' | 'tab' | 'split' = 'reuse', ref?: TreeRef, pane?: 'p1' | 'p2') => {
      const tab: NoteTab = {
        key: tabKeyOf(layoutKey, note.id),
        workspaceKey: ref?.workspaceKey ?? layoutKey,
        noteId: note.id,
        path: note.path,
        relPath: ref?.relPath ?? note.relPath,
        title: note.title,
        ...(ref === undefined ? {} : { ref: true as const }),
      }
      const targetPane = pane ?? (mode === 'split' ? 'p2' : activePane)
      // 同一个标签换到**另一篇笔记**(点 `[[链接]]` 跳转等)→ 记住从哪来:
      // 新那篇什么都没编辑,撤销就该回到上一篇。
      if (mode === 'reuse' && ref === undefined) {
        const current = layoutRef.current.panes.find((item) => item.id === targetPane)
        const open = current?.tabs.find((item) => item.key === current.active)
        if (open !== undefined && open.noteId !== note.id) {
          // **注意 key 里含 noteId**:reuse 之后这个标签的 key 会变,所以历史要记到
          // **新的 key** 上(并把旧 key 的栈带过来),否则撤销时按新 key 查是空的 ——
          // 这正是"点回退没反应"的原因。
          const nextKey = `${layoutKey}:${note.id}`
          const stack = [...(tabHistory.current[open.key] ?? []), open.noteId]
          tabHistory.current[nextKey] = stack
          if (open.key !== nextKey) delete tabHistory.current[open.key]
        }
      }
      setLayoutState((current) => {
        // 同栏已经开着这篇 → 激活它,不再开一个重复标签(＋ 点两下不该出两个一样的)
        const opened = current.panes.find((item) => item.id === targetPane)?.tabs.find((item) => item.key === tab.key)
        if (mode === 'tab' && opened !== undefined) {
          const activated = activateTab(current, tab.key)
          saveLayout(layoutKey, activated)
          return activated
        }
        const next = openTab(current, tab, { mode, pane: targetPane })
        saveLayout(layoutKey, next)
        return next
      })
      setActivePane(targetPane)
    },
    [activePane, layoutKey],
  )

  /**
   * 在某一栏的指定位置打开一篇笔记(从左侧栏**拖进来**时用)。
   * @param noteId - 笔记 id。
   * @param pane - 目标栏。
   * @param index - 插入位置(拖到标签右半就用它后面的位置)。
   */
  const openNoteAt = useCallback(
    (noteId: string, pane: 'p1' | 'p2', index: number) => {
      const note = tree?.notes.find((item) => item.id === noteId)
      if (note === undefined) return
      openNote(note, 'tab', undefined, pane)
      // openNote 落在末尾,再按落点把它挪到指定位置
      setLayoutState((current) => {
        const next = moveTab(current, tabKeyOf(layoutKey, noteId), { pane, index })
        if (next === current) return current
        saveLayout(layoutKey, next)
        return next
      })
    },
    [layoutKey, openNote, tree],
  )

  /** 树右键「历史版本…」:先打开这篇笔记,再让那一栏的编辑器把历史面板弹出来。 */
  const openHistoryFor = useCallback(
    (note: TreeNote) => {
      openNote(note, 'reuse')
      setHistoryRequest((current) => ({ noteId: note.id, nonce: (current?.nonce ?? 0) + 1 }))
    },
    [openNote],
  )

  /**
   * 老代码里的 `setSelected(null)` = 清空编辑区;`setSelected(note)` = 在当前标签打开它。
   * 保留这个薄壳可以让生命周期/删除/改名那些分支不用改。
   */
  const setSelected = useCallback(
    (next: TreeNote | null) => {
      if (next === null) {
        applyLayout(emptyLayout())
        return
      }
      openNote(next, 'reuse')
    },
    [applyLayout, openNote],
  )

  /** 树刷新后:把标签的标题/路径同步成新的,并把索引里没有的笔记摘掉。 */
  /**
   * 树刷新后同步标签:更新标题/路径,并清掉"确实已不在这个工作区"的标签。
   *
   * 三道守卫(缺一条就会出现"笔记自己关了"):① 布局还没就绪 → 不动;
   * ② 拿到的树**属于别的工作区** → 不动;③ 只删"标签自己的工作区 === 当前工作区、
   * 且该工作区笔记列表里没有它"的标签(`pruneTabsForWorkspace`,ref 标签永不因此被删)。
   * 另外:内容没变就**原样返回**,避免每 4s 轮询都写一次 localStorage + 重渲染。
   */
  const syncLayout = useCallback(
    (next: Tree) => {
      setLayoutState((current) => {
        if (!layoutReady) return current
        if (next.workspace?.key !== undefined && layoutKey !== 'session' && next.workspace.key !== layoutKey) {
          return current
        }
        const renamed = {
          ...current,
          panes: current.panes.map((pane) => ({
            ...pane,
            tabs: pane.tabs.map((tab) => {
              if (tab.ref === true) return tab
              const note = next.notes.find((item) => item.id === tab.noteId)
              // 顺带把老布局缺的 relPath 补上(引用载荷要用工作区相对路径)
              return note === undefined ? tab : { ...tab, title: note.title, path: note.path, relPath: note.relPath }
            }),
          })),
        }
        const pruned = pruneTabsForWorkspace(
          renamed,
          layoutKey,
          next.notes.map((note) => note.id),
        )
        if (JSON.stringify(pruned) === JSON.stringify(current)) return current
        saveLayout(layoutKey, pruned)
        return pruned
      })
    },
    [layoutKey, layoutReady],
  )
  const [compose, setCompose] = useState<ComposeMode | null>(null)
  /** 新建时的目标分类(右键「在此新建」/ 工具栏 ＋ 用)。 */
  const [composeParent, setComposeParent] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  /** 左列的两个标签页:文件树 / 大纲(Typora 的两个侧栏页)。 */
  const [panelTab, setPanelTab] = useState<'files' | 'outline'>('files')
  /** 当前笔记的标题树(由编辑器回传)。 */
  const [outline, setOutline] = useState<OutlineItem[]>([])
  /** 光标行(大纲高亮当前小节)。 */
  const [cursorLine, setCursorLine] = useState<number | null>(null)
  /** 大纲跳转请求(nonce 变化触发一次)。 */
  const [jump, setJump] = useState<{ line: number; nonce: number }>({ line: 1, nonce: 0 })
  /** 快速打开(Ctrl/Cmd+P、Ctrl/Cmd+K;仅当焦点在笔记区域内)。 */
  const [quickOpen, setQuickOpen] = useState(false)

  /** 快速打开是从哪一栏点的(＋在每栏各有一个,笔记要开在那一栏)。 */
  const [quickOpenPane, setQuickOpenPane] = useState<'p1' | 'p2'>('p1')
  /** 回收站面板与清单。 */
  const [trashOpen, setTrashOpen] = useState(false)
  /** 纳入管理面板:三类分类的扫描结果(候选/杂项/统计)。 */
  const [filesOpen, setFilesOpen] = useState(false)
  const [filesScan, setFilesScan] = useState<FileScan | null>(null)
  const [filesLoading, setFilesLoading] = useState(false)
  const [filesError, setFilesError] = useState<string | null>(null)
  const [trashEntries, setTrashEntries] = useState<TrashEntry[]>([])
  const [trashRoot, setTrashRoot] = useState('')
  const [trashLoading, setTrashLoading] = useState(false)
  /** 正在行内改名的行 key(`n:<id>` / `c:<id>`)。 */
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  /**
   * 创建即改名(Obsidian 手感):先建成默认名,再让那一行进入行内改名。
   * 取消改名不删文件,保持默认名(与 Obsidian 一致)。
   */
  const startCreate = (
    (kind: 'note' | 'collection'): void => {
      if (kind === 'note') {
        run('create', { title: t('status.untitled'), collectionId: selected?.collectionId ?? null }, (note?: { id?: string }) => {
          if (typeof note?.id === 'string') {
            pendingOpenRef.current = note.id
            setRenamingKey(`n:${note.id}`)
          }
        })
        return
      }
      run('collection', { op: 'create', name: t('status.newCollection'), parentId: null }, (created?: { id?: string }) => {
        if (typeof created?.id === 'string') setRenamingKey(`c:${created.id}`)
      })
    },
  )
  /** 行内改名的提交与取消。 */
  const commitNoteRename = (
    (noteId: string, title: string): void => {
      setRenamingKey(null)
      void run('rename', { noteId, title })
    },
  )
  const commitCollectionRename = (
    (id: string, name: string): void => {
      setRenamingKey(null)
      void run('collection', { op: 'rename', collectionId: id, name })
    },
  )
  /** 大纲拖拽重排章节的请求(nonce 变化触发一次)。 */
  const [outlineMove, setOutlineMove] = useState<{
    fromLine: number
    toLine: number
    mode: 'before' | 'after'
    nonce: number
  } | null>(null)
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  /** 拉一次树(force 会走一遍目录;平时都用非 force —— Host 侧只读缓存)。 */
  const refresh = useCallback(
    async (force = false): Promise<Tree | null> => {
      if (sessionId === '') return null
      // 只有"还没有树"时才显示加载态:轮询每 4s 来一次,老树还在的时候置 loading
      // 会让左侧栏顶部那行**每 4 秒闪一下**(实测的闪烁就是这么来的)。
      if (!force && treeRef.current === null) setLoading(true)
      try {
        const next = await fetchTree(sessionId, force)
        treeRef.current = next
        setTree(next)
        setError(null)
        syncLayout(next)
        const pending = pendingOpenRef.current
        if (pending !== null) {
          const created = next.notes.find((note) => note.id === pending)
          if (created !== undefined) {
            pendingOpenRef.current = null
            openNote(created, 'reuse')
          }
        }
        return next
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
        return null
      } finally {
        if (!force) setLoading(false)
      }
    },
    // 依赖必须**写全**:早先只写 `[sessionId]`,于是 `refresh` 里调的 `syncLayout` 是
    // "layoutReady 还是 false"那一帧的旧闭包(它每次都直接 `return current`)→ 改名后
    // 标签标题/路径永不更新、自动保存打到不存在的文件(实测 Host 报 NOT_FOUND)。
    // 轮询/可见性/focus 那些监听仍然走 `refreshRef.current`,所以重建回调不会重建定时器。
    [openNote, sessionId, syncLayout],
  )

  /** 把扫描报告拼成一句人话 —— 「重新扫描」按钮到底干了什么,回显给用户。 */
  const describeScan = useCallback(
    (next: Tree | null): string => {
      const report = next?.scanReport
      if (report === null || report === undefined) return t('status.rescanned')
      const text = t('status.rescanReport')
        .replace('{scanned}', String(report.scanned))
        .replace('{rebound}', String(report.rebound))
        .replace('{dropped}', String(report.dropped))
        .replace('{unfiled}', String(report.unfiled))
      return report.truncated ? `${text} · ${t('status.rescanTruncated')}` : text
    },
    [t],
  )

  /**
   * 最新的 `refresh`(**不要**直接把它写进下面两个 effect 的依赖里)。
   *
   * 踩过的坑:轮询 effect 依赖 `refresh`,而 `refresh` 的依赖链里(经 `openNote`)
   * 有宿主每次渲染都新建的东西 —— 于是**宿主侧边栏一重渲染,定时器就被清掉重建**,
   * 只要重渲染比 4s 更频繁,轮询就永远等不到那一次 tick(实测:10 秒 0 个请求,
   * 表现为"外部改动不刷新、每几秒闪一下")。
   */
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  /**
   * 探一次"打开着的笔记,磁盘版本变了没有"。
   *
   * 只 stat(不读正文),一次请求问完**两栏所有打开标签**;结果只在真的变了时才
   * setState(shallow-compare),否则 1.5s 一次会让整个笔记区白重渲染。
   * 失败静默:外部改动同步是锦上添花,不为一次网络抖动弹错。
   */
  const probeExternal = useCallback((): void => {
    if (document.visibilityState !== 'visible') return
    if (!visibleRef.current) return
    const paths = [
      ...new Set(
        layoutRef.current.panes
          .flatMap((pane) => pane.tabs.map((tab) => tab.path))
          .filter((path) => path !== undefined && path !== ''),
      ),
    ]
    if (paths.length === 0) return
    void statNotes(sessionId, paths)
      .then((versions) => {
        setExternalVersions((current) => {
          const keys = Object.keys(versions)
          if (keys.length === Object.keys(current).length && keys.every((key) => current[key] === versions[key])) {
            return current
          }
          return versions
        })
      })
      .catch(() => {
        /* 静默:下一 tick 再试 */
      })
  }, [sessionId])

  /**
   * 探针的最新闭包(**不要**把它写进定时器 effect 的依赖里 —— 与 `refreshRef` 同一个坑:
   * 宿主每次重渲染都会新建它,写进依赖就等于每次渲染重建定时器,永远等不到 tick)。
   */
  const probeRef = useRef(probeExternal)
  useEffect(() => {
    probeRef.current = probeExternal
  }, [probeExternal])

  // 首次取树:等工作区解析完再拉(只做一次;见上面 `wsReady` 的注释)。
  // 依赖 `sessionId` 是为了换会话后重新取一次树 —— 那时 `wsReady` 会被上面的
  // loadWorkspaces effect 先置回 false,所以不会抢跑。
  useEffect(() => {
    if (!wsReady) return
    void refreshRef.current()
  }, [wsReady, sessionId])

  /**
   * 可见性变化:从"没在显示"变回"正在显示"时补一次对账 + 让编辑器重量尺寸。
   *
   * 轮询在隐藏期间是停的(见下面 effect),所以外部改动(Agent / Obsidian)不能等
   * 下一个 4s 才出现;切回来立刻对一次账,并让隐藏期间量成 0 的 CodeMirror 重新量。
   * 可见性由 `keepMounted`(main.tsx)带来:切 tab 不再卸载,改由这里接管时机。
   */
  useEffect(() => {
    const previous = visibleRef.current
    visibleRef.current = visible
    if (previous === visible || !visible) return
    void refreshRef.current()
    // 隐藏期间探针也是停的 —— 切回来立刻补一次,别等下一个 1.5s
    probeRef.current()
    setMeasureNonce((value) => value + 1)
  }, [visible])

  /** 改字号/图标大小:夹取 + 落盘 + 让编辑器重量尺寸(字变了行高也变)。 */
  const applyScale = useCallback((next: number) => {
    setScale(writeScale(next))
    setMeasureNonce((value) => value + 1)
  }, [])

  // 回到这个窗口时对一次账(外部改名/删除不必等手动刷新)
  useEffect(() => {
    const onFocus = (): void => {
      void refreshRef.current()
      probeRef.current()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  /**
   * 键盘:聚焦在笔记面板里时 `Ctrl/Cmd+PageUp/PageDown` 在栏间循环;
   * 加 `Shift` 则把**当前标签搬到另一栏**(Pane Relief 的标准手势,比自定义键更合肌肉记忆)。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== 'PageUp' && event.key !== 'PageDown') return
      const root = rootRef.current
      if (root === null || root.contains(document.activeElement) === false) return
      if (layoutRef.current.panes.length < 2) return
      event.preventDefault()
      const layout = layoutRef.current
      const tab = layout.panes.find((pane) => pane.id === activePaneRef.current)?.tabs.find((item) => item.key === layout.panes.find((pane) => pane.id === activePaneRef.current)?.active)
      if (event.shiftKey && tab !== undefined) {
        const other = activePaneRef.current === 'p1' ? 'p2' : 'p1'
        setLayoutState((current) => {
          const next = moveTab(current, tab.key, { pane: other })
          if (next === current) return current
          saveLayout(layoutKey, next)
          return next
        })
        setActivePane(other)
        return
      }
      setActivePane((current) => (current === 'p1' ? 'p2' : 'p1'))
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [layoutKey])

  // 轻量轮询:Host 侧的监视器(debounce 400ms)会把外部改动对完账并更新缓存,
  // 但服务端没有推送通道,所以这里只拉**便宜**的 tree(不触发扫描)来接住它。
  // 页面不可见、或**这个 tab 没在显示**时停掉,不打扰(tab 声明了 keepMounted,
  // 隐藏后组件还活着,不门控的话会在后台一直轮询)。定时器**只挂一次**,不随渲染重建。
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (!visibleRef.current) return
      void refreshRef.current()
    }, 4000)
    return () => window.clearInterval(timer)
  }, [])

  // 外部改动探针(1.5s):只问"打开着的正文,磁盘版本变了没有"。树轮询(4s)管的是列表,
  // 正文变了它不会管;而 agent 改完要"立刻看到"。定时器同样**只挂一次**,门控在
  // `probeExternal` 内部(页面可见 + 这个 tab 在显示 + 有打开的标签才发请求)。
  useEffect(() => {
    const timer = window.setInterval(() => probeRef.current(), EXTERNAL_POLL_MS)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (compose !== null && inputRef.current !== null) {
      // 每次打开都把输入框清空;输入框是**非受控**的,提交时直接读 DOM ——
      // 自动输入/输入法(insertText)不一定触发 React 的 onChange,受控绑定会把
      // 已经敲进去的字吞掉(实测:回车/确定拿到的是空标题)。
      inputRef.current.value = ''
      inputRef.current.focus()
    }
  }, [compose])

  // 取消的三条路:点到别处 / Escape / ×。抓 pointerdown 而不是 click,
  // 这样点树里的行时输入条先收起、行的点击照常生效。
  useEffect(() => {
    if (compose === null) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null
      if (target !== null && target.closest('.dsh-notes-compose') !== null) return
      setCompose(null)
      setDraft('')
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [compose])

  /** 跑一条写路由,成功后刷新。 */
  const run = useCallback(
    async (action: string, payload: Record<string, unknown>, done?: (value: any) => void) => {
      if (busy) return
      // 没有会话 = 没有工作区;宁可什么都不做,也不能把写请求发成空 payload
      // (Host 侧现在也会拒绝,这里是第一道闸)。
      if (sessionId === '') {
        setError(t('status.noSession'))
        return
      }
      setBusy(true)
      // 新动作开始就清掉上一次的红字(否则失败信息会一直挂着,像还在报错)
      setError(null)
      try {
        const value = await call(action, { sessionId, ...payload })
        done?.(value)
        // 非 force:Host 侧已就地修正过分类缓存(见 syncClassificationCache),
        // 这里再走一遍目录纯属浪费(大工作区一次好几秒)。
        await refresh()
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setBusy(false)
      }
    },
    [busy, refresh, sessionId, t],
  )

  /** 提交新建输入条(标题以 DOM 为准 —— 不信 React state,也不只信一个 ref)。 */
  const submitCompose = useCallback(async () => {
    const domValue = (document.querySelector('.dsh-notes-input') as HTMLInputElement | null)?.value
    const text = String(domValue ?? inputRef.current?.value ?? draft).trim()
    if (text === '' || compose === null) {
      setCompose(null)
      setDraft('')
      return
    }
    if (compose === 'note') {
      await run('create', { title: text, collectionId: composeParent }, (note) => {
        setSelected(note)
        setStatus(t('status.created'))
      })
    } else {
      await run('collection', { op: 'create', name: text, parentId: composeParent }, () => setStatus(t('status.collectionCreated')))
    }
    setCompose(null)
    setDraft('')
  }, [compose, composeParent, draft, run, t])

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture?.(event.pointerId)
      drag.current = { startX: event.clientX, startWidth: treeWidth }
      event.preventDefault()
    },
    [treeWidth],
  )

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (state === null) return
    setTreeWidth(Math.min(TREE_MAX, Math.max(TREE_MIN, state.startWidth + (event.clientX - state.startX))))
  }, [])

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }, [])

  /** 未归类文件:点一下就纳入笔记树(P1 的最省事整理动作)。 */
  const onFileAction = useCallback(
    (file: TreeUnfiled) => {
      void run('register', { path: file.path }, () => setStatus(t('status.registered')))
    },
    [run, t],
  )

  /** 右键「在此新建笔记 / 新建子分类」。 */
  const startCompose = useCallback((mode: ComposeMode, parentId: string | null) => {
    setTreeOpen(true)
    setPanelTab('files')
    setComposeParent(parentId)
    setCompose(mode)
    setDraft('')
  }, [])

  /** 置顶 / 取消置顶。 */
  const onPin = useCallback(
    (note: TreeNote, pinned: boolean) => {
      void run('pin', { noteId: note.id, pinned }, () => setStatus(pinned ? t('status.pinned') : t('status.unpinned')))
    },
    [run, t],
  )

  /** 移出笔记树(只删索引,永不删文件)。 */
  const onUnregister = useCallback(
    (note: TreeNote) => {
      void run('unregister', { noteId: note.id }, () => setStatus(t('status.unregistered')))
    },
    [run, t],
  )

  /**
   * 切到某个已登记工作区(`null` = 回到会话自己的工作区)。
   *
   * 先改 api 层的活跃工作区(之后所有读写都带上它),清掉与旧工作区绑定的界面状态,
   * 再重新取树 —— 打开着的笔记属于旧工作区,必须一起清掉。
   */
  const applyWorkspace = useCallback(
    (key: string | null) => {
      setActiveWorkspace(key)
      setWorkspaceKey(key)
      setWsMenu(false)
      setMissingDismissed(false)
      setDirDraft('')
      // 不在这里清空调布局:每个工作区有自己的标签布局(layoutKey 变化时由 effect 载入),
      // 切回来时应该看到原来的标签,而不是被清空。
      setFilesScan(null)
      if (sessionId !== '') {
        try {
          if (key === null) window.localStorage.removeItem(`dsh-notes:ws:${sessionId}`)
          else window.localStorage.setItem(`dsh-notes:ws:${sessionId}`, key)
        } catch {
          /* 隐私模式等:存不了就算了 */
        }
      }
      void refresh(true)
    },
    [refresh, sessionId],
  )

  /** 创建缺失的笔记根(只创建这一个目录,永不删除/覆盖)。 */
  const createMissingDir = useCallback(async () => {
    if (sessionId === '') return
    setDirBusy(true)
    setError(null)
    try {
      const result = await createNotesDir(sessionId)
      setStatus(t('status.notesDirCreated').replace('{p}', result.path))
      setMissingDismissed(true)
      await refresh(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setDirBusy(false)
    }
  }, [refresh, sessionId, t])

  /** 把工作区里已有目录设为笔记根(必须是已存在的目录)。 */
  const applyNotesRoot = useCallback(
    async (path: string) => {
      if (sessionId === '' || path.trim() === '') return
      setDirBusy(true)
      setError(null)
      try {
        const result = await setNotesRoot(sessionId, path.trim())
        setStatus(t('status.notesRootSet').replace('{p}', result.notesRoot))
        setMissingDismissed(true)
        setDirDraft('')
        await refresh(true)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setDirBusy(false)
      }
    },
    [refresh, sessionId, t],
  )

  /** 载入已登记工作区列表(并恢复上次选择)。 */
  const loadWorkspaces = useCallback(async (): Promise<WorkspaceInfo[]> => {
    if (sessionId === '') return []
    try {
      const result = await fetchWorkspaces(sessionId)
      setWorkspaces(result.workspaces)
      let saved: string | null = null
      try {
        saved = window.localStorage.getItem(`dsh-notes:ws:${sessionId}`)
      } catch {
        saved = null
      }
      // 没有(或失效的)上次选择 → 用**会话自己的工作区**,并且始终落到"真实键"上:
      // 挂载瞬间标签会先存在 `session` 键下(那时还不知道工作区),这里把它迁过去。
      // (失效的键就这样被覆盖掉,不需要单独清理 —— 以前那段 `else if (saved !== null)`
      //  永远不可达,因为上一行已经保证 `saved !== null` 才进得来。)
      if (saved === null || !result.workspaces.some((item) => item.key === saved)) saved = result.current
      if (saved !== null) {
        migrateLayout('session', saved)
        setActiveWorkspace(saved)
        setWorkspaceKey(saved)
      }
      return result.workspaces
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      return []
    }
  }, [sessionId])

  useEffect(() => {
    // 解析完工作区(可能带上次选择)再放行布局,避免用 `session` 键建标签;
    // 同时给「首次取树」开门 —— 换会话时先关上,免得拿上一个会话的工作区键抢跑。
    setWsReady(false)
    void loadWorkspaces().finally(() => {
      setLayoutReady(true)
      setWsReady(true)
    })
  }, [loadWorkspaces])

  /** 打开一个绝对路径作为工作区(登记后切过去)。 */
  const openWorkspaceRoot = useCallback(
    async (root: string) => {
      if (sessionId === '' || root.trim() === '') return
      setBusy(true)
      try {
        const info = await openWorkspace(sessionId, root.trim())
        await loadWorkspaces()
        applyWorkspace(info.key)
        setStatus(t('status.workspaceOpened').replace('{p}', info.name))
        setWsDraft('')
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setBusy(false)
      }
    },
    [applyWorkspace, loadWorkspaces, sessionId, t],
  )

  /** 读一次三类分类(打开面板 / 重扫 / 操作完之后)。 */
  const loadFiles = useCallback(
    async (force = false): Promise<void> => {
      if (sessionId === '') return
      setFilesLoading(true)
      setFilesError(null)
      try {
        const result = await fetchFiles(sessionId, { force })
        setFilesScan(result)
      } catch (caught) {
        setFilesError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setFilesLoading(false)
      }
    },
    [sessionId],
  )

  // 分块续扫:Host 一趟走不完(done=false)会把队列前沿留着,这里持续拉直到走完。
  // 每次调用最多走 walkBudgetMs(默认 4s),所以界面不会长时间没反应 —— 列表是长出来的。
  useEffect(() => {
    if (!filesOpen || filesScan?.scanning !== true) return undefined
    const timer = window.setTimeout(() => void loadFiles(), 1200)
    return () => window.clearTimeout(timer)
  }, [filesOpen, filesScan, loadFiles])

  /** 改扫描范围(默认只有 notesDir;要看别处得显式加,见 setScanRoots 注释)。 */
  const onScanRoots = useCallback(
    (roots: string[]) => {
      if (sessionId === '') return
      void (async () => {
        try {
          await setScanRoots(sessionId, roots)
          await loadFiles(true)
        } catch (caught) {
          setFilesError(caught instanceof Error ? caught.message : String(caught))
        }
      })()
    },
    [loadFiles, sessionId],
  )

  /** 打开「纳入管理」面板(第一次打开走 TTL;过期的缓存 Host 侧会后台刷新)。 */
  const onOpenCandidates = useCallback(() => {
    setFilesOpen(true)
    void loadFiles()
  }, [loadFiles])

  /**
   * 目录选择器选中一个**绝对路径** → 换算成工作区相对再加进扫描范围。
   *
   * 两边都校验:这里换算只是为了让用户立刻看到人话报错(Host 的
   * `service.setScanRoots` 还会再拦一次越界,是真正的边界)。
   */
  const onPickRoot = useCallback(
    (absolutePath: string) => {
      const root = filesScan?.workspace.root ?? tree?.workspace.root ?? ''
      const mapped = relativeToRoot(root, absolutePath)
      if (!mapped.ok) {
        setFilesError(t('files.pickOutside'))
        return
      }
      // 选到工作区根 = 「整个工作区」,与那个按钮同义
      if (mapped.rel === '') {
        onScanRoots([''])
        setStatus(t('status.rootAdded').replace('{p}', t('files.wholeWorkspace')))
        return
      }
      const existing = filesScan?.scanRoots ?? []
      if (existing.includes(mapped.rel)) {
        void loadFiles(true)
        return
      }
      onScanRoots([...existing, mapped.rel])
      setStatus(t('status.rootAdded').replace('{p}', mapped.rel))
    },
    [filesScan, loadFiles, onScanRoots, t, tree],
  )

  /** 纳入选中的 md → 重新读树(纳入后它们会出现在笔记树里)。 */
  const onIncludeFiles = useCallback(
    async (paths: string[]) => {
      if (sessionId === '' || paths.length === 0) return
      setBusy(true)
      try {
        const result = await includePaths(sessionId, paths)
        await refresh()
        await loadFiles(true)
        setStatus(
          result.failed.length === 0
            ? t('status.included').replace('{n}', String(result.included.length))
            : t('status.includedSome')
                .replace('{n}', String(result.included.length))
                .replace('{m}', String(result.failed.length)),
        )
      } catch (caught) {
        setFilesError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setBusy(false)
      }
    },
    [loadFiles, refresh, sessionId, t],
  )

  /**
   * 标记/放回「杂项」。带回**撤销**:忽略 → 撤销就是放回候选,反之亦然
   * (误点忽略是用户明确提过的场景,一定要能一步退回来)。
   */
  const onIgnoreFiles = useCallback(
    async (payload: { paths?: string[]; globs?: string[]; on?: boolean }) => {
      if (sessionId === '') return
      const on = payload.on !== false
      setBusy(true)
      try {
        await ignorePaths(sessionId, payload)
        await loadFiles(true)
        const count = (payload.paths?.length ?? 0) + (payload.globs?.length ?? 0)
        setStatus(on ? t('status.ignored').replace('{n}', String(count)) : t('status.unignored').replace('{n}', String(count)))
      } catch (caught) {
        setFilesError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setBusy(false)
      }
    },
    [loadFiles, sessionId, t],
  )

  /** 「移出并忽略」:移出笔记树 + 标为杂项(以后不再出现在候选里)。 */
  const onUnregisterIgnore = useCallback(
    (note: TreeNote) => {
      setBusy(true)
      void (async () => {
        try {
          await call('unregister', { sessionId, noteId: note.id })
          await ignorePaths(sessionId, { paths: [note.relPath] })
          if (selected?.id === note.id) {
            setSelected(null)
          }
          await refresh()
          if (filesOpen) await loadFiles(true)
          setStatus(t('status.unregisteredIgnored').replace('{p}', note.title))
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
          setBusy(false)
        }
      })()
    },
    [filesOpen, loadFiles, refresh, selected, sessionId, t],
  )

  /** 读一次回收站清单。 */
  const refreshTrash = useCallback(async () => {
    setTrashLoading(true)
    try {
      const result = await fetchTrash(sessionId)
      setTrashEntries(result.entries)
      setTrashRoot(result.root)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setTrashLoading(false)
    }
  }, [])

  /**
   * 删除笔记 → **移入回收站**(文件不真删,可恢复)。这是 AGENTS.md「永不删用户的 .md」
   * 在用户显式动作下的例外:先把文件挪进回收站,只有「彻底删除」才 unlink。
   */
  const onTrash = useCallback(
    (note: TreeNote) => {
      if (sessionId === '') {
        setError(t('status.noSession'))
        return
      }
      setBusy(true)
      void (async () => {
        try {
          await trashNote(sessionId, note.id)
          if (selected?.id === note.id) {
            setSelected(null)
          }
          setStatus(t('status.trashed').replace('{p}', note.title))
          await refresh(true)
          if (trashOpen) await refreshTrash()
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
          setBusy(false)
        }
      })()
    },
    [refresh, refreshTrash, selected, sessionId, t, trashOpen],
  )

  /** 回收站:恢复。 */
  const onRestoreTrash = useCallback(
    (entry: TrashEntry) => {
      setBusy(true)
      void (async () => {
        try {
          const result = await restoreTrash(sessionId, entry.id)
          setStatus(t('status.restored').replace('{p}', result.path))
          await refresh(true)
          await refreshTrash()
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
          setBusy(false)
        }
      })()
    },
    [refresh, refreshTrash, sessionId, t],
  )

  /** 回收站:彻底删除(单条 / 清空)。 */
  const onPurgeTrash = useCallback(
    (entry: TrashEntry | null) => {
      setBusy(true)
      void (async () => {
        try {
          const result = await purgeTrash(sessionId, entry === null ? null : entry.id, entry === null)
          setStatus(t('status.purged').replace('{n}', String(result.removed)))
          await refreshTrash()
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
          setBusy(false)
        }
      })()
    },
    [refreshTrash, t],
  )

  /** 复制绝对路径。 */
  const onCopyPath = useCallback(
    (absolute: string, relative: string) => {
      const clipboard = navigator.clipboard
      if (clipboard === undefined) {
        setStatus(t('status.copyFailed'))
        return
      }
      void clipboard.writeText(absolute).then(
        () => setStatus(t('status.pathCopied').replace('{p}', relative)),
        () => setStatus(t('status.copyFailed')),
      )
    },
    [t],
  )

  /**
   * 「在文件树中定位」。
   *
   * 客户端没有"切换/定位官方文件页"的公开服务(见 AGENTS.md:客户端 Service 目录里
   * 只有 layout 的面板/侧栏级动作),所以这里做能做的部分:复制相对路径 + 明确提示,
   * 用户可以直接粘到「文件」页的搜索框。
   */
  const onReveal = useCallback(
    (relative: string) => {
      void navigator.clipboard?.writeText(relative)
      setStatus(t('status.revealHint').replace('{p}', relative))
    },
    [t],
  )

  /** 外部文件拖进来:`.md` 逐个导入成笔记。 */
  const onImportFiles = useCallback(
    (files: File[]) => {
      const markdown = files.filter((file) => /\.md$/i.test(file.name) || file.type === 'text/markdown')
      if (markdown.length === 0) {
        setStatus(t('status.importSkipped'))
        return
      }
      void (async () => {
        for (const file of markdown) {
          try {
            const text = await file.text()
            await importNote(sessionId, file.name, text, composeParent)
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
            return
          }
        }
        await refresh(true)
        setStatus(t('status.imported').replace('{n}', String(markdown.length)))
      })()
    },
    [composeParent, refresh, sessionId, t],
  )

  /** 从别处拖来的单个路径(文件树里的 .md)= 登记。 */
  const onRegisterPath = useCallback(
    (path: string) => {
      void run('register', { path }, () => setStatus(t('status.registered')))
    },
    [run, t],
  )

  /**
   * 点 `[[双链]]`:对得上就打开;**对不上什么都不创建**,只给一句提示
   * (用户明确要求:未命中不要自动新建笔记)。
   */
  const onWikiLink = useCallback(
    (title: string) => {
      const existing = tree?.notes.find((note) => note.title === title)
      if (existing !== undefined) {
        setSelected(existing)
          return
      }
      setStatus(`${title} · ${t('status.wikiMissing')}`)
    },
    [t, tree],
  )

  /** 双链能否对上(给编辑器上色用)。 */
  const knownTitles = useCallback(() => new Set((tree?.notes ?? []).map((note) => note.title)), [tree])

  /** 拖放:把笔记放到某分类的指定位置(`index` 省略 = 末尾)。 */
  const onMoveNote = useCallback(
    (noteId: string, collectionId: string | null, index: number | null) => {
      void run('move', { noteId, collectionId, index }, () => setStatus(t('status.moved')))
    },
    [run, t],
  )

  /** 拖放:把分类放到某父分类下的指定位置(`index` 省略 = 末尾)。 */
  const onMoveCollection = useCallback(
    (collectionId: string, parentId: string | null, index: number | null) => {
      void run('collection', { op: 'move', collectionId, parentId, index }, () => setStatus(t('status.moved')))
    },
    [run, t],
  )

  /**
   * 删除分类:**只动树**。
   *
   * 笔记文件与正文一个都不碰(硬不变量 1);被删分类里的笔记要么上提到父级,
   * 要么落到未归类。两条路都在 Host 的 `registry.deleteCollection` 里(已有单测)。
   */
  const onDeleteCollection = useCallback(
    (collectionId: string, mode: 'move-to-parent' | 'unfile') => {
      void run('collection', { op: 'delete', collectionId, mode }, () =>
        setStatus(mode === 'unfile' ? t('status.collectionUnfiled') : t('status.collectionDeleted')),
      )
    },
    [run, t],
  )

  const toggleLabel = treeOpen ? t('tree.collapse') : t('tree.expand')

  // 动作区属于**笔记树这一列**(不是区域顶栏):新建笔记 / 新建分类 / 重扫 / 收起。
  const toolbar = (
    <>
      <button
        type="button"
        className="dsh-notes-btn"
        title={t('action.newNote')}
        aria-label={t('action.newNote')}
        disabled={busy}
        onClick={() => {
          startCreate('note')
          // 新建的默认落点:跟着当前选中笔记走(同级),没选中就放顶层
          setComposeParent(selected?.collectionId ?? null)
          setDraft('')
        }}
      >
        <IconNewNote />
      </button>
      <button
        type="button"
        className="dsh-notes-btn"
        title={t('action.newCollection')}
        aria-label={t('action.newCollection')}
        disabled={busy}
        onClick={() => {
          startCreate('collection')
          setComposeParent(null)
          setDraft('')
        }}
      >
        <IconNewFolder />
      </button>
      <button
        type="button"
        className="dsh-notes-btn"
        title={t('action.trash')}
        aria-label={t('action.trash')}
        onClick={() => {
          setTrashOpen(true)
          void refreshTrash()
        }}
      >
        <IconTrash />
      </button>
      <button
        type="button"
        className="dsh-notes-btn"
        title={toggleLabel}
        aria-label={toggleLabel}
        aria-expanded={treeOpen}
        onClick={() => setTreeOpen((open) => !open)}
      >
        {treeOpen ? <IconCollapse /> : <IconExpand />}
      </button>
    </>
  )

  const composeRow =
    compose === null ? null : (
      <div className="dsh-notes-compose">
        <input
          ref={inputRef}
          className="dsh-notes-input"
          defaultValue=""
          placeholder={compose === 'note' ? t('compose.note') : t('compose.collection')}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submitCompose()
            if (event.key === 'Escape') {
              setCompose(null)
              setDraft('')
            }
          }}
        />
        <button type="button" className="dsh-notes-btn" onClick={() => void submitCompose()}>
          {t('compose.ok')}
        </button>
      </div>
    )

  return (
    <div
      className="dsh-notes-root"
      ref={rootRef}
      // 字号/图标缩放的**唯一**入口:整棵子树里的 `sc()` 与图标都读这个变量
      // (见 src/client/scale.ts 与 styles.ts 顶部「字号与缩放」)
      style={scaleVars(scale)}
      tabIndex={-1}
      onKeyDown={(event) => {
        // 只在焦点位于笔记区域内时接管:不劫持整个应用的 Ctrl+P(浏览器打印)
        if ((event.ctrlKey || event.metaKey) && (event.key === 'p' || event.key === 'k')) {
          event.preventDefault()
          setQuickOpen(true)
        }
      }}
    >
      {quickOpen ? (
        <QuickOpen
          t={t}
          notes={tree?.notes ?? []}
          onPick={(note) => {
            // 从哪一栏的 ＋ 点的就开在那一栏,而且是**新建标签**(以前是替换当前标签)
            openNote(note, 'tab', undefined, quickOpenPane)
          }}
          onClose={() => setQuickOpen(false)}
        />
      ) : null}
      {filesOpen ? (
        <CandidatesPanel
          t={t}
          scan={filesScan}
          loading={filesLoading}
          error={filesError}
          onClose={() => setFilesOpen(false)}
          onRescan={() => void loadFiles(true)}
          onInclude={(paths) => void onIncludeFiles(paths)}
          onIgnore={(payload) => void onIgnoreFiles(payload)}
          onScanRoots={onScanRoots}
          workspaceRoot={filesScan?.workspace.root ?? tree?.workspace.root}
          listDirectory={
            typeof props.uiWorkspace?.listDirectory === 'function'
              ? (path, signal) => props.uiWorkspace?.listDirectory?.(path, signal) as never
              : undefined
          }
          onPickRoot={onPickRoot}
        />
      ) : null}
      {trashOpen ? (
        <TrashPane
          t={t}
          entries={trashEntries}
          root={trashRoot}
          loading={trashLoading}
          onRestore={onRestoreTrash}
          onPurge={(entry) => onPurgeTrash(entry)}
          onPurgeAll={() => onPurgeTrash(null)}
          onClose={() => setTrashOpen(false)}
        />
      ) : null}
      <div className="dsh-notes-header">
        <span className="dsh-notes-title">{t('tab.title')}</span>
        <span className="dsh-notes-sub">
          <button
            type="button"
            className="dsh-notes-ws"
            title={t('ws.switch')}
            aria-expanded={wsMenu}
            onClick={() => setWsMenu((open) => !open)}
          >
            {(workspaceKey === null
              ? workspaces.find((item) => item.isSession)?.name ?? t('ws.sessionWorkspace')
              : workspaces.find((item) => item.key === workspaceKey)?.name ?? workspaceKey) + ' ▾'}
          </button>
          {sessionId === ''
            ? t('status.noSession')
            : tree === null
              ? t('tree.loading')
              : t('tree.summary')
                  .replace('{n}', String(tree.stats.notes))
                  .replace('{c}', String(tree.stats.collections))}
        </span>
        <span className="dsh-notes-spacer" />
        {/* 字号 / 图标大小(端头,树收起时也能用) */}
        <ScaleControl t={t} scale={scale} onChange={applyScale} />
      </div>
      {wsMenu ? (
        <div className="dsh-notes-wsmenu" role="menu">
          {workspaces.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={`dsh-notes-wsmenu-item${item.key === workspaceKey || (workspaceKey === null && item.isSession) ? ' dsh-notes-wsmenu-on' : ''}`}
              title={item.root}
              onClick={() => applyWorkspace(item.key)}
            >
              <span className="dsh-notes-wsmenu-name">{item.name}{item.isSession ? ` · ${t('ws.sessionTag')}` : ''}</span>
              <span className="dsh-notes-count">{item.notes}</span>
            </button>
          ))}
          <div className="dsh-notes-wsmenu-add">
            <input
              className="dsh-notes-input"
              placeholder={t('ws.openPath')}
              value={wsDraft}
              onChange={(event) => setWsDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void openWorkspaceRoot(wsDraft)
              }}
            />
          </div>
          <button
            type="button"
            className="dsh-notes-wsmenu-item"
            onClick={() => applyWorkspace(workspaces.find((item) => item.isSession)?.key ?? null)}
          >
            {t('ws.backToSession')}
          </button>
        </div>
      ) : null}
      {status !== null ? (
        <div className="dsh-notes-status" onAnimationEnd={() => setStatus(null)}>
          {status}
        </div>
      ) : null}
      <div className="dsh-notes-body">
        {treeOpen ? (
          <>
            <aside className="dsh-notes-tree" style={{ width: `${treeWidth}px` }}>
              <div className="dsh-notes-column">
                <div className="dsh-notes-panel-tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={panelTab === 'files'}
                    className={`dsh-notes-panel-tab${panelTab === 'files' ? ' dsh-notes-panel-tab-on' : ''}`}
                    onClick={() => setPanelTab('files')}
                  >
                    {t('panel.files')}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={panelTab === 'outline'}
                    className={`dsh-notes-panel-tab${panelTab === 'outline' ? ' dsh-notes-panel-tab-on' : ''}`}
                    onClick={() => setPanelTab('outline')}
                  >
                    {t('panel.outline')}
                  </button>
                  {panelTab === 'outline' && outline.length > 0 ? (
                    <span className="dsh-notes-count">{outline.length}</span>
                  ) : null}
                </div>
                {panelTab === 'files' && tree !== null && tree.notesDirMissing === true && !missingDismissed ? (
                  // 这个工作区还没有笔记根:**不报错**,给张卡片说明 + 三个一键动作
                  <div className="dsh-notes-missing">
                    <div className="dsh-notes-missing-title">
                      {t('notesdir.title').replace('{p}', tree.workspace.notesDir)}
                    </div>
                    <div className="dsh-notes-dim">
                      {t('notesdir.hint').replace('{p}', tree.workspace.notesDir)}
                    </div>
                    <div className="dsh-notes-missing-actions">
                      <button type="button" className="dsh-notes-btn" disabled={dirBusy} onClick={() => void createMissingDir()}>
                        {t('notesdir.create').replace('{p}', tree.workspace.notesDir)}
                      </button>
                      <button type="button" className="dsh-notes-btn" disabled={dirBusy} onClick={() => void applyNotesRoot(dirDraft)}>
                        {t('notesdir.apply')}
                      </button>
                      <button type="button" className="dsh-notes-btn" onClick={() => setMissingDismissed(true)}>
                        {t('notesdir.later')}
                      </button>
                    </div>
                    <input
                      className="dsh-notes-input"
                      placeholder={t('notesdir.useExisting')}
                      value={dirDraft}
                      onChange={(event) => setDirDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void applyNotesRoot(dirDraft)
                      }}
                    />
                  </div>
                ) : null}
                {panelTab === 'files' ? (
                  <TreePane
                    t={t}
                    tree={tree}
                    loading={loading}
                    error={error}
                    selectedId={selected?.id ?? null}
                    toolbar={toolbar}
                    composer={composeRow}
                    composerParent={composeParent}
                    renamingKey={renamingKey}
                    onRenameNote={commitNoteRename}
                    onRenameCollection={commitCollectionRename}
                    onCancelRename={() => setRenamingKey(null)}
                    onStartRename={(key) => setRenamingKey(key)}
                    onSelectNote={(note, mode) => openNote(note, mode ?? 'reuse')}
                    onSelectRef={(ref) =>
                      openNote(
                        {
                          id: ref.noteId,
                          title: ref.title,
                          path: ref.path,
                          relPath: ref.relPath,
                          collectionId: null,
                          pinned: false,
                        },
                        'reuse',
                        ref,
                      )
                    }
                    onFileAction={onFileAction}
                    onMoveNote={onMoveNote}
                    onMoveCollection={onMoveCollection}
                    onDeleteCollection={onDeleteCollection}
                    onPin={onPin}
                    onUnregister={onUnregister}
                    onUnregisterIgnore={onUnregisterIgnore}
                    onOpenCandidates={onOpenCandidates}
                    scanCounts={filesScan === null ? null : { candidates: filesScan.stats.candidates, ignored: filesScan.stats.ignored }}
                    onTrash={onTrash}
                    onHistory={openHistoryFor}
                    onCopyPath={onCopyPath}
                    onReveal={onReveal}
                    onNewNote={(collectionId) => startCompose('note', collectionId)}
                    onNewCollection={(parentId) => startCompose('collection', parentId)}
                    onImportFiles={onImportFiles}
                    onRegisterPath={onRegisterPath}
                    onDismissError={() => setError(null)}
                  />
                ) : (
                  <OutlinePane
                    t={t}
                    items={outline}
                    activeLine={cursorLine}
                    onJump={(line) => setJump({ line, nonce: jump.nonce + 1 })}
                    onMove={(fromLine, toLine, mode) =>
                      setOutlineMove({ fromLine, toLine, mode, nonce: (outlineMove?.nonce ?? 0) + 1 })
                    }
                  />
                )}
              </div>
            </aside>
            <div
              className="dsh-notes-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label={t('tree.resize')}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          </>
        ) : (
          <div className="dsh-notes-rail">
            <button
              type="button"
              className="dsh-notes-btn"
              title={t('action.newNote')}
              aria-label={t('action.newNote')}
              onClick={() => {
                setTreeOpen(true)
                setCompose('note')
                setComposeParent(selected?.collectionId ?? null)
                setDraft('')
              }}
            >
              <IconNewNote />
            </button>
            <button
              type="button"
              className="dsh-notes-btn"
              title={t('action.newCollection')}
              aria-label={t('action.newCollection')}
              onClick={() => {
                setTreeOpen(true)
                setCompose('collection')
                setComposeParent(null)
                setDraft('')
              }}
            >
              <IconNewFolder />
            </button>
            <button
              type="button"
              className="dsh-notes-btn"
              title={t('action.files')}
              aria-label={t('action.files')}
              onClick={onOpenCandidates}
            >
              <IconInbox />
            </button>
            <button
              type="button"
              className="dsh-notes-btn"
              title={toggleLabel}
              aria-label={toggleLabel}
              aria-expanded={false}
              onClick={() => setTreeOpen(true)}
            >
              <IconExpand />
            </button>
          </div>
        )}
        <section className="dsh-notes-editor">
          <EditorArea
            t={t}
            sessionId={sessionId}
            layout={layout}
            onLayout={applyLayout}
            onOutline={setOutline}
            onCursorLine={setCursorLine}
            jumpTo={jump}
            outlineMove={outlineMove}
            measureNonce={measureNonce}
            externalVersions={externalVersions}
            historyRequest={historyRequest}
            onWikiLink={onWikiLink}
            getKnownTitles={knownTitles}
            activePane={activePane}
            onFocusPane={setActivePane}
            onBack={() => {
              // 这个标签有跳转历史 → 回到上一个笔记(新打开的还没编辑过,这是"撤销"的直觉)
              const key = activeTab?.key
              if (key === undefined) return false
              let stack = tabHistory.current[key] ?? []
              if (stack.length === 0) {
                // 兜底:如果这个标签的 key 刚被换过,取"最近压过栈"的那一份
                const fallback = Object.values(tabHistory.current).find((item) => item.length > 0)
                stack = fallback ?? []
              }
              const previous = stack[stack.length - 1]
              if (previous === undefined) return false
              const note = tree?.notes.find((item) => item.id === previous)
              if (note === undefined) {
                tabHistory.current[key] = []
                return false
              }
              tabHistory.current[key] = stack.slice(0, -1)
              setSelected(note)
              return true
            }}
            relPathOf={relPathOf}
            onDropPayload={(data, target, index) => {
              const tabKey = data.getData('text/x-dsh-note-tab')
              if (tabKey !== '') {
                setLayoutState((current) => {
                  const next = moveTab(current, tabKey, { pane: target, index })
                  if (next === current) return current
                  saveLayout(layoutKey, next)
                  return next
                })
                setActivePane(target)
                return
              }
              const noteId = data.getData('text/x-dsh-note-id')
              if (noteId !== '') openNoteAt(noteId, target, index)
            }}
            onQuickOpen={(pane) => {
              setQuickOpenPane(pane)
              setQuickOpen(true)
            }}
            sourceModeByPane={sourceModeByPane}
            onToggleSourceMode={(id) =>
              setSourceModeByPane((current) => {
                const next = { ...current, [id]: !current[id] }
                // 顺带更新模块级开关:仍读单例的回退路径(旧装饰构建器等)也跟着这一栏
                applySourceMode(next[id])
                return next
              })
            }
          />
        </section>
      </div>
    </div>
  )
}
