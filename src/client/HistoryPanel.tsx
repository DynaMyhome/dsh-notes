/**
 * 历史版本面板(笔记区里的模态浮层)。
 *
 * 为什么需要它:agent 用通用文件工具改笔记,插件拦不住写入 —— 只能靠**快照**兜底
 * (`<工作区>/.dsh-notes/.history/`,捕获点见 `lib/service.js` 的「历史快照」一节)。
 * 这个面板就是那套快照的界面:列出"改动前的几份内容"、能预览、能恢复。
 *
 * 三条界面约定:
 *   - 材质走 `.dsh-notes-panel`(宿主菜单材质 + backdrop-filter):本主题的
 *     `--dsw-alias-bg-*` 是半透明的,不套这层背后正文会穿透可读(审计踩过);
 *   - 字号走 `cssSize()`:跟着笔记区的缩放系数与宿主全局字号变;
 *   - 文案全走 `t()`(英文界面里不许冒出中文,`test/locale-guard.test.mjs` 会拦)。
 */

import React, { useCallback, useEffect, useState } from 'react'

import { fetchHistory, readHistoryEntry, restoreHistory, type HistoryEntry } from './api'
import { IconHistory, IconWarn } from './icons'
import { cssSize } from './scale'

/** props。 */
export interface HistoryPanelProps {
  t: (key: string) => string
  sessionId: string
  noteId: string
  /** 笔记标题(标题栏显示)。 */
  title: string
  onClose: () => void
  /**
   * 恢复成功后的回调:外壳把返回的正文/版本**直接装进编辑器**
   * (不经过保存 —— 恢复本身就是一次写盘,再存一次等于把刚恢复的内容又写回去)。
   */
  onRestored: (result: { text: string; version: string }) => void
}

/** 时间戳 → `MM-DD HH:mm`(与回收站面板同一套写法)。 */
function stamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 字节数 → 便于扫读的一行。 */
function sizeText(size: number): string {
  if (size < 1024) return `${size} B`
  return `${(size / 1024).toFixed(size < 10240 ? 1 : 0)} KB`
}

/**
 * 渲染历史版本面板。
 * @param props - 见 {@link HistoryPanelProps}。
 */
export function HistoryPanel(props: HistoryPanelProps): React.ReactElement {
  const t = props.t
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState('')
  const [busy, setBusy] = useState(false)
  /** 二次确认(恢复是覆盖式写入,值得多点一下)。 */
  const [confirm, setConfirm] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await fetchHistory(props.sessionId, props.noteId)
      setEntries(result.entries)
      setSelected((current) => (current !== null && result.entries.some((item) => item.file === current) ? current : (result.entries[0]?.file ?? null)))
      setError(null)
    } catch (caught) {
      setEntries([])
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [props.noteId, props.sessionId])

  useEffect(() => {
    void load()
  }, [load])

  // 选中哪条就读哪条的正文(读不到只清空预览 + 说一句,不把面板带崩)
  useEffect(() => {
    if (selected === null) {
      setPreview('')
      return undefined
    }
    let cancelled = false
    void readHistoryEntry(props.sessionId, props.noteId, selected)
      .then((result) => {
        if (!cancelled) setPreview(result.text)
      })
      .catch((caught) => {
        if (cancelled) return
        setPreview('')
        setError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => {
      cancelled = true
    }
  }, [props.noteId, props.sessionId, selected])

  // Esc 关闭(点遮罩在下面的 onMouseDown 里处理)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props])

  const applyRestore = async (file: string): Promise<void> => {
    setBusy(true)
    try {
      const result = await restoreHistory(props.sessionId, props.noteId, file)
      setConfirm(null)
      props.onRestored({ text: result.text, version: String(result.version) })
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const current = entries === null ? null : (entries.find((item) => item.file === selected) ?? null)

  return (
    <div
      className="dsh-notes-panel-overlay"
      role="dialog"
      aria-label={t('history.title')}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div className="dsh-notes-panel" style={{ maxWidth: '560px', height: '78%' }}>
        <div className="dsh-notes-panel-head">
          <IconHistory size={14} />
          <span className="dsh-notes-panel-title">{t('history.title')}</span>
          <span className="dsh-notes-panel-stats">
            {props.title} · {t('history.count').replace('{n}', String(entries?.length ?? 0))}
          </span>
          <span className="dsh-notes-spacer" />
          <button type="button" className="dsh-notes-btn" onClick={props.onClose}>
            {t('history.close')}
          </button>
        </div>

        <div className="dsh-notes-panel-note">{t('history.hint')}</div>

        {error !== null ? (
          <div className="dsh-notes-panel-error">
            <IconWarn size={13} />
            <span>{error}</span>
          </div>
        ) : null}

        <div style={{ flex: '0 0 auto', maxHeight: '42%', minHeight: '0', overflow: 'auto', borderBottom: '1px solid var(--dsw-alias-border-l1)' }}>
          {entries === null ? (
            <div className="dsh-notes-dim dsh-notes-panel-pad">{t('history.loading')}</div>
          ) : entries.length === 0 ? (
            <div className="dsh-notes-dim dsh-notes-panel-pad">{t('history.empty')}</div>
          ) : (
            entries.map((entry) => (
              <div key={entry.file} className="dsh-notes-panel-row">
                <button
                  type="button"
                  className="dsh-notes-panel-name"
                  onClick={() => {
                    setSelected(entry.file)
                    setConfirm(null)
                  }}
                  style={{ fontWeight: entry.file === selected ? 600 : 400 }}
                >
                  <span className="dsh-notes-panel-title2">{stamp(entry.at)}</span>
                  <span className="dsh-notes-dim" style={{ fontSize: cssSize(11) }}>
                    {t(`history.origin.${entry.origin}`)} · {sizeText(entry.size)}
                  </span>
                </button>
                <button
                  type="button"
                  className={`dsh-notes-btn${confirm === entry.file ? ' dsh-notes-trash-danger' : ''}`}
                  disabled={busy}
                  onClick={() => {
                    if (confirm !== entry.file) {
                      setConfirm(entry.file)
                      return
                    }
                    void applyRestore(entry.file)
                  }}
                >
                  {confirm === entry.file ? t('history.confirm') : t('history.restore')}
                </button>
              </div>
            ))
          )}
        </div>

        <div
          className="dsh-notes-mono"
          style={{
            flex: '1 1 auto',
            minHeight: '0',
            overflow: 'auto',
            margin: 0,
            padding: '8px 10px',
            fontSize: cssSize(11.5),
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            color: 'var(--dsw-alias-label-primary)',
          }}
        >
          {preview === '' ? <span className="dsh-notes-dim">{current === null ? t('history.pick') : t('history.blank')}</span> : preview}
        </div>
      </div>
    </div>
  )
}
