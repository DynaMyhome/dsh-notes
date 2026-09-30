/**
 * 笔记树:分类树 + 笔记 + 跨工作区映射 + 未归类文件,带完整的拖放交互。
 *
 * 两类行一眼可分:分类 = 文件夹图标 + 加粗;笔记 = 文档图标 + 次要色。
 *
 * 拖放按通行做法(Obsidian 社区插件 / VS Code / Finder 都这么做):
 *   - **三分区**:行的上 30% = 插到它前面、下 30% = 插到它后面、中间 40% = 放进它里面(仅容器行);
 *   - **插入线**:before/after 在行上/下画一条 2px 指示线,线在哪就落在哪;
 *   - **容器高亮**:inside 时整行高亮,表示"将成为它的子项";
 *   - **层级提示**:拖动时跟随光标一个小标签,直接写出目标路径(如 `文献阅读 / 振荡器`);
 *   - **悬停自动展开**:拖到收起的分类上停 700ms 自动展开;
 *   - **自动滚动**:拖到树体上下边缘时自动滚;
 *   - 非法目标(拖进自己的子孙)不接受,光标显示 no-drop。
 *
 * 数据与写操作在 {@link NotesPane};这里只算"落在哪"。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'

import type { Tree, TreeNote, TreeRef, TreeUnfiled } from './api'
import { IconChevron, IconCollection, IconInbox, IconNote } from './icons'

/** 组件 props。 */
export interface TreePaneProps {
  t: (key: string) => string
  tree: Tree | null
  loading: boolean
  error: string | null
  selectedId: string | null
  onSelectNote: (note: TreeNote) => void
  onSelectRef: (ref: TreeRef) => void
  onFileAction: (file: TreeUnfiled) => void
  /** 把笔记放到某分类的指定位置(`index` 省略 = 末尾)。 */
  onMoveNote: (noteId: string, collectionId: string | null, index: number | null) => void
  /** 把分类放到某父分类下的指定位置(`index` 省略 = 末尾)。 */
  onMoveCollection: (collectionId: string, parentId: string | null, index: number | null) => void
  /** 右键菜单动作。 */
  onPin: (note: TreeNote, pinned: boolean) => void
  onUnregister: (note: TreeNote) => void
  onCopyPath: (path: string, relative: string) => void
  onReveal: (path: string) => void
  /** 在某个分类里新建笔记 / 子分类(`null` = 顶层)。 */
  onNewNote: (collectionId: string | null) => void
  onNewCollection: (parentId: string | null) => void
  /** 外部文件拖进来:内容导入 / 已知路径登记。 */
  onImportFiles: (files: File[]) => void
  onRegisterPath: (path: string) => void
  /** 关掉错误提示。 */
  onDismissError: () => void
  /** 正在行内改名的行 key(`n:<id>` / `c:<id>`)。 */
  renamingKey?: string | null
  /** 提交笔记改名(行内输入回车/失焦)。 */
  onRenameNote?: (noteId: string, title: string) => void
  /** 提交分类改名。 */
  onRenameCollection?: (id: string, name: string) => void
  /** 取消行内改名。 */
  onCancelRename?: () => void
  /** 右键菜单触发改名(把该行切进行内编辑)。 */
  onStartRename?: (key: string) => void
  toolbar?: React.ReactNode
  header?: React.ReactNode
  /** 就地新建输入条:渲染成树里的**一行**(在目标层级末尾),而不是顶栏压下来。 */
  composer?: React.ReactNode
  /** 输入条所属分类(`null` = 顶层),只用于算缩进。 */
  composerParent?: string | null
}

/** 行的落点分区。 */
type DropMode = 'before' | 'after' | 'inside'

/** 渲染层的一行。 */
interface Row {
  key: string
  kind: 'collection' | 'note' | 'ref' | 'unfiled'
  depth: number
  label: string
  hint?: string
  count?: number
  badge?: string
  selected?: boolean
  hasChildren?: boolean
  collapsed?: boolean
  /** 可拖身份。 */
  drag?: { kind: 'note' | 'collection'; id: string }
  /** 可作 inside 目标的容器 id(`null`/undefined = 不接受 inside)。 */
  dropAs?: string | null
  /** 自己的父与同级序号(用于 before/after 落点)。 */
  parentId?: string | null
  index?: number
  /** 直接子项数(inside 落点 = 追加到末尾)。 */
  childCount?: number
  /** 面包屑(拖动提示用)。 */
  path?: string
  target?: TreeNote | TreeRef | TreeUnfiled
}

/** 当前拖动的东西(模块级即可:一棵树只有一个拖动会话)。 */
let dragging: { kind: 'note' | 'collection'; id: string } | null = null

/** 自动展开的等待时长(ms)。 */
const EXPAND_DELAY_MS = 700
/** 拖到边缘多少像素内开始自动滚动。 */
const AUTOSCROLL_EDGE = 28

/** 落点状态。 */
interface DropState {
  key: string
  mode: DropMode
  parentId: string | null
  index: number | null
  label: string
  x: number
  y: number
}

/**
 * 笔记树。
 * @param props - 见 {@link TreePaneProps}。
 */
export function TreePane(props: TreePaneProps): React.ReactElement {
  const { t, tree, loading, error, selectedId } = props
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [drop, setDrop] = useState<DropState | null>(null)
  /** 右键菜单(位置 + 属于哪一行)。 */
  const [menu, setMenu] = useState<{ x: number; y: number; row: Row } | null>(null)
  const expandTimer = useRef<number | null>(null)

  const rows = useMemo<Row[]>(() => {
    if (tree === null) return []
    const out: Row[] = []
    const childrenOf = new Map<string | null, string[]>()
    for (const node of tree.collections) {
      const list = childrenOf.get(node.parentId) ?? []
      list.push(node.id)
      childrenOf.set(node.parentId, list)
    }
    const notesOf = new Map<string | null, TreeNote[]>()
    for (const note of tree.notes) {
      const list = notesOf.get(note.collectionId) ?? []
      list.push(note)
      notesOf.set(note.collectionId, list)
    }
    const labelOf = new Map(tree.collections.map((node) => [node.id, node.name]))
    const pathOf = (parentId: string | null): string => {
      const parts: string[] = []
      let cursor = parentId
      const guard = new Set<string>()
      while (cursor !== null && !guard.has(cursor)) {
        guard.add(cursor)
        parts.unshift(labelOf.get(cursor) ?? '?')
        cursor = tree.collections.find((node) => node.id === cursor)?.parentId ?? null
      }
      return parts.join(' / ')
    }

    const walk = (parentId: string | null, depth: number): void => {
      const collections = childrenOf.get(parentId) ?? []
      collections.forEach((nodeId, order) => {
        const node = tree.collections.find((item) => item.id === nodeId)
        if (node === undefined) return
        const kids = (childrenOf.get(node.id) ?? []).length + (notesOf.get(node.id) ?? []).length
        out.push({
          key: `c:${node.id}`,
          kind: 'collection',
          depth,
          label: node.name,
          hint: t('tree.collectionHint'),
          count: node.count,
          hasChildren: kids > 0,
          collapsed: collapsed.has(node.id),
          drag: { kind: 'collection', id: node.id },
          dropAs: node.id,
          parentId,
          index: order,
          childCount: kids,
          path: [pathOf(parentId), node.name].filter(Boolean).join(' / '),
        })
        if (collapsed.has(node.id)) return
        walk(node.id, depth + 1)
      })
      ;(notesOf.get(parentId) ?? []).forEach((note, order) => {
        out.push({
          key: `n:${note.id}`,
          kind: 'note',
          depth,
          label: note.title,
          hint: note.relPath,
          selected: note.id === selectedId,
          badge: note.pinned ? '★' : undefined,
          drag: { kind: 'note', id: note.id },
          parentId,
          index: order,
          path: [pathOf(parentId), note.title].filter(Boolean).join(' / '),
          target: note,
        })
      })
    }
    walk(null, 0)

    tree.refs.forEach((ref) => {
      out.push({
        key: `r:${ref.noteId}`,
        kind: 'ref',
        depth: 0,
        label: ref.title,
        hint: `${ref.relPath} · ${t('tree.refHint').replace('{name}', ref.workspaceName)}`,
        badge: `↗ ${ref.workspaceName}`,
        target: ref,
      })
    })

    if (tree.unfiled.length > 0) {
      const unfiledCount = tree.unfiled.length
      out.push({
        key: 'unfiled',
        kind: 'collection',
        depth: 0,
        label: t('tree.unfiled'),
        hint: t('tree.unfiledHint'),
        count: unfiledCount,
        hasChildren: true,
        collapsed: collapsed.has('__unfiled'),
        dropAs: '__unfiled',
        parentId: null,
        index: childrenOf.get(null)?.length ?? 0,
        childCount: unfiledCount,
        path: t('tree.unfiled'),
      })
      if (!collapsed.has('__unfiled')) {
        tree.unfiled.forEach((file, order) => {
          out.push({
            key: `u:${file.path}`,
            kind: 'unfiled',
            depth: 1,
            label: file.title,
            hint: file.relPath,
            badge: tree.unfiledTruncated ? '…' : undefined,
            parentId: '__unfiled',
            index: order,
            path: `${t('tree.unfiled')} / ${file.title}`,
            target: file,
          })
        })
      }
    }
    return out
  }, [tree, collapsed, selectedId, t])

  /** 顶层子项数(拖到空白处 = 追加到顶层末尾)。笔记与分类各自成序,要分开算。 */
  const rootCollections = rows.filter((row) => row.kind === 'collection' && (row.parentId ?? null) === null && row.dropAs !== '__unfiled').length
  const rootNotes = rows.filter((row) => row.kind === 'note' && (row.parentId ?? null) === null).length

  const toggle = (collectionId: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(collectionId)) next.delete(collectionId)
      else next.add(collectionId)
      return next
    })
  }

  /** 清理拖动会话。 */
  const endDrag = (): void => {
    dragging = null
    if (expandTimer.current !== null) window.clearTimeout(expandTimer.current)
    expandTimer.current = null
    setDrop(null)
  }

  // 右键菜单:点别处 / Esc 关闭
  useEffect(() => {
    if (menu === null) return undefined
    const close = (): void => setMenu(null)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  /** 落下:按落点算出 (父, 位置) 再交给外壳。 */
  const applyDrop = (): void => {
    const payload = dragging
    const target = drop
    endDrag()
    if (payload === null || target === null) return
    if (typeof target.parentId === 'string' && target.parentId.startsWith('__')) return
    if (payload.kind === 'note') props.onMoveNote(payload.id, target.parentId, target.index)
    else props.onMoveCollection(payload.id, target.parentId, target.index)
  }

  /** 这个分类是不是拖动源的子孙(用于拒绝非法落点)。 */
  const isDescendant = (collectionId: string): boolean => {
    if (dragging === null || dragging.kind !== 'collection') return false
    let cursor: string | null = collectionId
    while (cursor !== null) {
      if (cursor === dragging.id) return true
      cursor = tree?.collections.find((node) => node.id === cursor)?.parentId ?? null
    }
    return false
  }

  /** 同一父、同一类(分类/笔记各自成序)的可见兄弟。 */
  const siblingsOf = (row: Row): Row[] =>
    rows.filter(
      (item) => item.kind === row.kind && (item.parentId ?? null) === (row.parentId ?? null) && item.drag !== undefined,
    )

  /**
   * 键盘整理:`Alt+↑/↓` 同级排序、`Alt+←` 升级(移到父级之后)、`Alt+→` 降级(成为上一个兄弟的子项)。
   *
   * 位置语义与拖放一致:「插到当前画面里第 N 项之前」;`null` = 追加到末尾。
   */
  const moveByKey = (row: Row, direction: 'up' | 'down' | 'out' | 'in'): void => {
    if (row.drag === undefined) return
    const noteId = row.drag.kind === 'note' ? row.drag.id : null
    const collectionId = row.drag.kind === 'collection' ? row.drag.id : null
    const apply = (parentId: string | null, index: number | null): void => {
      if (noteId !== null) props.onMoveNote(noteId, parentId, index)
      else if (collectionId !== null) props.onMoveCollection(collectionId, parentId, index)
    }
    const siblings = siblingsOf(row)
    const position = siblings.findIndex((item) => item.key === row.key)

    if (direction === 'up') {
      if (position <= 0) return
      apply(row.parentId ?? null, position - 1)
      return
    }
    if (direction === 'down') {
      if (position < 0 || position >= siblings.length - 1) return
      // "插到当前画面第 N 项之前":往下挪一格 = 插到"再下一项"之前
      const anchor = siblings[position + 2]
      apply(row.parentId ?? null, anchor === undefined ? null : position + 2)
      return
    }
    if (direction === 'in') {
      // 降级:成为上一个兄弟(必须是分类)
      const previous = position > 0 ? siblings[position - 1] : undefined
      if (previous === undefined || previous.dropAs === undefined || previous.dropAs === null) return
      apply(previous.dropAs, null)
      return
    }
    // 升级:挂到父分类的父级,并排到父后面(order 是 1 基,等于"父的 0 基下标 + 1")
    const parentId = row.parentId ?? null
    if (parentId === null) return
    const parent = tree?.collections.find((node) => node.id === parentId)
    if (parent === undefined) return
    const grandParentId = parent.parentId ?? null
    apply(grandParentId, Number.isFinite(parent.order) ? (parent.order as number) : null)
  }

  /** 右键菜单里的行(把 row 转成菜单需要的信息)。 */
  const menuNote = (row: Row): TreeNote | null => (row.kind === 'note' ? (row.target as TreeNote) ?? null : null)

  /** 计算某一行的落点。 */
  const zoneOf = (row: Row, event: React.DragEvent<HTMLElement>): DropState | null => {
    if (dragging === null) return null
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = rect.height === 0 ? 0.5 : (event.clientY - rect.top) / rect.height
    const pointer = { x: event.clientX, y: event.clientY }
    const insideTarget = row.dropAs !== undefined && row.dropAs !== null && row.dropAs !== '__unfiled'
      ? row.dropAs
      : row.dropAs === '__unfiled'
        ? '__unfiled'
        : undefined

    // 拖分类时,不能放进自己或自己的子孙
    if (dragging.kind === 'collection' && insideTarget !== undefined && isDescendant(insideTarget)) return null

    if (insideTarget !== undefined && ratio >= 0.3 && ratio <= 0.7) {
      return {
        key: row.key,
        mode: 'inside',
        parentId: insideTarget === '__unfiled' ? null : insideTarget,
        index: null,
        label: insideTarget === '__unfiled' ? t('tree.topLevel') : `${t('tree.into')} ${row.path ?? row.label}`,
        ...pointer,
      }
    }
    const mode: DropMode = ratio < 0.5 ? 'before' : 'after'
    const parentId = row.parentId ?? null
    if (typeof parentId === 'string' && parentId.startsWith('__')) return null
    const baseIndex = row.index ?? 0
    return {
      key: row.key,
      mode,
      parentId,
      index: mode === 'before' ? baseIndex : baseIndex + 1,
      label: `${mode === 'before' ? t('tree.before') : t('tree.after')} ${row.path ?? row.label}`,
      ...pointer,
    }
  }

  /** 拖到边缘自动滚动。 */
  const autoScroll = (event: React.DragEvent<HTMLElement>): void => {
    const host = event.currentTarget
    const rect = host.getBoundingClientRect()
    if (event.clientY - rect.top < AUTOSCROLL_EDGE) host.scrollTop -= 8
    else if (rect.bottom - event.clientY < AUTOSCROLL_EDGE) host.scrollTop += 8
  }

  return (
    <div className="dsh-notes-tree-inner">
      <div className="dsh-notes-tree-head">
        <span className="dsh-notes-tree-title" title={tree?.workspace.root ?? ''}>
          {tree?.workspace.name ?? t('tree.title')}
        </span>
        <span className="dsh-notes-spacer" />
        {loading ? <span className="dsh-notes-dim">…</span> : null}
        {props.toolbar !== undefined ? <span className="dsh-notes-toolbar">{props.toolbar}</span> : null}
      </div>
      {props.header}
      {error !== null ? (
        <div className="dsh-notes-error">
          <span className="dsh-notes-error-text">{error}</span>
          <button type="button" className="dsh-notes-error-close" title={t('status.dismiss')} onClick={props.onDismissError}>
            ×
          </button>
        </div>
      ) : null}
      <div
        className={[
          'dsh-notes-tree-body',
          dragging !== null ? 'dsh-notes-tree-body-dragging' : '',
          drop !== null && drop.key === '__root' ? 'dsh-notes-drop-root' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onDragOver={(event) => {
          if (dragging === null) return
          // 行的 dragover 会冒泡到这里;行内已有自己的落点时不能覆盖成「顶层」
          // (实测:拖到某一行上,标签却显示「放到顶层」)
          if ((event.target as HTMLElement).closest?.('.dsh-notes-row') != null) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          autoScroll(event)
          setDrop({
            key: '__root',
            mode: 'inside',
            parentId: null,
            index: dragging.kind === 'note' ? rootNotes : rootCollections,
            label: t('tree.topLevel'),
            x: event.clientX,
            y: event.clientY,
          })
        }}
        onDrop={(event) => {
          event.preventDefault()
          // 外部拖入:系统里的 .md(有 File 对象)或别处拖来的路径
          const files = Array.from(event.dataTransfer?.files ?? [])
          if (dragging === null) {
            const text = event.dataTransfer?.getData('text/plain') ?? ''
            const uri = event.dataTransfer?.getData('text/uri-list') ?? ''
            const candidate = (uri !== '' ? uri : text).replace(/^file:\/\//, '').trim()
            if (files.length > 0) {
              props.onImportFiles(files)
              return
            }
            if (/\.md$/i.test(candidate)) {
              props.onRegisterPath(decodeURI(candidate))
              return
            }
            return
          }
          if (drop?.key === '__root') applyDrop()
          else endDrag()
        }}
        onContextMenu={(event) => {
          // 空白处右键 = 顶层的新建菜单
          if ((event.target as HTMLElement).closest?.('.dsh-notes-row') != null) return
          event.preventDefault()
          setMenu({
            x: event.clientX,
            y: event.clientY,
            row: { key: '__blank', kind: 'collection', depth: 0, label: '', dropAs: null, parentId: null },
          })
        }}
      >
        {rows.length === 0 && !loading ? (
          <div className="dsh-notes-empty">{t('tree.empty')}</div>
        ) : (
          rows.map((row) => {
            const active = drop?.key === row.key
            return (
              <div
                key={row.key}
                className={[
                  'dsh-notes-row',
                  `dsh-notes-row-${row.kind}`,
                  row.selected ? 'dsh-notes-row-selected' : '',
                  active && drop?.mode === 'before' ? 'dsh-notes-row-ins-before' : '',
                  active && drop?.mode === 'after' ? 'dsh-notes-row-ins-after' : '',
                  active && drop?.mode === 'inside' ? 'dsh-notes-row-ins-inside' : '',
                  dragging !== null && row.drag !== undefined && dragging.id === row.drag.id ? 'dsh-notes-row-dragging' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{ paddingLeft: `${6 + row.depth * 12}px` }}
                role="treeitem"
                aria-selected={row.selected === true}
                title={row.hint}
                tabIndex={0}
                draggable={row.drag !== undefined}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setMenu({ x: event.clientX, y: event.clientY, row })
                }}
                onKeyDown={(event) => {
                  if (!event.altKey) return
                  const map: Record<string, 'up' | 'down' | 'out' | 'in'> = {
                    ArrowUp: 'up',
                    ArrowDown: 'down',
                    ArrowLeft: 'out',
                    ArrowRight: 'in',
                  }
                  const direction = map[event.key]
                  if (direction === undefined) return
                  event.preventDefault()
                  moveByKey(row, direction)
                }}
                onDragStart={(event) => {
                  if (row.drag === undefined) return
                  dragging = row.drag
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', row.key)
                }}
                onDragEnd={endDrag}
                onDragOver={(event) => {
                  if (dragging === null) return
                  const zone = zoneOf(row, event)
                  if (zone === null) {
                    event.dataTransfer.dropEffect = 'none'
                    return
                  }
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDrop(zone)
                  // 悬停自动展开收起的分类
                  if (zone.mode === 'inside' && row.kind === 'collection' && row.collapsed === true) {
                    if (expandTimer.current !== null) window.clearTimeout(expandTimer.current)
                    const id = row.key.slice(2)
                    expandTimer.current = window.setTimeout(() => {
                      setCollapsed((current) => {
                        const next = new Set(current)
                        next.delete(id)
                        return next
                      })
                    }, EXPAND_DELAY_MS)
                  } else if (expandTimer.current !== null) {
                    window.clearTimeout(expandTimer.current)
                    expandTimer.current = null
                  }
                }}
                onDrop={(event) => {
                  if (dragging === null) return
                  event.preventDefault()
                  applyDrop()
                }}
                onClick={() => {
                  if (row.kind === 'collection') toggle(row.key.slice(2))
                  else if (row.kind === 'note' && row.target !== undefined) props.onSelectNote(row.target as TreeNote)
                  else if (row.kind === 'ref' && row.target !== undefined) props.onSelectRef(row.target as TreeRef)
                  else if (row.kind === 'unfiled' && row.target !== undefined) props.onFileAction(row.target as TreeUnfiled)
                }}
              >
                {row.kind === 'collection' ? (
                  <span className="dsh-notes-caret">
                    <IconChevron size={12} open={row.collapsed !== true} />
                  </span>
                ) : (
                  <span className="dsh-notes-caret" />
                )}
                <span className="dsh-notes-glyph" aria-hidden="true">
                  {row.kind === 'collection' ? (
                    <IconCollection size={13} />
                  ) : row.kind === 'unfiled' ? (
                    <IconInbox size={13} />
                  ) : (
                    <IconNote size={13} />
                  )}
                </span>
                {props.renamingKey === row.key && (props.onRenameNote !== undefined || props.onRenameCollection !== undefined) ? (
                <input
                  className="dsh-notes-rename-input"
                  defaultValue={row.label}
                  autoFocus
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      props.onCancelRename?.()
                    }
                  }}
                  onBlur={(event) => {
                    const value = event.currentTarget.value.trim()
                    if (value === '' || value === row.label) {
                      props.onCancelRename?.()
                      return
                    }
                    if (row.kind === 'collection') props.onRenameCollection?.(row.id, value)
                    else if (row.kind === 'note') props.onRenameNote?.(row.key.startsWith('n:') ? row.key.slice(2) : row.key, value)
                  }}
                  onKeyDownCapture={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      event.currentTarget.blur()
                    }
                  }}
                />
              ) : (
                <span className="dsh-notes-row-label" title={row.label}>
                  {row.label}
                </span>
              )}
                {row.count !== undefined && row.count > 0 ? <span className="dsh-notes-count">{row.count}</span> : null}
                {row.badge !== undefined ? <span className="dsh-notes-badge">{row.badge}</span> : null}
              </div>
            )
          })
        )}
        {/* 拖到空白处 = 放到顶层末尾:给一条末端指示线,而不是一个框 */}
        {dragging !== null && drop?.key === '__root' ? <div className="dsh-notes-drop-line" /> : null}
        {/* 就地新建:作为列表里的一行出现(缩进跟随目标分类),上面已有内容不位移 */}
        {props.composer !== undefined && props.composer !== null ? (
          <div
            className="dsh-notes-row dsh-notes-row-compose"
            style={{
              paddingLeft: `${6 + (props.composerParent == null ? 0 : (rows.find((row) => row.key === `c:${props.composerParent}`)?.depth ?? 0) + 1) * 12}px`,
            }}
          >
            {props.composer}
          </div>
        ) : null}
      </div>

      {dragging !== null && drop !== null ? (
        <div className="dsh-notes-drop-chip" style={{ left: drop.x + 14, top: drop.y + 14 }}>
          {drop.label}
        </div>
      ) : null}

      {menu !== null ? (
        <div
          className="dsh-notes-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          onMouseDown={(event) => event.stopPropagation()}
        >
          {(() => {
            const note = menuNote(menu.row)
            const item = (label: string, action: () => void): React.ReactElement => (
              <button
                key={label}
                type="button"
                role="menuitem"
                className="dsh-notes-menu-item"
                onClick={() => {
                  setMenu(null)
                  action()
                }}
              >
                {label}
              </button>
            )
            if (note !== null) {
              return (
                <>
                  {item(note.pinned ? t('menu.unpin') : t('menu.pin'), () => props.onPin(note, !note.pinned))}
                  {item(t('menu.rename'), () => props.onStartRename?.(menu.row.key))}
                  {item(t('menu.copyPath'), () => props.onCopyPath(note.path, note.relPath))}
                  {item(t('menu.reveal'), () => props.onReveal(note.relPath))}
                  {item(t('menu.newNoteHere'), () => props.onNewNote(menu.row.parentId ?? null))}
                  <div className="dsh-notes-menu-sep" />
                  {item(t('menu.unregister'), () => props.onUnregister(note))}
                </>
              )
            }
            if (menu.row.key === '__blank') {
              return (
                <>
                  {item(t('menu.newNote'), () => props.onNewNote(null))}
                  {item(t('menu.newCollection'), () => props.onNewCollection(null))}
                </>
              )
            }
            return (
              <>
                {item(t('menu.newNoteHere'), () => props.onNewNote(menu.row.dropAs ?? null))}
                {item(t('menu.newSubCollection'), () => props.onNewCollection(menu.row.dropAs ?? null))}
              </>
            )
          })()}
        </div>
      ) : null}

      {tree !== null && tree.stats.unfiled === 0 && tree.stats.notes === 0 && !loading ? (
        <div className="dsh-notes-hint">{t('tree.hint')}</div>
      ) : null}
    </div>
  )
}
