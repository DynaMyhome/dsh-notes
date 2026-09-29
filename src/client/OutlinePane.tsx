/**
 * 大纲面板(左列第二个标签页,对应 Typora 的「大纲」)。
 *
 * 功能:
 *   - 列出当前笔记的标题树,按层级缩进,点一行跳到该标题;
 *   - **拖动行重排章节**:行的上/下半区 = 插到该标题之前/之后(真插入线),
 *     实际文本搬移由 `lib/section.js` 的纯函数完成(带 6 条单测),这里只报"落在哪";
 *   - 当前光标所在小节高亮。
 */

import React, { useState } from 'react'

/** 一条标题。 */
export interface OutlineItem {
  level: number
  text: string
  line: number
}

/** 落点模式。 */
export type OutlineDropMode = 'before' | 'after'

/** props。 */
export interface OutlinePaneProps {
  t: (key: string) => string
  items: OutlineItem[]
  /** 当前光标行(用于高亮所在小节)。 */
  activeLine: number | null
  onJump: (line: number) => void
  /** 把 `fromLine` 所在章节搬到 `toLine` 之前/之后。 */
  onMove?: (fromLine: number, toLine: number, mode: OutlineDropMode) => void
}

/** 正在拖的行(模块级即可:一次只有一个拖动会话)。 */
let draggingLine: number | null = null

/**
 * 大纲。
 * @param props - 见 {@link OutlinePaneProps}。
 */
export function OutlinePane({ t, items, activeLine, onJump, onMove }: OutlinePaneProps): React.ReactElement {
  const [drop, setDrop] = useState<{ line: number; mode: OutlineDropMode } | null>(null)

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

  const finish = (): void => {
    draggingLine = null
    setDrop(null)
  }

  return (
    <div className="dsh-notes-outline" role="tree">
      {items.map((item, index) => {
        const canDrop = onMove !== undefined && draggingLine !== null && draggingLine !== item.line
        const active = drop?.line === item.line
        return (
          <div
            key={`${item.line}:${index}`}
            className={`dsh-notes-outline-row${index === activeIndex ? ' dsh-notes-outline-active' : ''}${
              draggingLine === item.line ? ' dsh-notes-outline-dragging' : ''
            }`}
            style={{
              paddingLeft: `${8 + (item.level - 1) * 11}px`,
              ...(active && drop?.mode === 'before' ? { boxShadow: 'inset 0 2px 0 0 var(--dsw-alias-brand-primary)' } : {}),
              ...(active && drop?.mode === 'after' ? { boxShadow: 'inset 0 -2px 0 0 var(--dsw-alias-brand-primary)' } : {}),
            }}
            title={`H${item.level} · 第 ${item.line} 行`}
            role="treeitem"
            draggable={onMove !== undefined}
            onDragStart={(event) => {
              if (onMove === undefined) return
              draggingLine = item.line
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', String(item.line))
            }}
            onDragEnd={finish}
            onDragOver={(event) => {
              if (!canDrop) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              const rect = event.currentTarget.getBoundingClientRect()
              const ratio = rect.height === 0 ? 0.5 : (event.clientY - rect.top) / rect.height
              setDrop({ line: item.line, mode: ratio < 0.5 ? 'before' : 'after' })
            }}
            onDragLeave={() => setDrop((current) => (current?.line === item.line ? null : current))}
            onDrop={(event) => {
              if (!canDrop || drop === null || onMove === undefined) return
              event.preventDefault()
              const from = draggingLine
              const target = drop.line
              const mode = drop.mode
              finish()
              if (from !== null) onMove(from, target, mode)
            }}
            onClick={() => onJump(item.line)}
          >
            <span className={`dsh-notes-outline-h dsh-notes-outline-h${Math.min(item.level, 5)}`}>H{item.level}</span>
            <span className="dsh-notes-outline-text">{item.text}</span>
          </div>
        )
      })}
    </div>
  )
}
