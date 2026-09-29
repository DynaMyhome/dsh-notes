/**
 * 笔记编辑区(CodeMirror 6,所见即所得)。
 *
 * 行为:
 *   - 打开即读正文 + **版本号**(与 save 同源);改字后 800ms 自动保存;
 *   - `Ctrl/Cmd+S` 立即保存(在 CM6 的 keymap 里);
 *   - 守卫式保存:版本不符 → **冲突条**(重新载入 / 覆盖),绝不静默覆盖;
 *   - 工具栏:粗体/斜体/高亮/H1-3/列表/引用/行内码/图片。
 *
 * 文件始终是纯 md:编辑器只改源码,渲染由 CM6 装饰层完成(见 editor/setup.ts)。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'

import { parseOutline } from '../../lib/outline.js'
import { RouteError, readNote, saveNote, uploadAsset, type TreeNote } from './api'
import {
  createEditor,
  insertImageSnippet,
  toggleLinePrefix,
  wrapSelection,
  type EditorHandle,
} from './editor/setup'
import type { OutlineItem } from './OutlinePane'
import { setSourceMode as applySourceMode } from './editor/mode'
import {
  IconBold,
  IconCheck,
  IconCode,
  IconHeading,
  IconHighlight,
  IconImage,
  IconItalic,
  IconList,
  IconQuote,
  IconWarn,
} from './icons'

/** 自动保存的静默时长(ms)。 */
const AUTOSAVE_MS = 800

/** props。 */
export interface EditorPaneProps {
  t: (key: string) => string
  sessionId: string
  note: TreeNote
  /** 正文标题树变化(喂给左侧大纲)。 */
  onOutline?: (items: OutlineItem[]) => void
  /** 光标所在行变化(大纲高亮当前小节)。 */
  onCursorLine?: (line: number) => void
  /** 请求跳转到某一行(`nonce` 变化即触发一次)。 */
  jumpTo?: { line: number; nonce: number } | null
  /** 大纲拖拽重排章节的请求(`nonce` 变化即触发一次)。 */
  outlineMove?: { fromLine: number; toLine: number; mode: 'before' | 'after'; nonce: number } | null
  /** 点 `[[双链]]`(外壳决定打开还是新建)。 */
  onWikiLink?: (title: string) => void
  /** 当前工作区已知标题(双链上色用)。 */
  getKnownTitles?: () => Set<string>
}

/** 保存状态。 */
type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

/**
 * 编辑区。
 * @param props - 见 {@link EditorPaneProps}。
 */
export function EditorPane(props: EditorPaneProps): React.ReactElement {
  const { t, sessionId, note } = props
  const outlineRef = useRef(props.onOutline)
  const cursorRef = useRef(props.onCursorLine)
  outlineRef.current = props.onOutline
  cursorRef.current = props.onCursorLine
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<EditorHandle | null>(null)
  const versionRef = useRef<string>('')
  const timerRef = useRef<number | null>(null)
  const dirtyRef = useRef(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [conflict, setConflict] = useState<{ version: string; text: string | null } | null>(null)
  const [docPath, setDocPath] = useState<string | null>(null)
  const [length, setLength] = useState(0)
  /** 源码模式(Typora 式:默认预览,标记全隐藏;要看/改源码时切过来)。 */
  const [sourceMode, setSourceMode] = useState(false)

  /** 保存(守卫式)。 */
  const save = useCallback(async (): Promise<void> => {
    const editor = editorRef.current
    if (editor === null || !dirtyRef.current) return
    const text = editor.getDoc()
    setSaveState('saving')
    try {
      const result = await saveNote(sessionId, note.path, text, versionRef.current)
      versionRef.current = String(result.version)
      dirtyRef.current = false
      setSaveState('saved')
      setConflict(null)
    } catch (caught) {
      if (caught instanceof RouteError && caught.code === 'FS_STALE_VERSION') {
        setConflict({ version: caught.currentVersion ?? '', text: caught.currentText ?? null })
        setSaveState('error')
        return
      }
      setError(caught instanceof Error ? caught.message : String(caught))
      setSaveState('error')
    }
  }, [note.path, sessionId])

  /** 载入笔记并挂上编辑器。 */
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setError(null)
    setConflict(null)
    dirtyRef.current = false
    setSaveState('idle')

    void (async () => {
      try {
        const loaded = await readNote(sessionId, note.path)
        if (cancelled) return
        versionRef.current = String(loaded.version)
        setDocPath(loaded.absolutePath)
        setLength(loaded.text.length)
        outlineRef.current?.(parseOutline(loaded.text))
        const host = hostRef.current
        if (host === null) return
        editorRef.current?.destroy()
        // 切模式靠重建编辑器:装饰插件与块级 StateField 都读这个标志
        applySourceMode(sourceMode)
        editorRef.current = createEditor({
          parent: host,
          doc: loaded.text,
          documentPath: loaded.absolutePath,
          onChange: () => {
            dirtyRef.current = true
            setSaveState('dirty')
            const text = editorRef.current?.getDoc() ?? ''
            setLength(text.length)
            outlineRef.current?.(parseOutline(text))
            if (timerRef.current !== null) window.clearTimeout(timerRef.current)
            timerRef.current = window.setTimeout(() => {
              void save()
            }, AUTOSAVE_MS)
          },
          onSelection: (line: number) => cursorRef.current?.(line),
          // 粘贴/拖入的图片 → 上传到资产目录 → 在光标处插入 markdown 链接
          onImageFile: (file: File) => {
            void (async () => {
              try {
                const asset = await uploadAsset(sessionId, note.id, file.name, file)
                const editor = editorRef.current
                if (editor === null) return
                const range = editor.view.state.selection.main
                editor.view.dispatch({
                  changes: { from: range.from, to: range.to, insert: asset.markdown },
                  selection: { anchor: range.from + asset.markdown.length },
                })
                editor.focus()
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : String(caught))
              }
            })()
          },
          onWikiLink: props.onWikiLink,
          getKnownTitles: props.getKnownTitles,
          onSave: () => {
            if (timerRef.current !== null) window.clearTimeout(timerRef.current)
            void save()
          },
        })
        setStatus('ready')
      } catch (caught) {
        if (cancelled) return
        setError(caught instanceof Error ? caught.message : String(caught))
        setStatus('failed')
      }
    })()

    return () => {
      cancelled = true
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = null
      editorRef.current?.destroy()
      editorRef.current = null
      outlineRef.current?.([])
    }
  }, [note.path, save, sessionId, sourceMode])

  /** 大纲点击 → 跳到该标题行。 */
  useEffect(() => {
    const target = props.jumpTo
    if (target === null || target === undefined) return
    editorRef.current?.scrollToLine(target.line)
  }, [props.jumpTo])

  /** 大纲拖拽 → 在正文里搬移整个章节(纯文本搬移,见 lib/section.js,有单测)。 */
  useEffect(() => {
    const request = props.outlineMove
    if (request === null || request === undefined) return
    editorRef.current?.moveSection(request.fromLine, request.toLine, request.mode)
  }, [props.outlineMove])

  /** 冲突:用磁盘上的内容重新载入。 */
  const reload = useCallback(() => {
    const editor = editorRef.current
    if (editor === null || conflict === null) return
    if (conflict.text !== null) editor.setDoc(conflict.text)
    versionRef.current = conflict.version
    dirtyRef.current = false
    setConflict(null)
    setSaveState('saved')
    setLength(conflict.text?.length ?? 0)
  }, [conflict])

  /** 冲突:以本地内容覆盖(用磁盘版本作为前提)。 */
  const overwrite = useCallback(async () => {
    if (conflict === null) return
    versionRef.current = conflict.version
    dirtyRef.current = true
    setConflict(null)
    await save()
  }, [conflict, save])

  const apply = useCallback((action: (handle: EditorHandle) => void) => {
    const editor = editorRef.current
    if (editor === null) return
    action(editor)
  }, [])

  const stateText =
    status === 'loading'
      ? t('editor.loading')
      : saveState === 'saving'
        ? t('editor.saving')
        : saveState === 'dirty'
          ? t('editor.dirty')
          : saveState === 'error'
            ? t('editor.saveFailed')
            : t('editor.saved')

  return (
    <div className="dsh-notes-editor-pane">
      <div className="dsh-notes-editor-bar">
        <span className="dsh-notes-editor-name" title={docPath ?? note.path}>
          {note.title}
        </span>
        <span className="dsh-notes-spacer" />
        <span className="dsh-notes-toolbar dsh-notes-editor-tools">
          <button type="button" className="dsh-notes-btn" title={t('editor.bold')} aria-label={t('editor.bold')} onClick={() => apply((e) => wrapSelection(e.view, '**'))}>
            <IconBold />
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.italic')} aria-label={t('editor.italic')} onClick={() => apply((e) => wrapSelection(e.view, '*'))}>
            <IconItalic />
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.highlight')} aria-label={t('editor.highlight')} onClick={() => apply((e) => wrapSelection(e.view, '=='))}>
            <IconHighlight />
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.heading')} aria-label={t('editor.heading')} onClick={() => apply((e) => toggleLinePrefix(e.view, '## '))}>
            <IconHeading />
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.list')} aria-label={t('editor.list')} onClick={() => apply((e) => toggleLinePrefix(e.view, '- '))}>
            <IconList />
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.quote')} aria-label={t('editor.quote')} onClick={() => apply((e) => toggleLinePrefix(e.view, '> '))}>
            <IconQuote />
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.code')} aria-label={t('editor.code')} onClick={() => apply((e) => wrapSelection(e.view, '`'))}>
            <IconCode />
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.image')} aria-label={t('editor.image')} onClick={() => apply((e) => insertImageSnippet(e.view))}>
            <IconImage />
          </button>
          <button
            type="button"
            className="dsh-notes-btn"
            title={sourceMode ? t('editor.previewMode') : t('editor.sourceMode')}
            aria-label={sourceMode ? t('editor.previewMode') : t('editor.sourceMode')}
            aria-pressed={sourceMode}
            onClick={() => setSourceMode((current) => !current)}
          >
            {sourceMode ? t('editor.modeSourceShort') : t('editor.modePreviewShort')}
          </button>
          <button type="button" className="dsh-notes-btn" title={t('editor.saveNow')} aria-label={t('editor.saveNow')} onClick={() => void save()}>
            <IconCheck />
          </button>
        </span>
      </div>

      {conflict !== null ? (
        <div className="dsh-notes-conflict">
          <IconWarn size={14} />
          <span className="dsh-notes-conflict-text">{t('editor.conflict')}</span>
          <button type="button" className="dsh-notes-btn" onClick={reload}>
            {t('editor.reload')}
          </button>
          <button type="button" className="dsh-notes-btn" onClick={() => void overwrite()}>
            {t('editor.overwrite')}
          </button>
        </div>
      ) : null}

      {status === 'failed' ? (
        <div className="dsh-notes-error">{error ?? t('editor.loadFailed')}</div>
      ) : (
        <div className="dsh-notes-editor-host" ref={hostRef} />
      )}

      <div className="dsh-notes-editor-status">
        <span>{stateText}</span>
        <span className="dsh-notes-spacer" />
        <span className="dsh-notes-dim">{t('editor.chars').replace('{n}', String(length))}</span>
        <span className="dsh-notes-dim dsh-notes-mono">{note.relPath}</span>
      </div>
    </div>
  )
}
