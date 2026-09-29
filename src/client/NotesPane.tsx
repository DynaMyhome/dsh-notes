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

import { call, fetchTree, importNote, type Tree, type TreeNote, type TreeRef, type TreeUnfiled } from './api'
import { EditorPane } from './EditorPane'
import { OutlinePane, type OutlineItem } from './OutlinePane'
import { QuickOpen } from './QuickOpen'
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
  /** 新建时的目标分类(右键「在此新建」/ 工具栏 ＋ 用)。 */
  const [composeParent, setComposeParent] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  /** 左列的两个标签页:文件树 / 大纲(Typora 的两个侧栏页)。 */
  const [panelTab, setPanelTab] = useState<'files' | 'outline'>('files')
  /** 当前笔记的标题树(由编辑器回传)。 */
  const [outline, setOutline] = useState<OutlineItem[]>([])
  /** 光标行(大纲高亮当前小节)。 */
  const [cursorLine, setCursorLine] = useState<number | null>(null)
  /** 大纲跳转请求(nonce 变化触发一次)。 */
  const [jump, setJump] = useState<{ line: number; nonce: number }>({ line: 1, nonce: 0 })
  /** 快速打开(Ctrl/Cmd+P、Ctrl/Cmd+K;仅当焦点在笔记区域内)。 */
  const [quickOpen, setQuickOpen] = useState(false)
  /** 大纲拖拽重排章节的请求(nonce 变化触发一次)。 */
  const [outlineMove, setOutlineMove] = useState<{
    fromLine: number
    toLine: number
    mode: 'before' | 'after'
    nonce: number
  } | null>(null)
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
    if (compose !== null && inputRef.current !== null) {
      // 每次打开都把输入框清空;输入框是**非受控**的,提交时直接读 DOM ——
      // 自动输入/输入法(insertText)不一定触发 React 的 onChange,受控绑定会把
      // 已经敲进去的字吞掉(实测:回车/确定拿到的是空标题)。
      inputRef.current.value = ''
      inputRef.current.focus()
    }
  }, [compose])

  // 取消的三条路:点到别处 / Escape / ×。抓 pointerdown 而不是 click,
  // 这样点树里的行时输入条先收起、行的点击照常生效。
  useEffect(() => {
    if (compose === null) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null
      if (target !== null && target.closest('.dsh-notes-compose') !== null) return
      setCompose(null)
      setDraft('')
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [compose])

  /** 跑一条写路由,成功后刷新。 */
  const run = useCallback(
    async (action: string, payload: Record<string, unknown>, done?: (value: any) => void) => {
      if (busy) return
      // 没有会话 = 没有工作区;宁可什么都不做,也不能把写请求发成空 payload
      // (Host 侧现在也会拒绝,这里是第一道闸)。
      if (sessionId === '') {
        setError(t('status.noSession'))
        return
      }
      setBusy(true)
      // 新动作开始就清掉上一次的红字(否则失败信息会一直挂着,像还在报错)
      setError(null)
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
    [busy, refresh, sessionId, t],
  )

  /** 提交新建输入条(标题以 DOM 为准 —— 不信 React state,也不只信一个 ref)。 */
  const submitCompose = useCallback(async () => {
    const domValue = (document.querySelector('.dsh-notes-input') as HTMLInputElement | null)?.value
    const text = String(domValue ?? inputRef.current?.value ?? draft).trim()
    if (text === '' || compose === null) {
      setCompose(null)
      setDraft('')
      return
    }
    if (compose === 'note') {
      await run('create', { title: text, collectionId: composeParent }, (note) => {
        setSelected(note)
        setStatus(t('status.created'))
      })
    } else {
      await run('collection', { op: 'create', name: text, parentId: composeParent }, () => setStatus(t('status.collectionCreated')))
    }
    setCompose(null)
    setDraft('')
  }, [compose, composeParent, draft, run, t])

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

  /** 右键「在此新建笔记 / 新建子分类」。 */
  const startCompose = useCallback((mode: ComposeMode, parentId: string | null) => {
    setTreeOpen(true)
    setPanelTab('files')
    setComposeParent(parentId)
    setCompose(mode)
    setDraft('')
  }, [])

  /** 置顶 / 取消置顶。 */
  const onPin = useCallback(
    (note: TreeNote, pinned: boolean) => {
      void run('pin', { noteId: note.id, pinned }, () => setStatus(pinned ? t('status.pinned') : t('status.unpinned')))
    },
    [run, t],
  )

  /** 移出笔记树(只删索引,永不删文件)。 */
  const onUnregister = useCallback(
    (note: TreeNote) => {
      void run('unregister', { noteId: note.id }, () => setStatus(t('status.unregistered')))
    },
    [run, t],
  )

  /** 复制绝对路径。 */
  const onCopyPath = useCallback(
    (absolute: string, relative: string) => {
      const clipboard = navigator.clipboard
      if (clipboard === undefined) {
        setStatus(t('status.copyFailed'))
        return
      }
      void clipboard.writeText(absolute).then(
        () => setStatus(t('status.pathCopied').replace('{p}', relative)),
        () => setStatus(t('status.copyFailed')),
      )
    },
    [t],
  )

  /**
   * 「在文件树中定位」。
   *
   * 客户端没有"切换/定位官方文件页"的公开服务(见 AGENTS.md:客户端 Service 目录里
   * 只有 layout 的面板/侧栏级动作),所以这里做能做的部分:复制相对路径 + 明确提示,
   * 用户可以直接粘到「文件」页的搜索框。
   */
  const onReveal = useCallback(
    (relative: string) => {
      void navigator.clipboard?.writeText(relative)
      setStatus(t('status.revealHint').replace('{p}', relative))
    },
    [t],
  )

  /** 外部文件拖进来:`.md` 逐个导入成笔记。 */
  const onImportFiles = useCallback(
    (files: File[]) => {
      const markdown = files.filter((file) => /\.md$/i.test(file.name) || file.type === 'text/markdown')
      if (markdown.length === 0) {
        setStatus(t('status.importSkipped'))
        return
      }
      void (async () => {
        for (const file of markdown) {
          try {
            const text = await file.text()
            await importNote(sessionId, file.name, text, composeParent)
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
            return
          }
        }
        await refresh(true)
        setStatus(t('status.imported').replace('{n}', String(markdown.length)))
      })()
    },
    [composeParent, refresh, sessionId, t],
  )

  /** 从别处拖来的单个路径(文件树里的 .md)= 登记。 */
  const onRegisterPath = useCallback(
    (path: string) => {
      void run('register', { path }, () => setStatus(t('status.registered')))
    },
    [run, t],
  )

  /** 点 `[[双链]]`:对得上就打开,对不上就按该标题新建。 */
  const onWikiLink = useCallback(
    (title: string) => {
      const existing = tree?.notes.find((note) => note.title === title)
      if (existing !== undefined) {
        setSelected(existing)
        setSelectedRef(null)
        return
      }
      void run('create', { title, collectionId: selected?.collectionId ?? null }, (note) => {
        setSelected(note)
        setStatus(t('status.created'))
      })
    },
    [run, selected, t, tree],
  )

  /** 双链能否对上(给编辑器上色用)。 */
  const knownTitles = useCallback(() => new Set((tree?.notes ?? []).map((note) => note.title)), [tree])

  /** 拖放:把笔记放到某分类的指定位置(`index` 省略 = 末尾)。 */
  const onMoveNote = useCallback(
    (noteId: string, collectionId: string | null, index: number | null) => {
      void run('move', { noteId, collectionId, index }, () => setStatus(t('status.moved')))
    },
    [run, t],
  )

  /** 拖放:把分类放到某父分类下的指定位置(`index` 省略 = 末尾)。 */
  const onMoveCollection = useCallback(
    (collectionId: string, parentId: string | null, index: number | null) => {
      void run('collection', { op: 'move', collectionId, parentId, index }, () => setStatus(t('status.moved')))
    },
    [run, t],
  )

  const toggleLabel = treeOpen ? t('tree.collapse') : t('tree.expand')

  // 动作区属于**笔记树这一列**(不是区域顶栏):新建笔记 / 新建分类 / 重扫 / 收起。
  const toolbar = (
    <>
      <button
        type="button"
        className="dsh-notes-btn"
        title={t('action.newNote')}
        aria-label={t('action.newNote')}
        disabled={busy}
        onClick={() => {
          setCompose((current) => (current === 'note' ? null : 'note'))
          // 新建的默认落点:跟着当前选中笔记走(同级),没选中就放顶层
          setComposeParent(selected?.collectionId ?? null)
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
          setCompose((current) => (current === 'collection' ? null : 'collection'))
          setComposeParent(null)
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
    </>
  )

  const composeRow =
    compose === null ? null : (
      <div className="dsh-notes-compose">
        <input
          ref={inputRef}
          className="dsh-notes-input"
          defaultValue=""
          placeholder={compose === 'note' ? t('compose.note') : t('compose.collection')}
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
    )

  return (
    <div
      className="dsh-notes-root"
      tabIndex={-1}
      onKeyDown={(event) => {
        // 只在焦点位于笔记区域内时接管:不劫持整个应用的 Ctrl+P(浏览器打印)
        if ((event.ctrlKey || event.metaKey) && (event.key === 'p' || event.key === 'k')) {
          event.preventDefault()
          setQuickOpen(true)
        }
      }}
    >
      {quickOpen ? (
        <QuickOpen
          notes={tree?.notes ?? []}
          onPick={(note) => {
            setSelected(note)
            setSelectedRef(null)
          }}
          onClose={() => setQuickOpen(false)}
        />
      ) : null}
      <div className="dsh-notes-header">
        <span className="dsh-notes-title">{t('tab.title')}</span>
        <span className="dsh-notes-sub">
          {sessionId === ''
            ? t('status.noSession')
            : tree === null
              ? t('tree.loading')
              : t('tree.summary')
                  .replace('{n}', String(tree.stats.notes))
                  .replace('{c}', String(tree.stats.collections))}
        </span>
        <span className="dsh-notes-spacer" />
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
              <div className="dsh-notes-column">
                <div className="dsh-notes-panel-tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={panelTab === 'files'}
                    className={`dsh-notes-panel-tab${panelTab === 'files' ? ' dsh-notes-panel-tab-on' : ''}`}
                    onClick={() => setPanelTab('files')}
                  >
                    {t('panel.files')}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={panelTab === 'outline'}
                    className={`dsh-notes-panel-tab${panelTab === 'outline' ? ' dsh-notes-panel-tab-on' : ''}`}
                    onClick={() => setPanelTab('outline')}
                  >
                    {t('panel.outline')}
                  </button>
                  {panelTab === 'outline' && outline.length > 0 ? (
                    <span className="dsh-notes-count">{outline.length}</span>
                  ) : null}
                </div>
                {panelTab === 'files' ? (
                  <TreePane
                    t={t}
                    tree={tree}
                    loading={loading}
                    error={error}
                    selectedId={selected?.id ?? null}
                    toolbar={toolbar}
                    header={composeRow}
                    onSelectNote={(note) => {
                      setSelected(note)
                      setSelectedRef(null)
                    }}
                    onSelectRef={(ref) => {
                      setSelectedRef(ref)
                      setSelected(null)
                    }}
                    onFileAction={onFileAction}
                    onMoveNote={onMoveNote}
                    onMoveCollection={onMoveCollection}
                    onPin={onPin}
                    onUnregister={onUnregister}
                    onCopyPath={onCopyPath}
                    onReveal={onReveal}
                    onNewNote={(collectionId) => startCompose('note', collectionId)}
                    onNewCollection={(parentId) => startCompose('collection', parentId)}
                    onImportFiles={onImportFiles}
                    onRegisterPath={onRegisterPath}
                    onDismissError={() => setError(null)}
                  />
                ) : (
                  <OutlinePane
                    t={t}
                    items={outline}
                    activeLine={cursorLine}
                    onJump={(line) => setJump({ line, nonce: jump.nonce + 1 })}
                    onMove={(fromLine, toLine, mode) =>
                      setOutlineMove({ fromLine, toLine, mode, nonce: (outlineMove?.nonce ?? 0) + 1 })
                    }
                  />
                )}
              </div>
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
          <div className="dsh-notes-rail">
            <button
              type="button"
              className="dsh-notes-btn"
              title={t('action.newNote')}
              aria-label={t('action.newNote')}
              onClick={() => {
                setTreeOpen(true)
                setCompose('note')
                setComposeParent(selected?.collectionId ?? null)
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
              onClick={() => {
                setTreeOpen(true)
                setCompose('collection')
                setComposeParent(null)
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
              aria-expanded={false}
              onClick={() => setTreeOpen(true)}
            >
              ▸
            </button>
          </div>
        )}
        <section className="dsh-notes-editor">
          {selectedRef !== null ? (
            <div className="dsh-notes-placeholder">
              <div className="dsh-notes-placeholder-title">{selectedRef.title}</div>
              <div className="dsh-notes-dim">{t('editor.refFrom').replace('{name}', selectedRef.workspaceName)}</div>
              <div className="dsh-notes-dim dsh-notes-mono">{selectedRef.relPath}</div>
            </div>
          ) : selected !== null ? (
            <EditorPane
              key={selected.id}
              t={t}
              sessionId={sessionId}
              note={selected}
              onOutline={setOutline}
              onCursorLine={setCursorLine}
              onWikiLink={onWikiLink}
              getKnownTitles={knownTitles}
              outlineMove={outlineMove}
              jumpTo={jump}
            />
          ) : (
            <div className="dsh-notes-empty">{t('editor.noSelection')}</div>
          )}
        </section>
      </div>
    </div>
  )
}
