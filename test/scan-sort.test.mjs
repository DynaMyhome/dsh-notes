import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_SORT, defaultDirOf, formatStamp, sortFiles } from '../src/client/scan-sort.ts'

/**
 * 「纳入管理」的排序纯逻辑。
 *
 * 重点锁三条:
 *   1. `time` 用 Host 解出来的 `at`,不是路径;
 *   2. **`at` 未知(0)的永远垫底**,升降序都不翻面(它们不是"最旧",是"不知道");
 *   3. 同键并列时按 relPath 稳定兜底,顺序不跳。
 */

const file = (relPath, at, bytes = 10, title = relPath.split('/').pop()) => ({
  path: `/ws/${relPath}`,
  relPath,
  title: title.replace(/\.md$/, ''),
  id: null,
  folder: relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '',
  bytes,
  at,
})

const list = [
  file('notes/aaa.md', 300, 30),
  file('notes/mmm.md', 100, 10),
  file('notes/zzz.md', 200, 20),
]

test('time 降序(默认):最近在前', () => {
  const out = sortFiles(list, DEFAULT_SORT)
  assert.deepEqual(out.map((item) => item.relPath), ['notes/aaa.md', 'notes/zzz.md', 'notes/mmm.md'])
})

test('time 升序:最旧在前', () => {
  const out = sortFiles(list, { key: 'time', dir: 'asc' })
  assert.deepEqual(out.map((item) => item.relPath), ['notes/mmm.md', 'notes/zzz.md', 'notes/aaa.md'])
})

test('at 未知(0)永远排最后 —— 升序也一样', () => {
  const mixed = [file('notes/unknown.md', 0), file('notes/old.md', 1), file('notes/new.md', 999)]
  assert.deepEqual(
    sortFiles(mixed, { key: 'time', dir: 'desc' }).map((item) => item.relPath),
    ['notes/new.md', 'notes/old.md', 'notes/unknown.md'],
  )
  assert.deepEqual(
    sortFiles(mixed, { key: 'time', dir: 'asc' }).map((item) => item.relPath),
    ['notes/old.md', 'notes/new.md', 'notes/unknown.md'],
  )
})

test('name / path / size 三种主键', () => {
  assert.deepEqual(
    sortFiles(list, { key: 'name', dir: 'asc' }).map((item) => item.relPath),
    ['notes/aaa.md', 'notes/mmm.md', 'notes/zzz.md'],
  )
  assert.deepEqual(
    sortFiles(list, { key: 'path', dir: 'desc' }).map((item) => item.relPath),
    ['notes/zzz.md', 'notes/mmm.md', 'notes/aaa.md'],
  )
  assert.deepEqual(
    sortFiles(list, { key: 'size', dir: 'desc' }).map((item) => item.relPath),
    ['notes/aaa.md', 'notes/zzz.md', 'notes/mmm.md'],
  )
})

test('并列时按 relPath 稳定兜底(顺序不跳)', () => {
  const tied = [file('b/x.md', 100), file('a/x.md', 100), file('c/x.md', 100)]
  assert.deepEqual(
    sortFiles(tied, { key: 'time', dir: 'desc' }).map((item) => item.relPath),
    ['a/x.md', 'b/x.md', 'c/x.md'],
  )
})

test('不改动原数组', () => {
  const before = list.map((item) => item.relPath)
  sortFiles(list, { key: 'size', dir: 'asc' })
  assert.deepEqual(list.map((item) => item.relPath), before)
})

test('defaultDirOf:时间/大小倒序,名称/路径正序', () => {
  assert.equal(defaultDirOf('time'), 'desc')
  assert.equal(defaultDirOf('size'), 'desc')
  assert.equal(defaultDirOf('name'), 'asc')
  assert.equal(defaultDirOf('path'), 'asc')
})

test('formatStamp:at=0 不显示;同年省略年份,跨年带年份', () => {
  assert.equal(formatStamp(0), '')
  assert.equal(formatStamp(Number.NaN), '')
  const now = Date.UTC(2026, 9, 1, 12, 0, 0)
  const sameYear = new Date(2026, 0, 2, 3, 4).getTime()
  assert.equal(formatStamp(sameYear, now), '01-02 03:04')
  const otherYear = new Date(2025, 0, 2, 3, 4).getTime()
  assert.equal(formatStamp(otherYear, now), '2025-01-02 03:04')
})
