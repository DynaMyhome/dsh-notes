/**
 * 回收站面板。
 *
 * 「删除」不真删:文件先挪进 `$DSH_HOME/knowledge/trash`(笔记根之外,重扫不会捞回来),
 * 这里给「恢复 / 彻底删除 / 清空」。**彻底删除**是唯一真的 `unlink` 的入口,而且要点两次
 * (`清空回收站` → 再确认一次),防误删。
 */

import type React from 'react'
import { useState } from 'react'

import type { TrashEntry } from './api'

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
  const t = props.t
  const [confirmAll, setConfirmAll] = useState(false)
  const [confirmOne, setConfirmOne] = useState<string | null>(null)

  return (
    <div
      style={{
        position: 'absolute',
        inset: '0',
        zIndex: 70,
        background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '42px',
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div
        style={{
          width: '92%',
          maxWidth: '520px',
          maxHeight: '70%',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '10px',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-overlay)',
          boxShadow: '0 16px 40px rgba(0,0,0,.28)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 10px',
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
          }}
        >
          <span style={{ fontSize: '13px', fontWeight: 600 }}>{t('trash.title')}</span>
          <span style={{ fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' }}>
            {t('trash.root').replace('{p}', props.root)}
          </span>
          <span style={{ flex: '1 1 auto' }} />
          <button
            type="button"
            className="dsh-notes-btn"
            disabled={props.entries.length === 0}
            style={confirmAll ? { color: 'var(--dsw-alias-state-error-primary)' } : undefined}
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
        <div style={{ padding: '6px 10px', fontSize: '11px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' }}>
          {t('trash.hint')}
        </div>
        <div style={{ flex: '1 1 auto', minHeight: '0', overflow: 'auto', padding: '2px 6px 8px' }}>
          {props.loading ? (
            <div style={{ padding: '10px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
              {t('trash.loading')}
            </div>
          ) : props.entries.length === 0 ? (
            <div style={{ padding: '10px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
              {t('trash.empty')}
            </div>
          ) : (
            props.entries.map((entry) => (
              <div
                key={entry.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '5px 6px',
                  borderBottom: '1px solid var(--dsw-alias-border-l1)',
                }}
              >
                <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12.5px' }}>
                  {entry.title}
                  {entry.exists ? null : (
                    <span style={{ color: 'var(--dsw-alias-state-error-primary)', marginLeft: '6px', fontSize: '11px' }}>
                      {t('trash.missing')}
                    </span>
                  )}
                </span>
                <span style={{ flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' }}>
                  {stamp(entry.deletedAt)}
                </span>
                <button
                  type="button"
                  className="dsh-notes-btn"
                  disabled={!entry.exists}
                  onClick={() => props.onRestore(entry)}
                >
                  {t('trash.restore')}
                </button>
                <button
                  type="button"
                  className="dsh-notes-btn"
                  style={confirmOne === entry.id ? { color: 'var(--dsw-alias-state-error-primary)' } : undefined}
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
