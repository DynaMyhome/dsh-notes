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
  moveTabToPane,
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
  onWikiLink: (title: string) => void
  getKnownTitles: () => Set<string>
  activePane: 'p1' | 'p2'
  onFocusPane: (id: 'p1' | 'p2') => void
  onQuickOpen: () => void
}

/** 标签 → EditorPane 需要的 TreeNote(标签只存最小字段,别的用默认值补)。 */
function asTreeNote(tab: NoteTab): TreeNote {
  return {
    id: tab.noteId,
    title: tab.title,
    path: tab.path,
    relPath: tab.path,
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

  // 切到某个标签时让 CodeMirror 重新量一次(隐藏期间量出来是 0)
  useEffect(() => {
    if (activeKey === null) return
    const handle = handles.current.get(activeKey)
    if (handle?.view?.requestMeasure === undefined) return
    const timer = window.setTimeout(() => handle.view.requestMeasure?.(), 0)
    return () => window.clearTimeout(timer)
  }, [activeKey])

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
      className={`dsh-notes-pane${pane.id === activePane ? ' dsh-notes-pane-on' : ''}`}
      aria-label={pane.id}
      onMouseDown={() => props.onFocusPane(pane.id)}
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
        onMoveToOther={(key) => props.onLayout(moveTabToPane(layout, key, pane.id === 'p1' ? 'p2' : 'p1'))}
        onCloseSplit={() => props.onLayout(closeSecondPane(layout))}
        onDropTab={(key, target) => props.onLayout(moveTabToPane(layout, key, target))}
        onQuickOpen={props.onQuickOpen}
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
                note={asTreeNote(tab)}
                onOutline={outlineFor(tab.key)}
                onCursorLine={cursorFor(tab.key)}
                onWikiLink={props.onWikiLink}
                getKnownTitles={props.getKnownTitles}
                outlineMove={props.outlineMove}
                jumpTo={props.jumpTo}
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
