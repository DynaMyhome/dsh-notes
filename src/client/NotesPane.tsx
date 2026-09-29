/**
 * 笔记区域的外壳(位置决定见下)。
 *
 * 布局:右侧栏「笔记」tab 内部自成分栏 —— [ 可收起的笔记树 | 编辑区 ]。
 * 中央对话与 composer 完全不动;树与编辑区都在本 tab 内,不新开 tab、不新开会话。
 *
 * P1:接索引(树 + 未归类 + 跨工作区映射)+ 新建笔记/分类 + 重扫;
 * P2 起把编辑区换成 CodeMirror 6。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'

import { call, fetchTree, type Tree, type TreeNote, type TreeRef, type TreeUnfiled } from './api'
import { TreePane } from './TreePane'

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
  /** 当前会话(决定工作区;右栏 tab 是 session 作用域)。 */
  sessionId?: string
}

/** 新建输入条的两种模式。 */
type ComposeMode = 'note' | 'collection'

/**
 * 笔记区域外壳。
 * @param props - 槽位组合 props。
 */
export function NotesPane(props: NotesPaneProps): React.ReactElement {
  const t = props.t
  const sessionId = props.sessionId ?? ''
  const [treeOpen, setTreeOpen] = useState(true)
  const [treeWidth, setTreeWidth] = useState(TREE_DEFAULT)
  const [tree, setTree] = useState<Tree | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [selected, setSelected] = useState<TreeNote | null>(null)
  const [selectedRef, setSelectedRef] = useState<TreeRef | null>(null)
  const [compose, setCompose] = useState<ComposeMode | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  /** 拉一次树(force 会忽略 Host 侧扫描冷却)。 */
  const refresh = useCallback(
    async (force = false) => {
      if (sessionId === '') return
      setLoading(true)
      try {
        const next = await fetchTree(sessionId, force)
        setTree(next)
        setError(null)
        setSelected((current) => {
          if (current === null) return current
          return next.notes.find((note) => note.id === current.id) ?? null
        })
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setLoading(false)
      }
    },
    [sessionId],
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 回到这个窗口时对一次账(外部改名/删除不必等手动刷新)
  useEffect(() => {
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  useEffect(() => {
    if (compose !== null) inputRef.current?.focus()
  }, [compose])

  /** 跑一条写路由,成功后刷新。 */
  const run = useCallback(
    async (action: string, payload: Record<string, unknown>, done?: (value: any) => void) => {
      if (busy) return
      setBusy(true)
      try {
        const value = await call(action, { sessionId, ...payload })
        done?.(value)
        await refresh(true)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setBusy(false)
      }
    },
    [busy, refresh, sessionId],
  )

  /** 提交新建输入条。 */
  const submitCompose = useCallback(async () => {
    const text = draft.trim()
    if (text === '' || compose === null) {
      setCompose(null)
      setDraft('')
      return
    }
    if (compose === 'note') {
      await run('create', { title: text, collectionId: selected?.collectionId ?? null }, (note) => {
        setSelected(note)
        setStatus(t('status.created'))
      })
    } else {
      await run('collection', { op: 'create', name: text, parentId: null }, () => setStatus(t('status.collectionCreated')))
    }
    setCompose(null)
    setDraft('')
  }, [compose, draft, run, selected, t])

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture?.(event.pointerId)
      drag.current = { startX: event.clientX, startWidth: treeWidth }
      event.preventDefault()
    },
    [treeWidth],
  )

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (state === null) return
    setTreeWidth(Math.min(TREE_MAX, Math.max(TREE_MIN, state.startWidth + (event.clientX - state.startX))))
  }, [])

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }, [])

  /** 未归类文件:点一下就纳入笔记树(P1 的最省事整理动作)。 */
  const onFileAction = useCallback(
    (file: TreeUnfiled) => {
      void run('register', { path: file.path }, () => setStatus(t('status.registered')))
    },
    [run, t],
  )

  const toggleLabel = treeOpen ? t('tree.collapse') : t('tree.expand')

  return (
    <div className="dsh-notes-root">
      <div className="dsh-notes-header">
        <span className="dsh-notes-title">{t('tab.title')}</span>
        <span className="dsh-notes-sub">
          {tree === null ? t('tree.loading') : t('tree.summary').replace('{n}', String(tree.stats.notes))}
        </span>
        <span className="dsh-notes-spacer" />
        <button
          type="button"
          className="dsh-notes-btn"
          title={t('action.newNote')}
          aria-label={t('action.newNote')}
          disabled={busy}
          onClick={() => {
            setCompose('note')
            setDraft('')
          }}
        >
          ＋
        </button>
        <button
          type="button"
          className="dsh-notes-btn"
          title={t('action.newCollection')}
          aria-label={t('action.newCollection')}
          disabled={busy}
          onClick={() => {
            setCompose('collection')
            setDraft('')
          }}
        >
          ⊞
        </button>
        <button
          type="button"
          className="dsh-notes-btn"
          title={t('action.rescan')}
          aria-label={t('action.rescan')}
          disabled={busy || loading}
          onClick={() => {
            void refresh(true).then(() => setStatus(t('status.rescanned')))
          }}
        >
          ⟳
        </button>
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
      {status !== null ? (
        <div className="dsh-notes-status" onAnimationEnd={() => setStatus(null)}>
          {status}
        </div>
      ) : null}
      <div className="dsh-notes-body">
        {treeOpen ? (
          <>
            <aside className="dsh-notes-tree" style={{ width: `${treeWidth}px` }}>
              {compose !== null ? (
                <div className="dsh-notes-compose">
                  <input
                    ref={inputRef}
                    className="dsh-notes-input"
                    value={draft}
                    placeholder={compose === 'note' ? t('compose.note') : t('compose.collection')}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void submitCompose()
                      if (event.key === 'Escape') {
                        setCompose(null)
                        setDraft('')
                      }
                    }}
                  />
                  <button type="button" className="dsh-notes-btn" onClick={() => void submitCompose()}>
                    {t('compose.ok')}
                  </button>
                </div>
              ) : null}
              <TreePane
                t={t}
                tree={tree}
                loading={loading}
                error={error}
                selectedId={selected?.id ?? null}
                onSelectNote={(note) => {
                  setSelected(note)
                  setSelectedRef(null)
                }}
                onSelectRef={(ref) => {
                  setSelectedRef(ref)
                  setSelected(null)
                }}
                onFileAction={onFileAction}
              />
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
          {selectedRef !== null ? (
            <div className="dsh-notes-placeholder">
              <div className="dsh-notes-placeholder-title">{selectedRef.title}</div>
              <div className="dsh-notes-dim">{t('editor.refFrom').replace('{name}', selectedRef.workspaceName)}</div>
              <div className="dsh-notes-dim dsh-notes-mono">{selectedRef.relPath}</div>
            </div>
          ) : selected !== null ? (
            <div className="dsh-notes-placeholder">
              <div className="dsh-notes-placeholder-title">{selected.title}</div>
              <div className="dsh-notes-dim dsh-notes-mono">{selected.relPath}</div>
              <div className="dsh-notes-dim">{t('editor.pending')}</div>
            </div>
          ) : (
            <div className="dsh-notes-empty">{t('editor.noSelection')}</div>
          )}
        </section>
      </div>
    </div>
  )
}
