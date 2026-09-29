import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  assetFileName,
  dirOf,
  isAbsolutePath,
  looksLikeMarkdown,
  mintFrontmatter,
  normalizePath,
  parseWikiLinks,
  readNoteId,
  relativePath,
  sanitizeFileName,
  titleOf,
  workspaceKeyOf,
} from '../lib/notes.js'

test('normalizePath: 反斜杠归一 + 去尾斜杠', () => {
  assert.equal(normalizePath('D:\\a\\b\\'), 'D:/a/b')
  assert.equal(normalizePath('/x/y///'), '/x/y')
  assert.equal(normalizePath('/'), '/')
})

test('isAbsolutePath: POSIX / 盘符 / 相对', () => {
  assert.equal(isAbsolutePath('/data/x.md'), true)
  assert.equal(isAbsolutePath('D:\\文档\\a.md'), true)
  assert.equal(isAbsolutePath('notes/a.md'), false)
})

test('dirOf / 后缀判定', () => {
  assert.equal(dirOf('/a/b/c.md'), '/a/b')
  assert.equal(dirOf('c.md'), '')
  assert.equal(looksLikeMarkdown('x.MD'), true)
  assert.equal(looksLikeMarkdown('x.markdown'), true)
  assert.equal(looksLikeMarkdown('x.txt'), false)
})

test('relativePath: 同目录 / 父层 / 跨盘', () => {
  assert.equal(relativePath('/ws/notes', '/ws/notes/img/a.png'), 'img/a.png')
  assert.equal(relativePath('/ws/notes/sub', '/ws/.dsh-assets/n_1/a.png'), '../../.dsh-assets/n_1/a.png')
  assert.equal(relativePath('/ws', '/ws/a.md'), 'a.md')
  assert.equal(relativePath('D:/ws/notes', 'D:/other/x.png'), '../../other/x.png')
  assert.equal(relativePath('D:/ws', 'E:/x.png'), 'E:/x.png')
})

test('workspaceKeyOf: 稳定且区分根路径', () => {
  const a = workspaceKeyOf('/data/ws')
  assert.equal(a, workspaceKeyOf('/data/ws/'))
  assert.notEqual(a, workspaceKeyOf('/data/ws2'))
  assert.equal(a.length, 12)
})

test('readNoteId / mintFrontmatter: 无 frontmatter → 新建块', () => {
  const minted = mintFrontmatter('# 标题\n\n正文\n', 'n_abc')
  assert.equal(readNoteId(minted), 'n_abc')
  // frontmatter 块后保留一个空行,再接正文
  assert.match(minted, /^---\ndsh-note-id: n_abc\n---\n\n# 标题\n\n正文\n$/)
})

test('mintFrontmatter: 已有 frontmatter → 追加/替换键,其它字段保留', () => {
  const withKey = mintFrontmatter('---\ntitle: A\ndsh-note-id: n_old\n---\n正文\n', 'n_new')
  assert.equal(readNoteId(withKey), 'n_new')
  assert.match(withKey, /title: A/)
  assert.equal(withKey.match(/dsh-note-id/g).length, 1)

  const withoutKey = mintFrontmatter('---\ntitle: B\ntags: [x]\n---\n正文\n', 'n_x')
  assert.equal(readNoteId(withoutKey), 'n_x')
  assert.match(withoutKey, /title: B/)
  assert.match(withoutKey, /tags: \[x\]/)
})

test('mintFrontmatter: 幂等(内容不变时不该反复改写)', () => {
  const once = mintFrontmatter('正文\n', 'n_1')
  assert.equal(mintFrontmatter(once, 'n_1'), once)
})

test('parseWikiLinks: 目标 / 标题 / 别名', () => {
  const links = parseWikiLinks('见 [[TC 机制]] 与 [[Fig8#外核|图8]]\n不闭合 [[x')
  assert.equal(links.length, 2)
  assert.deepEqual(
    links.map((link) => [link.target, link.heading, link.alias]),
    [
      ['TC 机制', '', ''],
      ['Fig8', '外核', '图8'],
    ],
  )
})

test('titleOf: 优先第一个标题,否则文件名', () => {
  assert.equal(titleOf('/a/b/x.md', '---\ntags: []\n---\n# 真标题\n正文'), '真标题')
  assert.equal(titleOf('/a/b/我的笔记.md', '没有标题'), '我的笔记')
  assert.equal(titleOf('/a/b/x.md', ''), 'x')
})

test('sanitizeFileName: 非法字符与空标题', () => {
  assert.equal(sanitizeFileName('a/b:c*d?e"f<g>h|i'), 'a-b-c-d-e-f-g-h-i')
  assert.equal(sanitizeFileName('   '), 'untitled')
  assert.equal(sanitizeFileName('x'.repeat(200)).length, 80)
})

test('assetFileName: 时间 + 随机 + 后缀兜底', () => {
  const name = assetFileName('.PNG', Date.UTC(2026, 8, 30, 1, 2, 3))
  assert.match(name, /^image-20260930-010203-[0-9a-f]{6}\.png$/)
  assert.match(assetFileName('.exe', 0), /\.png$/)
})
