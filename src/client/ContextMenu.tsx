/**
 * 通用右键菜单(编辑器与其它地方共用)。
 *
 * 结构照 Obsidian 的菜单:分组 + 可展开的二级菜单 + 右侧快捷键提示;
 * 点菜单外面、按 Esc 都关闭(与纳入管理面板同一套手感);位置自动夹在视口内。
 */

import React, { useEffect, useRef, useState } from 'react'

/** 一条菜单项。 */
export interface MenuEntry {
  /** 稳定 key。 */
  id: string
  /** 显示文字(`separator` 为 true 时忽略)。 */
  label?: string
  /** 右侧快捷键提示。 */
  shortcut?: string
  /** 置灰不可点。 */
  disabled?: boolean
  /** 分隔线。 */
  separator?: boolean
  /** 点了做什么(有 `children` 时忽略)。 */
  action?: () => void
  /** 二级菜单。 */
  children?: MenuEntry[]
}

/** props。 */
export interface ContextMenuProps {
  /** 视口坐标(会被夹到视口内)。 */
  x: number
  y: number
  entries: MenuEntry[]
  onClose: () => void
}

/**
 * 渲染一个右键菜单。
 * @param props - 见 {@link ContextMenuProps}。
 */
export function ContextMenu(props: ContextMenuProps): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)
  /** 打开着的二级菜单(用来按视口夹取位置)。 */
  const submenuRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ x: props.x, y: props.y })
  const [openSub, setOpenSub] = useState<string | null>(null)

  /**
   * 二级菜单必须留在屏幕内。
   *
   * 用户实测:菜单开在右下角时,`插入` 的子菜单会跑到屏幕**下方之外**,点都点不到。
   * 规则:贴底就改成"底对齐父项"(往上长),贴右就翻到父项左边。
   */
  useEffect(() => {
    if (openSub === null) return
    const element = submenuRef.current
    if (element === null) return
    const rect = element.getBoundingClientRect()
    if (rect.bottom > window.innerHeight - 6) {
      element.style.top = 'auto'
      element.style.bottom = '-6px'
    } else {
      element.style.top = '-6px'
      element.style.bottom = 'auto'
    }
    if (rect.right > window.innerWidth - 6) {
      element.style.left = 'auto'
      element.style.right = '100%'
      element.style.marginLeft = '0'
      element.style.marginRight = '4px'
    } else {
      element.style.left = '100%'
      element.style.right = 'auto'
      element.style.marginLeft = '4px'
      element.style.marginRight = '0'
    }
  }, [openSub])

  // 夹到视口内(靠近右下角打开时不要溢出)
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const rect = element.getBoundingClientRect()
    setPos({
      x: Math.max(4, Math.min(props.x, window.innerWidth - rect.width - 6)),
      y: Math.max(4, Math.min(props.y, window.innerHeight - rect.height - 6)),
    })
  }, [props.x, props.y])

  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      if (ref.current?.contains(event.target as Node) !== true) props.onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [props])

  const renderEntries = (entries: MenuEntry[], depth: number): React.ReactElement => (
    <div className="dsh-notes-menu" role="menu">
      {entries.map((entry) =>
        entry.separator === true ? (
          <div key={entry.id} className="dsh-notes-menu-sep" />
        ) : (
          <div
            key={entry.id}
            className="dsh-notes-menu-row"
            // **只有顶层行**才管二级菜单的开合:子菜单里的行如果也 setOpenSub(null),
            // 鼠标刚移到子菜单上它就被关掉(用户实测"放上去直接消失")。
            onMouseEnter={depth === 0 ? () => setOpenSub(entry.children === undefined ? null : entry.id) : undefined}
          >
            <button
              type="button"
              role="menuitem"
              className="dsh-notes-menu-item"
              disabled={entry.disabled === true}
              onClick={() => {
                if (entry.children !== undefined) {
                  setOpenSub((current) => (current === entry.id ? null : entry.id))
                  return
                }
                entry.action?.()
                props.onClose()
              }}
            >
              <span className="dsh-notes-menu-label">{entry.label}</span>
              {entry.shortcut !== undefined ? <span className="dsh-notes-menu-key">{entry.shortcut}</span> : null}
              {entry.children !== undefined ? <span className="dsh-notes-menu-arrow">›</span> : null}
            </button>
            {entry.children !== undefined && openSub === entry.id ? (
              <div className="dsh-notes-submenu" ref={submenuRef}>
                {renderEntries(entry.children, depth + 1)}
              </div>
            ) : null}
          </div>
        ),
      )}
    </div>
  )

  return (
    <div
      className="dsh-notes-context"
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      // 离开整个菜单才收起子菜单(而不是离开某一行)
      onMouseLeave={() => setOpenSub(null)}
    >
      {renderEntries(props.entries, 0)}
    </div>
  )
}
