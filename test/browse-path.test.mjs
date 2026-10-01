import { test } from 'node:test'
import assert from 'node:assert/strict'

import { crumbsWithin, pickValueOf, relativeToRoot, visibleDirs } from '../src/client/browse-path.ts'

/**
 * 目录选择器的纯逻辑。
 *
 * 为什么要有它:官方 `uiWorkspace.pickDirectory()` 在本 profile 上**不可用**
 * （组合的是 `browse` 后端,`pick` 需要 `native` capability → `directory-picker/unavailable`）,
 * 所以面板自己用 `listDirectory` 拼浏览器;这里兜住"显示哪些目录/能不能选"的判断。
 */

const dir = (name, path) => ({ name, path, hidden: false })

test('visibleDirs:点目录 / 隐藏项 / SKIP_DIRS 全过滤掉,并按名排序', () => {
  const entries = [
    dir('node_modules', '/ws/node_modules'),
    dir('zeta', '/ws/zeta'),
    dir('alpha', '/ws/alpha'),
    { name: '.git', path: '/ws/.git', hidden: false },
    { name: 'hidden-by-host', path: '/ws/hidden-by-host', hidden: true },
    dir('.dsh-notes', '/ws/.dsh-notes'),
    dir('.dsh-assets', '/ws/.dsh-assets'),
    dir('notes', '/ws/notes'),
  ]
  assert.deepEqual(visibleDirs(entries).map((entry) => entry.name), ['alpha', 'notes', 'zeta'])
})

test('relativeToRoot:工作区根 → 空串;子目录 → 相对路径;越界 → 失败', () => {
  assert.deepEqual(relativeToRoot('/ws', '/ws'), { ok: true, rel: '' })
  assert.deepEqual(relativeToRoot('/ws', '/ws/docs'), { ok: true, rel: 'docs' })
  assert.deepEqual(relativeToRoot('/ws', '/ws/docs/deep/'), { ok: true, rel: 'docs/deep' })
  assert.deepEqual(relativeToRoot('/ws', '/wsx'), { ok: false }, '前缀陷阱')
  assert.deepEqual(relativeToRoot('/ws', '/home'), { ok: false })
  assert.deepEqual(relativeToRoot('', '/ws'), { ok: false })
  assert.deepEqual(relativeToRoot('D:\\Work', 'D:/Work/notes'), { ok: true, rel: 'notes' })
})

test('crumbsWithin:只保留工作区根之后的面包屑', () => {
  const crumbs = [dir('', '/'), dir('home', '/home'), dir('user', '/home/user'), dir('ws', '/ws'), dir('docs', '/ws/docs')]
  assert.deepEqual(crumbsWithin('/ws', crumbs).map((crumb) => crumb.name), ['ws', 'docs'])
  // 当前目录在工作区外 → 不给面包屑(界面上会退回工作区根)
  assert.deepEqual(crumbsWithin('/ws', [dir('', '/'), dir('home', '/home')]), [])
  assert.deepEqual(crumbsWithin('/ws', []), [])
})

test('pickValueOf:工作区根是合法选择(空串 = 整个工作区)', () => {
  assert.equal(pickValueOf('/ws', '/ws'), '')
  assert.equal(pickValueOf('/ws', '/ws/docs'), 'docs')
  assert.equal(pickValueOf('/ws', '/home/user'), null)
})
