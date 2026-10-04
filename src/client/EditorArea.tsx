/**
 * 编辑区容器:左/右最多两栏,每栏一条自己的标签栏 + 若干标签页。
 *
 * 关键取舍(照 Obsidian):
 *   - 标签页**保持挂载**(非活动的用 `display:none`),切标签不重新读盘、不丢撤销历史;
 *     激活时 `requestMeasure()` 让 CodeMirror 重新量一次尺寸。
 *   - 大纲/光标按**标签**收集,只有活动栏的活动标签会往上送(否则后台标签的
 *     onOutline 会覆盖掉当前这篇)。
 *   - 每栏最多 8 个标签由模型层挡着(见 editor/tabs.ts)。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { EditorPane } from './EditorPane'
import type { OutlineItem } from './OutlinePane'
import { TabStrip } from './TabStrip'
import type { TreeNote } from './api'
import {
  activateTab,
  closeSecondPane,
  closeTab,
  moveTab,
  type LayoutState,
  type NoteTab,
  type PaneState,
} from './editor/tabs'

/** props。 */
export interface EditorAreaProps {
  t: (key: string) => string
  sessionId: string
  layout: LayoutState
  onLayout: (next: LayoutState) => void
  onOutline: (items: OutlineItem[]) => void
  onCursorLine: (line: number) => void
  jumpTo: { line: number; nonce: number } | null
  outlineMove: { fromLine: number; toLine: number; mode: 'before' | 'after'; nonce: number } | null
  /**
   * 「重量一次尺寸」的信号(外壳在**切回可见**或**改了字号**时 +1)。
   *
   * 这个 tab 类型声明了 `keepMounted`(见 main.tsx):切到别的 tab 时正文只是被隐藏,
   * 编辑器活着但量出来是 0;字号一变,行高也跟着变。两种情况都要重新量,
   * 否则光标命中/换行位置会错位。
   */
  measureNonce: number
  onWikiLink: (title: string) => void
  /** 撤销的前置钩子(有跳转历史时回到上一个笔记)。 */
  onBack: () => boolean
  getKnownTitles: () => Set<string>
  activePane: 'p1' | 'p2'
  onFocusPane: (id: 'p1' | 'p2') => void
  onQuickOpen: (pane: 'p1' | 'p2') => void
  /**
   * 取一个标签的工作区相对路径。
   *
   * 由 NotesPane 提供(它手里有树,树总是带 relPath):老布局里的标签没存 relPath,
   * 而引用载荷要的是相对路径 —— 在这里兜住,新旧标签都对。
   */
  relPathOf: (tab: NoteTab) => string
  /**
   * 落点统一入口:标签载荷 → 移动标签;笔记载荷 → 在那一栏新开标签。
   * @param data - 拖放数据。
   * @param pane - 目标栏。
   * @param index - 目标位置。
   */
  onDropPayload: (data: DataTransfer, pane: 'p1' | 'p2', index: number) => void
  /** 每栏的源码/预览模式(分屏时各管各的)。 */
  sourceModeByPane: Record<'p1' | 'p2', boolean>
  onToggleSourceMode: (id: 'p1' | 'p2') => void
  /**
   * 各标签的**磁盘版本号**(外壳每 1.5s 探一次;见 `NotesPane.probeExternal`)。
   *
   * 键 = 笔记绝对路径;`null` = 文件不在了;缺键 = 还没探到(不处理)。
   * 编辑器据此做"干净就静默重载、脏就冲突横幅"的外部改动同步。
   */
  externalVersions: Record<string, string | null>
  /**
   * 「打开历史面板」的信号(树右键 →「历史版本…」)。只有**这篇笔记那一栏的编辑器**
   * 会处理它(见下面的 `historyRequest` 过滤)。
   */
  historyRequest: { noteId: string; nonce: number } | null
}

/** 标签 → EditorPane 需要的 TreeNote(标签只存最小字段,别的用默认值补)。 */
function asTreeNote(tab: NoteTab, relPath: (tab: NoteTab) => string): TreeNote {
  return {
    id: tab.noteId,
    title: tab.title,
    path: tab.path,
    relPath: relPath(tab),
    collectionId: null,
    pinned: false,
  }
}

/** 空大纲的**同一个**数组(引用必须稳定,否则上行给父组件会触发无限重渲染)。 */
const EMPTY_OUTLINE: OutlineItem[] = []

/**
 * 编辑区。
 * @param props - 见 {@link EditorAreaProps}。
 */
export function EditorArea(props: EditorAreaProps): React.ReactElement {
  const { t, layout, activePane } = props
  /** 每个标签各自的编辑器句柄(用来在激活时重新量尺寸)。 */
  const handles = useRef(new Map<string, { view: { requestMeasure?: () => void } }>())
  // 按标签收集大纲/光标:活动标签的那一份才送上去
  const [outlines, setOutlines] = useState<Record<string, OutlineItem[]>>({})
  const [cursors, setCursors] = useState<Record<string, number>>({})
  /**
   * 任何一次拖放结束都清掉高亮。
   *
   * 正文里的 drop 会 `stopPropagation`(为了不让 pane 层再开标签),于是 pane 的
   * onDrop 收不到 → 那个 tint 类的背景色就**留在编辑区上**(用户实测"颜色变深了")。
   */
  useEffect(() => {
    const clear = (): void => setDropHint(null)
    window.addEventListener('drop', clear, true)
    window.addEventListener('dragend', clear, true)
    return () => {
      window.removeEventListener('drop', clear, true)
      window.removeEventListener('dragend', clear, true)
    }
  }, [])

  /** 拖放指示:插到哪一栏的第几个位置(null = 没有拖动经过)。 */
  const [dropHint, setDropHint] = useState<{ pane: 'p1' | 'p2'; index: number; edge?: 'left' | 'right' | null } | null>(
    null,
  )

  const activeKey = useMemo(() => {
    const pane = layout.panes.find((item) => item.id === activePane) ?? layout.panes[0]
    return pane?.active ?? null
  }, [activePane, layout.panes])

  // 注意:这里必须用**引用稳定**的值上行,否则 setOutline([]) 每次都是新数组 →
  // 父组件重渲染 → effect 再跑 → 无限循环(整个笔记区域会白屏,实测踩到)。
  const items = useMemo(
    () => (activeKey === null ? EMPTY_OUTLINE : outlines[activeKey] ?? EMPTY_OUTLINE),
    [activeKey, outlines],
  )
  const cursor = activeKey === null ? 0 : cursors[activeKey] ?? 0
  const { onOutline, onCursorLine } = props
  useEffect(() => {
    onOutline(items)
  }, [items, onOutline])

  useEffect(() => {
    onCursorLine(cursor)
  }, [cursor, onCursorLine])

  // 切到某个标签、或外壳要求重量(切回可见 / 改字号)时,让 CodeMirror 重新量一次
  // (隐藏期间量出来是 0,字号变了行高也变了)
  useEffect(() => {
    if (activeKey === null) return
    const handle = handles.current.get(activeKey)
    if (handle?.view?.requestMeasure === undefined) return
    const timer = window.setTimeout(() => handle.view.requestMeasure?.(), 0)
    return () => window.clearTimeout(timer)
  }, [activeKey, props.measureNonce])

  const outlineFor = useCallback(
    (key: string) => (items: OutlineItem[]) => setOutlines((current) => (current[key] === items ? current : { ...current, [key]: items })),
    [],
  )
  const cursorFor = useCallback(
    (key: string) => (line: number) => setCursors((current) => (current[key] === line ? current : { ...current, [key]: line })),
    [],
  )

  const paneView = (pane: PaneState): React.ReactElement => (
    <section
      key={pane.id}
      className={`dsh-notes-pane${pane.id === activePane ? ' dsh-notes-pane-on' : ''}${
        dropHint?.pane === pane.id ? ' dsh-notes-pane-drop' : ''
      }${dropHint?.pane === pane.id && dropHint.edge === 'left' ? ' dsh-notes-pane-drop-left' : ''}${
        dropHint?.pane === pane.id && dropHint.edge === 'right' ? ' dsh-notes-pane-drop-right' : ''
      }`}
      aria-label={pane.id}
      onMouseDownCapture={() => props.onFocusPane(pane.id)}
      // 整栏(含编辑区)都是合法落点:拖到编辑区 = 并入本栏末尾(Obsidian 的"中央带 = 并入")
      onDragOver={(event) => {
        if ((event.target as HTMLElement | null)?.closest?.('.dsh-notes-tabstrip') !== null) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        // 左右边缘带(各 18%)= 落到对应分栏(照 Obsidian 的"边缘 = 分屏/并入那一侧")
        const box = event.currentTarget.getBoundingClientRect()
        const ratio = box.width === 0 ? 0.5 : (event.clientX - box.left) / box.width
        setDropHint({ pane: pane.id, index: pane.tabs.length, edge: ratio < 0.18 ? 'left' : ratio > 0.82 ? 'right' : null })
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDropHint({ pane: pane.id, index: pane.tabs.length, edge: null })
      }}
      onDrop={(event) => {
        const host = (event.target as HTMLElement | null)?.closest?.('.dsh-notes-tabstrip, .dsh-notes-editor-host')
        if (host !== null && host !== undefined) return // 标签栏/正文自己处理
        event.preventDefault()
        // 边缘带 → 落到 p1/p2(没有 p2 就现建一个,见 moveTab/openTab)
        const landing = dropHint?.edge === 'left' ? 'p1' : dropHint?.edge === 'right' ? 'p2' : pane.id
        props.onDropPayload(event.dataTransfer, landing, pane.tabs.length)
        setDropHint(null)
      }}
    >
      <TabStrip
        t={t}
        pane={pane}
        active={pane.id === activePane}
        split={layout.panes.length > 1}
        onActivate={(key) => props.onLayout(activateTab(layout, key))}
        onClose={(key) => props.onLayout(closeTab(layout, key))}
        onCloseOthers={(key) =>
          props.onLayout({
            ...layout,
            activePane: pane.id,
            panes: layout.panes.map((item) => (item.id === pane.id ? { ...item, tabs: item.tabs.filter((tab) => tab.key === key), active: key } : item)),
          })
        }
        onMoveToOther={(key) => props.onLayout(moveTab(layout, key, { pane: pane.id === 'p1' ? 'p2' : 'p1' }))}
        onCloseSplit={() => props.onLayout(closeSecondPane(layout))}
        onDropPayload={(data, target, index) => {
          props.onDropPayload(data, target, index)
          setDropHint(null)
        }}
        onDropHint={(hint) => setDropHint(hint === null ? null : { ...hint, edge: null })}
        dropIndex={dropHint?.pane === pane.id ? dropHint.index : null}
        onQuickOpen={() => props.onQuickOpen(pane.id)}
      />
      <div className="dsh-notes-pane-body">
        {pane.tabs.length === 0 ? <div className="dsh-notes-empty">{t('editor.noSelection')}</div> : null}
        {pane.tabs.map((tab) => (
          <div
            key={tab.key}
            className="dsh-notes-tabpage"
            style={{ display: tab.key === pane.active ? 'flex' : 'none' }}
          >
            {tab.ref === true ? (
              <div className="dsh-notes-placeholder">
                <div className="dsh-notes-placeholder-title">{tab.title}</div>
                <div className="dsh-notes-dim dsh-notes-mono">{tab.path}</div>
              </div>
            ) : (
              <EditorPane
                key={tab.key}
                t={t}
                sessionId={props.sessionId}
                note={asTreeNote(tab, props.relPathOf)}
                onOutline={outlineFor(tab.key)}
                onCursorLine={cursorFor(tab.key)}
                onWikiLink={props.onWikiLink}
                onBack={props.onBack}
                getKnownTitles={props.getKnownTitles}
                outlineMove={props.outlineMove}
                jumpTo={props.jumpTo}
                sourceMode={props.sourceModeByPane[pane.id] === true}
                onToggleSourceMode={() => props.onToggleSourceMode(pane.id)}
                // 外部改动同步:版本号由外壳探(一次问完两栏所有标签),这里按标签下发;
                // 只有**本栏活动标签**处理(隐藏标签等切回来时再对一次,不抢焦点)。
                externalVersion={props.externalVersions[tab.path]}
                active={tab.key === pane.active}
                // 只有这篇笔记的那一栏才收到"打开历史面板"的信号(nonce 变了就弹一次)
                historyRequest={props.historyRequest !== null && props.historyRequest.noteId === tab.noteId ? props.historyRequest : null}
                // 分屏时只有聚焦栏的活动标签显示工具栏(工具作用于聚焦的那一份笔记)
                showToolbar={pane.id === props.activePane && tab.key === pane.active}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  )

  return (
    <div className={`dsh-notes-area${layout.panes.length > 1 ? ' dsh-notes-area-split' : ''}`}>
      {layout.panes.map(paneView)}
    </div>
  )
}
