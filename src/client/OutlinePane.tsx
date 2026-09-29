/**
 * 大纲面板(左列第二个标签页,对应 Typora 的「大纲」)。
 *
 * 只展示当前打开笔记的标题树;点一行跳到该标题。层级用缩进表达,
 * 当前光标所在的小节高亮(滚动/移动光标时跟着变)。
 */

import React from 'react'

/** 一条标题。 */
export interface OutlineItem {
  level: number
  text: string
  line: number
}

/** props。 */
export interface OutlinePaneProps {
  t: (key: string) => string
  items: OutlineItem[]
  /** 当前光标行(用于高亮所在小节)。 */
  activeLine: number | null
  onJump: (line: number) => void
}

/**
 * 大纲。
 * @param props - 见 {@link OutlinePaneProps}。
 */
export function OutlinePane({ t, items, activeLine, onJump }: OutlinePaneProps): React.ReactElement {
  if (items.length === 0) {
    return (
      <div className="dsh-notes-outline">
        <div className="dsh-notes-empty">{t('outline.empty')}</div>
      </div>
    )
  }
  // 当前小节 = 光标行之前(含)的最后一个标题
  let activeIndex = -1
  if (activeLine !== null) {
    items.forEach((item, index) => {
      if (item.line <= activeLine) activeIndex = index
    })
  }
  return (
    <div className="dsh-notes-outline" role="tree">
      {items.map((item, index) => (
        <div
          key={`${item.line}:${index}`}
          className={`dsh-notes-outline-row${index === activeIndex ? ' dsh-notes-outline-active' : ''}`}
          style={{ paddingLeft: `${8 + (item.level - 1) * 11}px` }}
          title={t('outline.jump').replace('{n}', String(item.line))}
          role="treeitem"
          onClick={() => onJump(item.line)}
        >
          <span className={`dsh-notes-outline-h dsh-notes-outline-h${Math.min(item.level, 5)}`}>H{item.level}</span>
          <span className="dsh-notes-outline-text">{item.text}</span>
        </div>
      ))}
    </div>
  )
}
