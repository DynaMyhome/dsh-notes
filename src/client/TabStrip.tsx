/**
 * 一栏顶部的标签栏(每栏一个)。
 *
 * 行为照 Obsidian:点标签激活、中键/`×`关闭、右键「关闭其它」、拖到另一栏、
 * 右端一个「向右分屏」。标签多了横向滚动(不做多行)。
 */

import React from 'react'

import type { PaneState } from './editor/tabs'

/** props。 */
export interface TabStripProps {
  t: (key: string) => string
  pane: PaneState
  /** 这一栏是不是活动栏(活动栏的标签更亮)。 */
  active: boolean
  /** 布局里有两栏时才显示"关闭分屏"。 */
  split: boolean
  onActivate: (key: string) => void
  onClose: (key: string) => void
  onCloseOthers: (key: string) => void
  /** 把当前标签移到另一栏(等价于"向右分屏")。 */
  onMoveToOther: (key: string) => void
  /** 关闭分屏(第 2 栏的标签并入第 1 栏)。 */
  onCloseSplit: () => void
  /** 拖拽:把标签放到某一栏。 */
  onDropTab: (key: string, pane: 'p1' | 'p2') => void
  /** 打开快速切换(＋)。 */
  onQuickOpen: () => void
}

/**
 * 标签栏。
 * @param props - 见 {@link TabStripProps}。
 */
export function TabStrip(props: TabStripProps): React.ReactElement {
  const { t, pane } = props
  return (
    <div
      className={`dsh-notes-tabstrip${props.active ? ' dsh-notes-tabstrip-on' : ''}`}
      role="tablist"
      // 拖到这一栏 = 把标签移到这栏(HTML5 DnD;拖的是标签元素自己)
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('text/x-dsh-note-tab')) event.preventDefault()
      }}
      onDrop={(event) => {
        const key = event.dataTransfer.getData('text/x-dsh-note-tab')
        if (key !== '') {
          event.preventDefault()
          props.onDropTab(key, pane.id)
        }
      }}
    >
      {pane.tabs.map((tab) => (
        <div
          key={tab.key}
          role="tab"
          aria-selected={tab.key === pane.active}
          className={`dsh-notes-tab${tab.key === pane.active ? ' dsh-notes-tab-on' : ''}`}
          title={tab.path}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData('text/x-dsh-note-tab', tab.key)
            event.dataTransfer.effectAllowed = 'move'
          }}
          onClick={() => props.onActivate(tab.key)}
          onAuxClick={(event) => {
            if (event.button === 1) {
              event.preventDefault()
              props.onClose(tab.key)
            }
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            props.onCloseOthers(tab.key)
          }}
        >
          {tab.ref === true ? <span className="dsh-notes-tab-badge">↗</span> : null}
          <span className="dsh-notes-tab-name">{tab.title}</span>
          <button
            type="button"
            className="dsh-notes-tab-close"
            title={t('tabs.close')}
            aria-label={t('tabs.close')}
            onClick={(event) => {
              event.stopPropagation()
              props.onClose(tab.key)
            }}
          >
            ×
          </button>
        </div>
      ))}
      <span className="dsh-notes-spacer" />
      <button type="button" className="dsh-notes-btn" title={t('tabs.quickOpen')} onClick={props.onQuickOpen}>
        ＋
      </button>
      {pane.active !== null ? (
        <button
          type="button"
          className="dsh-notes-btn"
          title={pane.id === 'p1' ? t('tabs.splitRight') : t('tabs.moveLeft')}
          onClick={() => props.onMoveToOther(pane.active as string)}
        >
          {pane.id === 'p1' ? '⇥' : '⇤'}
        </button>
      ) : null}
      {props.split ? (
        <button type="button" className="dsh-notes-btn" title={t('tabs.closeSplit')} onClick={props.onCloseSplit}>
          {t('tabs.mergeShort')}
        </button>
      ) : null}
    </div>
  )
}
