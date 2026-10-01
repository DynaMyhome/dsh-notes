/**
 * 目录选择器(面板内浮层)。
 *
 * **为什么自己写**:官方给客户端两个入口,`uiWorkspace.pickDirectory()` 要求组合里是
 * `native` capability,而本 profile 装的是 `browse` 后端
 * (`@deepseek-ai/dsh-host-directory-picker-browse` 那一行是活的),`pick` 会被
 * `directory-picker/unavailable` 直接拒绝(实测)。能用的只有 `listDirectory` /
 * `createDirectory` 两个原语 —— 所以就着 `listDirectory` 拼一个面板内浏览器。
 *
 * 三条硬约束:
 *   - **不许走出工作区**:种子是工作区根,面包屑也夹到工作区根为止(用户选的是"扫描范围",
 *     扫到工作区外面既没意义也越界;Host 侧 `setScanRoots` 还会再拦一次);
 *   - **只列目录、且只列扫描器真的会进去的目录**(点目录 / SKIP_DIRS 一律不给,
 *     否则选了也是空的 —— 见 browse-path.ts);
 *   - 显示的是官方给的 **绝对路径**,客户端**绝不自己拼路径段**。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'

import { crumbsWithin, pickValueOf, visibleDirs, type DirListingLike } from './browse-path'
import { IconChevron, IconCollection, IconWarn } from './icons'

/** props。 */
export interface DirPickerProps {
  t: (key: string) => string
  /** 工作区根(绝对路径):浏览器的边界,也是"整个工作区"那个选项。 */
  root: string
  /** 列一层目录(来自 `uiWorkspace.listDirectory`)。 */
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirListingLike>
  /** 选定了某个绝对路径。 */
  onPick: (absolutePath: string) => void
  /** 关掉。 */
  onClose: () => void
}

/**
 * 目录浏览器。
 * @param props - 见 {@link DirPickerProps}。
 */
export function DirPicker(props: DirPickerProps): React.ReactElement {
  const { t, root } = props
  const [current, setCurrent] = useState(root)
  const [listing, setListing] = useState<DirListingLike | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** 只认最后一次请求的结果(用户在目录间快速点的时候,慢的那个不能覆盖新的)。 */
  const requestRef = useRef(0)

  const load = useCallback(
    (path: string) => {
      const token = requestRef.current + 1
      requestRef.current = token
      setLoading(true)
      setError(null)
      props
        .listDirectory(path)
        .then((result) => {
          if (requestRef.current !== token) return
          setListing(result)
          // Host 可能返回规范化后的路径(realpath),以它为准
          if (typeof result.path === 'string' && result.path !== '') setCurrent(result.path)
        })
        .catch((caught) => {
          if (requestRef.current !== token) return
          setListing(null)
          setError(String(caught instanceof Error ? caught.message : caught))
        })
        .finally(() => {
          if (requestRef.current === token) setLoading(false)
        })
    },
    [props],
  )

  useEffect(() => {
    load(root)
    // 只在挂载时按工作区根拉一次;之后由用户点击驱动(load 的身份变化不该重拉)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props])

  const crumbs = listing === null ? [] : crumbsWithin(root, listing.crumbs)
  const dirs = listing === null ? [] : visibleDirs(listing.entries)
  const atRoot = pickValueOf(root, current) === ''
  const pickable = pickValueOf(root, current) !== null
  /** 上一级:面包屑里当前目录的前一个;已经在工作区根就没有。 */
  const parent = crumbs.length >= 2 ? crumbs[crumbs.length - 2].path : null

  return (
    <div
      className="dsh-notes-panel-overlay dsh-notes-panel-overlay-top"
      role="dialog"
      aria-label={t('files.pickTitle')}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div className="dsh-notes-panel dsh-notes-panel-sm dsh-notes-dirpicker">
        <div className="dsh-notes-panel-head">
          <span className="dsh-notes-panel-title">{t('files.pickTitle')}</span>
          <span className="dsh-notes-spacer" />
          <button type="button" className="dsh-notes-btn" onClick={props.onClose}>
            {t('files.pickCancel')}
          </button>
        </div>
        <div className="dsh-notes-panel-note">{t('files.pickHint')}</div>

        <div className="dsh-notes-dirpicker-crumbs">
          {parent !== null ? (
            <button type="button" className="dsh-notes-btn" title={t('files.pickUp')} onClick={() => load(parent)}>
              <IconChevron size={12} open={false} />
            </button>
          ) : null}
          {crumbs.map((crumb, index) => (
            <React.Fragment key={crumb.path}>
              {index > 0 ? <span className="dsh-notes-dim">/</span> : null}
              <button
                type="button"
                className="dsh-notes-btn dsh-notes-dirpicker-crumb"
                title={crumb.path}
                onClick={() => load(crumb.path)}
              >
                {index === 0 ? t('files.pickRoot') : crumb.name}
              </button>
            </React.Fragment>
          ))}
        </div>

        {error !== null ? (
          <div className="dsh-notes-panel-error">
            <IconWarn size={14} />
            <span>{t('files.pickFailed').replace('{m}', error)}</span>
          </div>
        ) : null}

        <div className="dsh-notes-panel-body dsh-notes-dirpicker-body">
          {loading && listing === null ? <div className="dsh-notes-dim">{t('files.pickLoading')}</div> : null}
          {!loading && dirs.length === 0 && error === null ? (
            <div className="dsh-notes-dim">{t('files.pickEmpty')}</div>
          ) : null}
          {dirs.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="dsh-notes-dirpicker-row"
              title={entry.path}
              onClick={() => load(entry.path)}
            >
              <IconCollection size={13} />
              <span className="dsh-notes-dirpicker-name">{entry.name}</span>
              <span className="dsh-notes-dim dsh-notes-dirpicker-go">{t('files.pickPick')}</span>
            </button>
          ))}
          {listing?.truncated === true ? <div className="dsh-notes-dim dsh-notes-dirpicker-more">{t('files.pickTruncated')}</div> : null}
        </div>

        <div className="dsh-notes-panel-foot">
          <button
            type="button"
            className="dsh-notes-btn"
            disabled={!pickable}
            onClick={() => {
              const value = pickValueOf(root, current)
              if (value === null) return
              props.onPick(current)
            }}
          >
            {atRoot ? t('files.pickRoot') : t('files.pickUse')}
          </button>
          <span className="dsh-notes-spacer" />
        </div>
      </div>
    </div>
  )
}
