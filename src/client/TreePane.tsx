/**
 * 笔记树:分类树 + 笔记 + 跨工作区映射 + 未归类文件。
 *
 * 纯展示 + 交互回调;数据与写操作在 {@link NotesPane}。
 *
 * 两类行必须一眼可分(用户反馈:分不清哪个是分类、哪个是笔记):
 *   - 分类:`▾ 📁 名字  (n)` —— 加粗、可折叠、可作拖放目标;
 *   - 笔记:`▪ 📄 标题`      —— 常规字重、次要色,选中时高亮。
 *
 * 拖放(HTML5 DnD,零依赖):
 *   - 笔记 → 拖到**任意层级的分类**行 = 归入该分类;拖到空白/未归类组 = 回到顶层;
 *   - 分类 → 拖到另一个分类行 = 变成它的子分类;拖到空白 = 回到顶层;
 *   - 循环移动由 Host 侧 `collection.move` 的环检测拒绝(会原样报错,不静默)。
 */

import React, { useMemo, useState } from 'react'

import type { Tree, TreeNote, TreeRef, TreeUnfiled } from './api'

/** 组件 props。 */
export interface TreePaneProps {
  t: (key: string) => string
  tree: Tree | null
  loading: boolean
  error: string | null
  selectedId: string | null
  /** 点一篇**本工作区**笔记。 */
  onSelectNote: (note: TreeNote) => void
  /** 点一篇映射进来的笔记(只读跳转,P4 起可编辑)。 */
  onSelectRef: (ref: TreeRef) => void
  /** 点一个未归类文件(P3 起支持一键纳入)。 */
  onFileAction: (file: TreeUnfiled) => void
  /** 把笔记移到某个分类(`null` = 顶层/未归类)。 */
  onMoveNote: (noteId: string, collectionId: string | null) => void
  /** 把分类移到另一个分类下(`null` = 顶层)。 */
  onMoveCollection: (collectionId: string, parentId: string | null) => void
  /** 动作区:新建笔记 / 新建分类 / 重扫 / 收起 —— 由外壳注入,视觉上属于这一列。 */
  toolbar?: React.ReactNode
  /** 头行与树体之间的一行(例如新建输入条)。 */
  header?: React.ReactNode
}

/** 一行在渲染层的形态。 */
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
  /** 拖放身份:`null` 表示不可拖、也不可作为目标。 */
  drag?: { kind: 'note' | 'collection'; id: string }
  /** 是否接受拖放(只有分类行与未归类组是容器)。 */
  dropAs?: string | null
  target?: TreeNote | TreeRef | TreeUnfiled
}

/** 正在拖的东西(模块级:一个 pane 一棵树,不需要 React 状态跟踪它)。 */
let dragging: { kind: 'note' | 'collection'; id: string } | null = null

/**
 * 笔记树。
 * @param props - 见 {@link TreePaneProps}。
 */
export function TreePane(props: TreePaneProps): React.ReactElement {
  const { t, tree, loading, error, selectedId } = props
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [dropTarget, setDropTarget] = useState<string | null>(null)

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
    const walk = (parentId: string | null, depth: number): void => {
      for (const nodeId of childrenOf.get(parentId) ?? []) {
        const node = tree.collections.find((item) => item.id === nodeId)
        if (node === undefined) continue
        const kids = (childrenOf.get(node.id) ?? []).length + (notesOf.get(node.id) ?? []).length
        const isCollapsed = collapsed.has(node.id)
        out.push({
          key: `c:${node.id}`,
          kind: 'collection',
          depth,
          label: node.name,
          hint: t('tree.collectionHint'),
          count: node.count,
          hasChildren: kids > 0,
          collapsed: isCollapsed,
          drag: { kind: 'collection', id: node.id },
          dropAs: node.id,
        })
        if (isCollapsed) continue
        walk(node.id, depth + 1)
      }
      for (const note of notesOf.get(parentId) ?? []) {
        out.push({
          key: `n:${note.id}`,
          kind: 'note',
          depth,
          label: note.title,
          hint: note.relPath,
          selected: note.id === selectedId,
          badge: note.pinned ? '★' : undefined,
          drag: { kind: 'note', id: note.id },
          target: note,
        })
      }
    }
    walk(null, 0)
    for (const ref of tree.refs) {
      out.push({
        key: `r:${ref.noteId}`,
        kind: 'ref',
        depth: 0,
        label: ref.title,
        hint: `${ref.relPath} · ${t('tree.refHint').replace('{name}', ref.workspaceName)}`,
        badge: `↗ ${ref.workspaceName}`,
        target: ref,
      })
    }
    if (tree.unfiled.length > 0) {
      out.push({
        key: 'unfiled',
        kind: 'collection',
        depth: 0,
        label: t('tree.unfiled'),
        hint: t('tree.unfiledHint'),
        count: tree.unfiled.length,
        hasChildren: true,
        collapsed: collapsed.has('__unfiled'),
        dropAs: '__unfiled',
      })
      if (!collapsed.has('__unfiled')) {
        for (const file of tree.unfiled) {
          out.push({
            key: `u:${file.path}`,
            kind: 'unfiled',
            depth: 1,
            label: file.title,
            hint: file.relPath,
            badge: tree.unfiledTruncated ? '…' : undefined,
            target: file,
          })
        }
      }
    }
    return out
  }, [tree, collapsed, selectedId, t])

  const toggle = (key: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      const id = key.startsWith('c:') ? key.slice(2) : '__unfiled'
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 落下:把正在拖的东西放进目标分类(或顶层)。 */
  const drop = (collectionId: string | null): void => {
    const payload = dragging
    dragging = null
    setDropTarget(null)
    if (payload === null) return
    if (payload.kind === 'note') props.onMoveNote(payload.id, collectionId)
    else props.onMoveCollection(payload.id, collectionId)
  }

  /** 只有容器行接受拖放,且不能拖到自己身上。 */
  const accepts = (row: Row): boolean => {
    if (row.dropAs === null || row.dropAs === undefined) return false
    if (dragging === null) return false
    if (dragging.kind === 'collection' && dragging.id === row.dropAs) return false
    return true
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
      {error !== null ? <div className="dsh-notes-error">{error}</div> : null}
      <div
        className={`dsh-notes-tree-body${dropTarget === '__root' ? ' dsh-notes-drop-root' : ''}`}
        onDragOver={(event) => {
          if (dragging === null) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setDropTarget('__root')
        }}
        onDragLeave={() => setDropTarget((current) => (current === '__root' ? null : current))}
        onDrop={(event) => {
          event.preventDefault()
          drop(null)
        }}
      >
        {rows.length === 0 && !loading ? (
          <div className="dsh-notes-empty">{t('tree.empty')}</div>
        ) : (
          rows.map((row) => (
            <div
              key={row.key}
              className={[
                'dsh-notes-row',
                `dsh-notes-row-${row.kind}`,
                row.selected ? 'dsh-notes-row-selected' : '',
                dropTarget === row.key ? 'dsh-notes-row-drop' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ paddingLeft: `${6 + row.depth * 12}px` }}
              role="treeitem"
              aria-selected={row.selected === true}
              title={row.hint}
              draggable={row.drag !== undefined}
              onDragStart={(event) => {
                if (row.drag === undefined) return
                dragging = row.drag
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', row.key)
              }}
              onDragEnd={() => {
                dragging = null
                setDropTarget(null)
              }}
              onDragOver={(event) => {
                if (!accepts(row)) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDropTarget(row.key)
              }}
              onDragLeave={() => setDropTarget((current) => (current === row.key ? null : current))}
              onDrop={(event) => {
                if (!accepts(row)) return
                event.preventDefault()
                drop(row.dropAs === '__unfiled' ? null : (row.dropAs ?? null))
              }}
              onClick={() => {
                if (row.kind === 'collection') toggle(row.key)
                else if (row.kind === 'note' && row.target !== undefined) props.onSelectNote(row.target as TreeNote)
                else if (row.kind === 'ref' && row.target !== undefined) props.onSelectRef(row.target as TreeRef)
                else if (row.kind === 'unfiled' && row.target !== undefined) props.onFileAction(row.target as TreeUnfiled)
              }}
            >
              {row.kind === 'collection' ? (
                <span className="dsh-notes-caret">{row.collapsed === true ? '▸' : '▾'}</span>
              ) : (
                <span className="dsh-notes-caret" />
              )}
              <span className="dsh-notes-glyph" aria-hidden="true">
                {row.kind === 'collection' ? '📁' : row.kind === 'unfiled' ? '📥' : '📄'}
              </span>
              <span className="dsh-notes-row-label" title={row.label}>
                {row.label}
              </span>
              {row.count !== undefined && row.count > 0 ? <span className="dsh-notes-count">{row.count}</span> : null}
              {row.badge !== undefined ? <span className="dsh-notes-badge">{row.badge}</span> : null}
            </div>
          ))
        )}
      </div>
      {tree !== null && tree.stats.unfiled === 0 && tree.stats.notes === 0 && !loading ? (
        <div className="dsh-notes-hint">{t('tree.hint')}</div>
      ) : null}
    </div>
  )
}
