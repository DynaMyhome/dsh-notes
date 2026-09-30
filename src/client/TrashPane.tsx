/**
 * 回收站面板。
 *
 * 「删除」不真删:文件先挪进 `$DSH_HOME/knowledge/trash`(笔记根之外,重扫不会捞回来),
 * 这里给「恢复 / 彻底删除 / 清空」。**彻底删除**是唯一真的 `unlink` 的入口,而且要点两次
 * (`清空回收站` → 再确认一次),防误删。
 */

import React, { useEffect, useState } from 'react'

import type { TrashEntry } from './api'
import { IconTrash } from './icons'
import { cssSize } from './scale'

/** 面板 props。 */
export interface TrashPaneProps {
  /** 框架注入的翻译函数。 */
  t: (key: string) => string
  /** 当前清单。 */
  entries: TrashEntry[]
  /** 回收站目录(展示用)。 */
  root: string
  loading: boolean
  onRestore: (entry: TrashEntry) => void
  onPurge: (entry: TrashEntry) => void
  onPurgeAll: () => void
  onClose: () => void
}

/** 把时间戳写成 `MM-DD HH:mm`。 */
function stamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 渲染回收站面板。
 * @param props - 见 {@link TrashPaneProps}。
 */
export function TrashPane(props: TrashPaneProps): React.ReactElement {
  // Esc 关闭(点外部在下面的遮罩上处理)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props])
  const t = props.t
  const [confirmAll, setConfirmAll] = useState(false)
  const [confirmOne, setConfirmOne] = useState<string | null>(null)

  return (
    <div
      className="dsh-notes-panel-overlay"
      role="dialog"
      aria-label={t('trash.title')}
      onMouseDown={(event) => {
        // 点遮罩本身才关(点面板内部不关)
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div className="dsh-notes-panel dsh-notes-panel-sm">
        <div className="dsh-notes-panel-head">
          <span className="dsh-notes-panel-title">{t('trash.title')}</span>
          <span className="dsh-notes-panel-stats">{t('trash.root').replace('{p}', props.root)}</span>
          <span className="dsh-notes-spacer" />
          <button
            type="button"
            className={`dsh-notes-btn${confirmAll ? ' dsh-notes-trash-danger' : ''}`}
            disabled={props.entries.length === 0}
            onClick={() => {
              if (!confirmAll) {
                setConfirmAll(true)
                return
              }
              setConfirmAll(false)
              props.onPurgeAll()
            }}
          >
            {confirmAll ? t('trash.confirm') : t('trash.purgeAll')}
          </button>
          <button type="button" className="dsh-notes-btn" onClick={props.onClose}>
            {t('trash.close')}
          </button>
        </div>

        <div className="dsh-notes-panel-note">{t('trash.hint')}</div>

        <div className="dsh-notes-trash-list">
          {props.loading ? (
            <div className="dsh-notes-dim dsh-notes-panel-pad">{t('trash.loading')}</div>
          ) : props.entries.length === 0 ? (
            <div className="dsh-notes-trash-empty">
              <IconTrash size={22} />
              <span>{t('trash.empty')}</span>
            </div>
          ) : (
            props.entries.map((entry) => (
              <div key={entry.id} className="dsh-notes-trash-row">
                <IconTrash size={13} />
                <span className="dsh-notes-trash-name">
                  {entry.title}
                  {entry.exists ? null : <span className="dsh-notes-trash-danger" style={{ marginLeft: 6, fontSize: cssSize(11) }}>{t('trash.missing')}</span>}
                </span>
                <span className="dsh-notes-trash-meta">{stamp(entry.deletedAt)}</span>
                <button type="button" className="dsh-notes-btn" disabled={!entry.exists} onClick={() => props.onRestore(entry)}>
                  {t('trash.restore')}
                </button>
                <button
                  type="button"
                  className={`dsh-notes-btn${confirmOne === entry.id ? ' dsh-notes-trash-danger' : ''}`}
                  onClick={() => {
                    if (confirmOne !== entry.id) {
                      setConfirmOne(entry.id)
                      return
                    }
                    setConfirmOne(null)
                    props.onPurge(entry)
                  }}
                >
                  {confirmOne === entry.id ? t('trash.confirm') : t('trash.purge')}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
