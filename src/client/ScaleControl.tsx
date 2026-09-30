/**
 * 字号 / 图标大小控件:标题栏上一个 `Aa`,点开是预设档 + 滑块 + 复位。
 *
 * 为什么放在笔记区自己的标题栏而不是设置面板:调字号是"边看边调"的事,
 * 走设置 → 通用 → 字体大小 那条路只能管**全局**(聊天区一起变),
 * 而笔记树是 11–13px 的密集排版,常常需要单独再松一点;
 * 就地一个 Aa,改完立刻能看到行高、图标、编辑器正文一起变。
 *
 * 值本身由外壳(NotesPane)持有并落盘(见 src/client/scale.ts),
 * 这里只读/写,不自己存 —— 免得两个地方各存一份对不上。
 */

import React, { useEffect, useRef, useState } from 'react'

import { SCALE_DEFAULT, SCALE_MAX, SCALE_MIN, SCALE_PRESETS } from './scale'

/** 控件 props。 */
export interface ScaleControlProps {
  /** 框架注入的翻译函数。 */
  t: (key: string) => string
  /** 当前系数(已夹取)。 */
  scale: number
  /** 用户改了一个新值。 */
  onChange: (next: number) => void
}

/** 系数 → 百分比文字。 */
function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/**
 * 渲染 `Aa` 按钮与它的浮层。
 * @param props - 见 {@link ScaleControlProps}。
 */
export function ScaleControl(props: ScaleControlProps): React.ReactElement {
  const t = props.t
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement | null>(null)

  // 点外面 / Esc 关闭。
  // 用 `click` 而不是 `mousedown`:本项目在右键菜单上踩过 —— 用 mousedown 收起浮层时,
  // 那一次点击的后续 click 会被吃掉(按钮"点了没反应")。
  useEffect(() => {
    if (!open) return undefined
    const onDocClick = (event: MouseEvent): void => {
      const wrap = wrapRef.current
      if (wrap !== null && event.target instanceof Node && wrap.contains(event.target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const apply = (next: number): void => props.onChange(next)

  return (
    <span className="dsh-notes-scale-wrap" ref={wrapRef}>
      <button
        type="button"
        className="dsh-notes-btn dsh-notes-scale-btn"
        title={t('scale.open')}
        aria-label={t('scale.open')}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Aa
      </button>
      {open ? (
        <div className="dsh-notes-popover dsh-notes-scale-pop" role="dialog" aria-label={t('scale.title')}>
          <div className="dsh-notes-scale-head">
            <span className="dsh-notes-popover-label">{t('scale.title')}</span>
            <span className="dsh-notes-scale-value">{percent(props.scale)}</span>
          </div>
          <div className="dsh-notes-scale-presets">
            {SCALE_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`dsh-notes-scale-preset${preset === props.scale ? ' dsh-notes-scale-preset-on' : ''}`}
                aria-pressed={preset === props.scale}
                onClick={() => apply(preset)}
              >
                {percent(preset)}
              </button>
            ))}
          </div>
          <input
            className="dsh-notes-scale-range"
            type="range"
            min={SCALE_MIN}
            max={SCALE_MAX}
            step={0.05}
            value={props.scale}
            aria-label={t('scale.title')}
            onChange={(event) => apply(Number(event.target.value))}
          />
          <div className="dsh-notes-scale-hint">{t('scale.hint')}</div>
          <div className="dsh-notes-scale-actions">
            <button
              type="button"
              className="dsh-notes-btn"
              disabled={props.scale === SCALE_DEFAULT}
              onClick={() => apply(SCALE_DEFAULT)}
            >
              {t('scale.reset')}
            </button>
          </div>
        </div>
      ) : null}
    </span>
  )
}
