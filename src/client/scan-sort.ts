/**
 * 「纳入管理」面板的排序(纯函数,可单测)。
 *
 * 面板里的三段(最近 / 按文件夹 / 已忽略)共用同一套排序;`time` 用的就是 Host 从
 * provider 版本号里解出来的 `at`(见 `lib/notes.js` 的 `mtimeOfVersion`)。
 *
 * 两条刻意的设计:
 *   - **认不出时间的(``at <= 0``)永远排最后**,不随升降序翻面 —— 它们不是"最旧",
 *     而是"不知道",混进时间序里会误导;
 *   - 任何排序都以 `relPath` 升序做**稳定兜底**,同一主键下顺序不跳。
 */

import type { FileEntry } from './api'

/** 排序主键。 */
export type SortKey = 'time' | 'name' | 'path' | 'size'

/** 升降序。 */
export type SortDir = 'asc' | 'desc'

/** 一次排序的完整描述。 */
export interface SortSpec {
  key: SortKey
  dir: SortDir
}

/** 默认排序:最近修改在前(与面板「最近」段的标题一致)。 */
export const DEFAULT_SORT: SortSpec = { key: 'time', dir: 'desc' }

/** 可选主键(顺序即界面上的顺序)。 */
export const SORT_KEYS: SortKey[] = ['time', 'name', 'path', 'size']

/** 缺省的排序方向:时间/大小"大在前"更符合直觉,名称/路径从小到大。 */
export function defaultDirOf(key: SortKey): SortDir {
  return key === 'time' || key === 'size' ? 'desc' : 'asc'
}

/**
 * 排序一份文件列表(不改原数组)。
 * @param files - 待排序的文件。
 * @param spec - 排序描述。
 * @returns 新数组。
 */
export function sortFiles(files: readonly FileEntry[], spec: SortSpec): FileEntry[] {
  const factor = spec.dir === 'asc' ? 1 : -1
  return [...files].sort((left, right) => {
    // 时间未知的永远垫底(升序降序都一样)
    if (spec.key === 'time') {
      const leftKnown = left.at > 0
      const rightKnown = right.at > 0
      if (leftKnown !== rightKnown) return leftKnown ? -1 : 1
    }
    const primary = factor * compareBy(spec.key, left, right)
    if (primary !== 0) return primary
    return left.relPath.localeCompare(right.relPath)
  })
}

/** 单键比较(`left` 在前为负)。 */
function compareBy(key: SortKey, left: FileEntry, right: FileEntry): number {
  if (key === 'time') return left.at - right.at
  if (key === 'size') return (left.bytes ?? 0) - (right.bytes ?? 0)
  if (key === 'name') return compareName(left.title, right.title)
  return left.relPath.localeCompare(right.relPath)
}

/** 文件名比较:中文按拼音,其它按本地化顺序 —— 与树里的分类排序同一套。 */
function compareName(left: string, right: string): number {
  return String(left ?? '').localeCompare(String(right ?? ''), 'zh-Hans-CN')
}

/**
 * 显示用的修改时间(`at` 认不出来时返回空串,界面就不显示那一列)。
 * @param at - Host 给的毫秒时间戳(0 = 未知)。
 * @param now - 当前时间(便于单测)。
 * @returns `MM-DD HH:mm`;跨年时带年份。
 */
export function formatStamp(at: number, now = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return ''
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return date.getFullYear() === new Date(now).getFullYear() ? stamp : `${date.getFullYear()}-${stamp}`
}
