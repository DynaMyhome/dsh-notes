/**
 * 快速打开(Ctrl/Cmd+P,也接受 Ctrl/Cmd+K):按标题/路径过滤当前工作区的笔记。
 *
 * 为什么不用全局快捷键:Web 里 Ctrl+P 是浏览器"打印"。所以快捷键只在**焦点位于笔记区域时**
 * 生效(`.dsh-notes-root` 上的 onKeyDown),不劫持整个应用。
 *
 * 样式内联:这个组件只有一处用,放这里比塞进 styles.ts 更清楚。
 * 字号走 `cssSize()`(和样式表同一个公式),这样它也跟着笔记区的缩放系数 /
 * 全局字号增量变 —— 写死 px 的话 Aa 调大后这里是唯一不变的地方。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'

import type { TreeNote } from './api'
import { cssSize } from './scale'

/** props。 */
export interface QuickOpenProps {
  /** 框架注入的翻译函数(占位符与空态文案;以前硬编码中文,英文界面里会露出来)。 */
  t: (key: string) => string
  notes: TreeNote[]
  onPick: (note: TreeNote) => void
  onClose: () => void
}

const MAX = 40

export function QuickOpen({ t, notes, onPick, onClose }: QuickOpenProps): React.ReactElement {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return notes.slice(0, MAX)
    return notes
      .filter((note) => note.title.toLowerCase().includes(q) || note.relPath.toLowerCase().includes(q))
      .slice(0, MAX)
  }, [notes, query])

  const pick = (position: number): void => {
    const note = matches[position]
    if (note === undefined) return
    onPick(note)
    onClose()
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: '0',
        zIndex: 70,
        background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '48px',
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        style={{
          width: '88%',
          maxWidth: '460px',
          maxHeight: '62%',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '10px',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-overlay)',
          boxShadow: '0 16px 40px rgba(0,0,0,.28)',
          overflow: 'hidden',
        }}
      >
        <input
          ref={inputRef}
          value={query}
          placeholder={t('quick.placeholder')}
          onChange={(event) => {
            setQuery(event.target.value)
            setIndex(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              setIndex((current) => Math.min(current + 1, Math.max(0, matches.length - 1)))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setIndex((current) => Math.max(0, current - 1))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              pick(index)
            }
          }}
          style={{
            flex: '0 0 auto',
            border: 'none',
            outline: 'none',
            padding: '9px 12px',
            // 顺序要紧:`font` 是简写,会把 font-size 一并重置回继承值 ——
            // 所以必须写在 fontSize 之前,否则上面那行字号是死的(踩过)
            font: 'inherit',
            fontSize: cssSize(13),
            color: 'var(--dsw-alias-label-primary)',
            background: 'transparent',
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
          }}
        />
        <div style={{ flex: '1 1 auto', minHeight: '0', overflow: 'auto', padding: '4px' }}>
          {matches.length === 0 ? (
            <div style={{ padding: '10px', fontSize: cssSize(12), color: 'var(--dsw-alias-label-secondary)' }}>
              {t('quick.empty')}
            </div>
          ) : (
            matches.map((note, position) => (
              <div
                key={note.id}
                onMouseEnter={() => setIndex(position)}
                onClick={() => pick(position)}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: '8px',
                  padding: '5px 9px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  background: position === index ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                }}
              >
                <span
                  style={{
                    flex: '1 1 auto',
                    minWidth: '0',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: cssSize(12.5),
                    color: 'var(--dsw-alias-label-primary)',
                  }}
                >
                  {note.title}
                </span>
                <span
                  style={{
                    flex: '0 0 auto',
                    maxWidth: '45%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: cssSize(10.5),
                    color: 'var(--dsw-alias-label-secondary)',
                  }}
                >
                  {note.relPath}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
