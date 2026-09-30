/**
 * 纳入管理面板:把工作区里的 md 分成三类来收编。
 *
 * - **候选**(未纳入、还没标记):默认「最近」排序(按 mtime),也可按文件夹分组;
 * - **已忽略**(杂项):一条条精确路径 + 批量 glob 规则,都能一键放回候选;
 * - 顶部一行是统计(笔记 / 候选 / 杂项 / 扫描了多少个文件)。
 *
 * 这是独立面板(不是树里的内联列表):md 多的仓库里要靠搜索、多选、批量操作才用得动。
 * 所有操作都只动**映射**,不删文件;「忽略」可以撤销(toast 与「已忽略」段都能恢复)。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { FileEntry, FileScan } from './api'
import { IconRefresh, IconWarn } from './icons'

/** 一段(候选/已忽略)的视图。 */
type Segment = 'recent' | 'folders' | 'ignored'

/** props。 */
export interface CandidatesPanelProps {
  t: (key: string) => string
  scan: FileScan | null
  loading: boolean
  error: string | null
  /** 关面板。 */
  onClose: () => void
  /** 重新扫描(force)。 */
  onRescan: () => void
  /** 纳入这些路径。 */
  onInclude: (paths: string[], relPaths: string[]) => void
  /** 标记/取消标记杂项。 */
  onIgnore: (payload: { paths?: string[]; globs?: string[]; on?: boolean }) => void
  /** 改「扫描范围」(工作区相对目录;空数组 = 回到 notesDir)。 */
  onScanRoots: (roots: string[]) => void
}

/** `docs/a/b.md` → `docs/a`。 */
function folderOf(relPath: string): string {
  const index = relPath.lastIndexOf('/')
  return index < 0 ? '' : relPath.slice(0, index)
}

/**
 * 面板。
 * @param props - 见 {@link CandidatesPanelProps}。
 */
export function CandidatesPanel(props: CandidatesPanelProps): React.ReactElement {
  const { t, scan, loading, error } = props
  const [segment, setSegment] = useState<Segment>('recent')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [folder, setFolder] = useState<string | null>(null)
  const [rootDraft, setRootDraft] = useState('')
  const searchRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  // 点面板外面 / 按 Esc 都关掉(和菜单一样的手感)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props])

  // 每次数据变了就清掉选择(选中的路径可能已经不在这批里了)
  useEffect(() => {
    setPicked(new Set())
  }, [scan?.indexAt, segment])

  const candidates = scan?.candidates ?? []
  const ignored = scan?.ignored ?? []
  const stats = scan?.stats ?? { notes: 0, candidates: 0, ignored: 0, total: 0, changed: 0, dirs: 0 }

  /** 过滤(搜索/文件夹)。 */
  const filter = useCallback(
    (list: FileEntry[]): FileEntry[] => {
      const needle = query.trim().toLowerCase()
      return list.filter((file) => {
        if (folder !== null && folderOf(file.relPath) !== folder) return false
        if (needle === '') return true
        return file.relPath.toLowerCase().includes(needle) || file.title.toLowerCase().includes(needle)
      })
    },
    [folder, query],
  )

  const visible = useMemo(() => filter(segment === 'ignored' ? ignored : candidates), [candidates, filter, ignored, segment])

  /** 文件夹分组(「按文件夹」段用):folder → 文件。 */
  const groups = useMemo(() => {
    const map = new Map<string, FileEntry[]>()
    for (const file of visible) {
      const key = folderOf(file.relPath)
      const list = map.get(key)
      if (list === undefined) map.set(key, [file])
      else list.push(file)
    }
    return [...map.entries()].sort((left, right) => left[0].localeCompare(right[0]))
  }, [visible])

  const toggle = (path: string): void => {
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const pickedFiles = visible.filter((file) => picked.has(file.path))
  const pickedPaths = pickedFiles.map((file) => file.path)
  const pickedRel = pickedFiles.map((file) => file.relPath)

  return (
    <div
      className="dsh-notes-panel-overlay"
      role="dialog"
      aria-label={t('files.title')}
      onMouseDown={(event) => {
        // 只在点遮罩本身时关闭(点面板内部不关)
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div className="dsh-notes-panel">
        <div className="dsh-notes-panel-head">
          <span className="dsh-notes-panel-title">{t('files.title')}</span>
          <span className="dsh-notes-panel-stats">
            {t('files.stats')
              .replace('{notes}', String(stats.notes))
              .replace('{candidates}', String(stats.candidates))
              .replace('{ignored}', String(stats.ignored))
              .replace('{total}', String(stats.total))}
          </span>
          <span className="dsh-notes-spacer" />
          <button type="button" className="dsh-notes-btn" title={t('action.rescan')} onClick={props.onRescan} disabled={loading}>
            <IconRefresh />
          </button>
          <button type="button" className="dsh-notes-btn" onClick={props.onClose}>
            {t('files.close')}
          </button>
        </div>

        <div className="dsh-notes-panel-bar">
          <input
            ref={searchRef}
            className="dsh-notes-input dsh-notes-panel-search"
            placeholder={t('files.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="dsh-notes-panel-segments" role="tablist">
            {(['recent', 'folders', 'ignored'] as Segment[]).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={segment === item}
                className={`dsh-notes-panel-tab${segment === item ? ' dsh-notes-panel-tab-on' : ''}`}
                onClick={() => {
                  setSegment(item)
                  setFolder(null)
                }}
              >
                {t(`files.seg.${item}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="dsh-notes-panel-scope">
          <span className="dsh-notes-dim">{t('files.scope')}</span>
          {(scan?.scanRoots ?? []).map((root) => (
            <span key={root === '' ? '__root' : root} className="dsh-notes-scope-chip">
              <span className="dsh-notes-mono">{root === '' ? t('files.wholeWorkspace') : root}</span>
              <button
                type="button"
                className="dsh-notes-btn"
                title={t('files.dropRoot')}
                onClick={() => props.onScanRoots((scan?.scanRoots ?? []).filter((item) => item !== root))}
              >
                ×
              </button>
            </span>
          ))}
          <input
            className="dsh-notes-input dsh-notes-scope-input"
            placeholder={t('files.addRoot')}
            value={rootDraft}
            onChange={(event) => setRootDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              const value = rootDraft.trim().replace(/^\.?\/+/, '').replace(/\/+$/, '')
              if (value === '' && rootDraft.trim() !== '') return
              props.onScanRoots([...(scan?.scanRoots ?? []), value])
              setRootDraft('')
            }}
          />
          <button
            type="button"
            className="dsh-notes-btn"
            title={t('files.wholeHint')}
            onClick={() => props.onScanRoots([''])}
          >
            {t('files.wholeWorkspace')}
          </button>
          {scan?.scanning === true ? (
            <span className="dsh-notes-dim">
              {t('files.scanning')
                .replace('{dirs}', String(scan?.scanProgress?.dirs ?? 0))
                .replace('{files}', String(scan?.stats.total ?? 0))}
            </span>
          ) : null}
          <span className="dsh-notes-spacer" />
        </div>
        {folder !== null ? (
          <div className="dsh-notes-panel-crumb">
            <button
              type="button"
              className="dsh-notes-btn"
              onClick={() => setFolder(null)}
            >
              {t('files.back')}
            </button>
            <span className="dsh-notes-mono">{folder}</span>
          </div>
        ) : null}

        {error !== null || (scan?.scanError ?? null) !== null ? (
          <div className="dsh-notes-panel-error">
            <IconWarn size={14} />
            <span>{error ?? scan?.scanError}</span>
          </div>
        ) : null}

        <div className="dsh-notes-panel-body">
          {loading && scan === null ? <div className="dsh-notes-dim">{t('files.loading')}</div> : null}
          {!loading && visible.length === 0 ? (
            <div className="dsh-notes-dim">{segment === 'ignored' ? t('files.emptyIgnored') : t('files.empty')}</div>
          ) : null}

          {segment === 'folders' && folder === null
            ? groups.map(([name, list]) => (
                <div key={name === '' ? '__root' : name} className="dsh-notes-panel-group">
                  <button
                    type="button"
                    className="dsh-notes-panel-grouph"
                    onClick={() => setFolder(name)}
                  >
                    <span className="dsh-notes-mono">{name === '' ? t('files.rootFolder') : name}</span>
                    <span className="dsh-notes-count">{list.length}</span>
                  </button>
                  <div className="dsh-notes-panel-grouplist">
                    {list.slice(0, 8).map((file) => (
                      <Row
                        key={file.path}
                        t={t}
                        file={file}
                        checked={picked.has(file.path)}
                        onToggle={() => toggle(file.path)}
                        onInclude={segment === 'ignored' ? undefined : () => props.onInclude([file.path], [file.relPath])}
                        onIgnore={segment === 'ignored' ? () => props.onIgnore({ paths: [file.relPath], on: false }) : () => props.onIgnore({ paths: [file.relPath] })}
                      />
                    ))}
                    {list.length > 8 ? (
                      <button type="button" className="dsh-notes-panel-more" onClick={() => setFolder(name)}>
                        {t('files.more').replace('{n}', String(list.length - 8))}
                      </button>
                    ) : null}
                  </div>
                </div>
              ))
            : visible.map((file) => (
                <Row
                  key={file.path}
                  t={t}
                  file={file}
                  checked={picked.has(file.path)}
                  onToggle={() => toggle(file.path)}
                  onInclude={segment === 'ignored' ? undefined : () => props.onInclude([file.path], [file.relPath])}
                  onIgnore={segment === 'ignored' ? () => props.onIgnore({ paths: [file.relPath], on: false }) : () => props.onIgnore({ paths: [file.relPath] })}
                />
              ))}

          {segment === 'ignored' && (scan?.ignoredGlobs ?? []).length > 0 ? (
            <div className="dsh-notes-panel-globs">
              <div className="dsh-notes-panel-grouph">{t('files.rules')}</div>
              {(scan?.ignoredGlobs ?? []).map((pattern) => (
                <div key={pattern} className="dsh-notes-panel-rule">
                  <span className="dsh-notes-mono">{pattern}</span>
                  <button
                    type="button"
                    className="dsh-notes-btn"
                    onClick={() => props.onIgnore({ globs: [pattern], on: false })}
                  >
                    {t('files.dropRule')}
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="dsh-notes-panel-foot">
          {pickedPaths.length > 0 ? (
            <>
              <span className="dsh-notes-dim">{t('files.picked').replace('{n}', String(pickedPaths.length))}</span>
              {segment === 'ignored' ? (
                <button type="button" className="dsh-notes-btn" onClick={() => props.onIgnore({ paths: pickedRel, on: false })}>
                  {t('files.restore')}
                </button>
              ) : (
                <>
                  <button type="button" className="dsh-notes-btn" onClick={() => props.onInclude(pickedPaths, pickedRel)}>
                    {t('files.include')}
                  </button>
                  <button type="button" className="dsh-notes-btn" onClick={() => props.onIgnore({ paths: pickedRel })}>
                    {t('files.ignore')}
                  </button>
                </>
              )}
            </>
          ) : (
            <span className="dsh-notes-dim">{segment === 'ignored' ? t('files.hintIgnored') : t('files.hint')}</span>
          )}
          <span className="dsh-notes-spacer" />
          {scan?.truncated === true ? <span className="dsh-notes-dim">{t('files.truncated')}</span> : null}
        </div>
      </div>
    </div>
  )
}

/** 一行文件。 */
function Row(props: {
  t: (key: string) => string
  file: FileEntry
  checked: boolean
  onToggle: () => void
  onInclude?: () => void
  onIgnore: () => void
}): React.ReactElement {
  const { t, file, checked } = props
  return (
    <div className="dsh-notes-panel-row">
      <input type="checkbox" checked={checked} onChange={props.onToggle} aria-label={file.relPath} />
      <button type="button" className="dsh-notes-panel-name" title={file.relPath} onClick={props.onToggle}>
        <span className="dsh-notes-panel-title2">{file.title}</span>
        <span className="dsh-notes-dim dsh-notes-mono">{file.relPath}</span>
      </button>
      {file.id !== null ? <span className="dsh-notes-badge" title={t('files.hadId')}>{t('files.badge')}</span> : null}
      {props.onInclude !== undefined ? (
        <button type="button" className="dsh-notes-btn" onClick={props.onInclude}>
          {t('files.include')}
        </button>
      ) : null}
      <button type="button" className="dsh-notes-btn" onClick={props.onIgnore}>
        {props.onInclude === undefined ? t('files.restore') : t('files.ignore')}
      </button>
    </div>
  )
}
