/**
 * 笔记区域的外壳(P0:框架 + 交互骨架)。
 *
 * 布局(整个项目的位置决定):右侧栏「笔记」tab 内部自成分栏 ——
 *   [ 可收起的笔记树 | 编辑区 ]
 * 中央对话与 composer 完全不动;树与编辑区都在本 tab 内,不新开 tab、不新开会话。
 *
 * P0 只交付:分栏、树收起/展开、分隔条拖动、i18n、主题 token 样式。
 * 树内容(P1)与编辑器(P2)接入时只替换两个空态占位。
 */

import React, { useCallback, useRef, useState } from 'react'

/** 笔记树的宽度范围(px)。 */
const TREE_MIN = 160
/** 见 {@link TREE_MIN}。 */
const TREE_MAX = 420
/** 默认宽度(px):够看清层级,又不挤压编辑区。 */
const TREE_DEFAULT = 220

/** 槽位 props(只声明本组件真正用到的字段)。 */
export interface NotesPaneProps {
  /** 框架按注册时的 `locale` 注入的翻译函数。 */
  t: (key: string) => string
}

/**
 * 笔记区域外壳。
 * @param props - 槽位组合 props。
 * @returns 分栏外壳。
 */
export function NotesPane(props: NotesPaneProps): React.ReactElement {
  const t = props.t
  const [treeOpen, setTreeOpen] = useState(true)
  const [treeWidth, setTreeWidth] = useState(TREE_DEFAULT)
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const target = event.currentTarget
      target.setPointerCapture?.(event.pointerId)
      drag.current = { startX: event.clientX, startWidth: treeWidth }
      event.preventDefault()
    },
    [treeWidth],
  )

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (state === null) return
    const next = Math.min(TREE_MAX, Math.max(TREE_MIN, state.startWidth + (event.clientX - state.startX)))
    setTreeWidth(next)
  }, [])

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }, [])

  const toggleLabel = treeOpen ? t('tree.collapse') : t('tree.expand')

  return (
    <div className="dsh-notes-root">
      <div className="dsh-notes-header">
        <span className="dsh-notes-title">{t('tab.title')}</span>
        <span className="dsh-notes-sub">{t('p0.notice')}</span>
        <span className="dsh-notes-spacer" />
        <button
          type="button"
          className="dsh-notes-btn"
          title={toggleLabel}
          aria-label={toggleLabel}
          aria-expanded={treeOpen}
          onClick={() => setTreeOpen((open) => !open)}
        >
          {treeOpen ? '⯇' : '⯈'}
        </button>
      </div>
      <div className="dsh-notes-body">
        {treeOpen ? (
          <>
            <aside className="dsh-notes-tree" style={{ width: `${treeWidth}px` }}>
              <div className="dsh-notes-empty">{t('tree.pending')}</div>
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
          <button
            type="button"
            className="dsh-notes-rail"
            title={toggleLabel}
            aria-label={toggleLabel}
            onClick={() => setTreeOpen(true)}
          >
            ›
          </button>
        )}
        <section className="dsh-notes-editor">
          <div className="dsh-notes-empty">{t('editor.pending')}</div>
        </section>
      </div>
    </div>
  )
}
