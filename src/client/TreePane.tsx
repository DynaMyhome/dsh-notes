/**
 * 笔记树(P1:分类树 + 笔记 + 跨工作区映射 + 未归类文件)。
 *
 * 纯展示 + 选择回调;数据与写操作在 {@link NotesPane}。
 * 行结构与交互刻意贴着宿主列表走:小字号、hover 才显动作、缩进即层级。
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
  /** 动作区:新建笔记 / 新建分类 / 重扫 / 收起 —— 由外壳注入,视觉上属于这一列。 */
  toolbar?: React.ReactNode
  /** 头行与树体之间的一行(例如新建输入条)。 */
  header?: React.ReactNode
}

interface Row {
  key: string
  kind: 'collection' | 'note' | 'ref' | 'unfiled'
  depth: number
  label: string
  count?: number
  badge?: string
  selected?: boolean
  hasChildren?: boolean
  collapsed?: boolean
  target?: TreeNote | TreeRef | TreeUnfiled
}

/**
 * 笔记树。
 * @param props - 见 {@link TreePaneProps}。
 */
export function TreePane(props: TreePaneProps): React.ReactElement {
  const { t, tree, loading, error, selectedId } = props
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

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
          count: node.count,
          hasChildren: kids > 0,
          collapsed: isCollapsed,
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
          selected: note.id === selectedId,
          badge: note.pinned ? '★' : undefined,
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
        count: tree.unfiled.length,
        hasChildren: true,
        collapsed: collapsed.has('__unfiled'),
      })
      if (!collapsed.has('__unfiled')) {
        for (const file of tree.unfiled) {
          out.push({
            key: `u:${file.path}`,
            kind: 'unfiled',
            depth: 1,
            label: file.title,
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
      <div className="dsh-notes-tree-body">
        {rows.length === 0 && !loading ? (
          <div className="dsh-notes-empty">{t('tree.empty')}</div>
        ) : (
          rows.map((row) => (
            <div
              key={row.key}
              className={[
                'dsh-notes-row',
                row.selected ? 'dsh-notes-row-selected' : '',
                row.kind === 'ref' ? 'dsh-notes-row-ref' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ paddingLeft: `${6 + row.depth * 12}px` }}
              role="treeitem"
              aria-selected={row.selected === true}
              onClick={() => {
                if (row.kind === 'collection') toggle(row.key)
                else if (row.kind === 'note' && row.target !== undefined) props.onSelectNote(row.target as TreeNote)
                else if (row.kind === 'ref' && row.target !== undefined) props.onSelectRef(row.target as TreeRef)
                else if (row.kind === 'unfiled' && row.target !== undefined) props.onFileAction(row.target as TreeUnfiled)
              }}
            >
              {row.hasChildren === true ? (
                <span className="dsh-notes-caret">{row.collapsed === true ? '▸' : '▾'}</span>
              ) : (
                <span className="dsh-notes-caret" />
              )}
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
