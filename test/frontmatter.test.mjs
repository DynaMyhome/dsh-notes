import { test } from 'node:test'
import assert from 'node:assert/strict'

import { initialAnchor, LINE_SPLIT, normalizedLength } from '../src/client/editor/frontmatter.ts'

/**
 * 打开笔记时的光标位置。
 *
 * 靶子(用户实测):**CRLF 笔记一打开就抛 `Selection points outside of document`** ——
 * CM6 的 `EditorState.create({ doc })` 用 `/\r\n?|\n/` 切分重建,`doc.length` 比磁盘原文
 * 少掉"CR 的个数";旧实现拿原文长度当坐标,越界。
 *
 * 这里用**同一个切分规则**复算 CM6 的文档长度,锁住"anchor ≤ doc.length"。
 */

/** 复刻 `@codemirror/state` 的 `EditorState.create({ doc })`。 */
function cm6Length(text) {
  return text.split(LINE_SPLIT).join('\n').length
}

test('initialAnchor: LF 文本与旧实现逐值一致(防回归)', () => {
  assert.equal(initialAnchor(''), 0)
  assert.equal(initialAnchor('abc'), 3)
  assert.equal(initialAnchor('abc\n'), 4)
  // 末行是空行 → 光标放这一行,不加一个字符
  assert.equal(initialAnchor('abc\n\n'), 5)
  assert.equal(initialAnchor('a\nbb\nccc'), 8)
  assert.equal(initialAnchor('a\nbb\nccc\n'), 9)
})

test('initialAnchor: CRLF 文本不能超出编辑器文档长度', () => {
  const crlf = '---\r\ndsh-note-id: n_x\r\n---\r\n\r\n# 标题\r\n\r\n正文\r\n'
  const anchor = initialAnchor(crlf)
  assert.equal(anchor, cm6Length(crlf), '锚点必须正好落在归一后文档的末尾')
  assert.equal(anchor <= cm6Length(crlf), true)

  // 大文件(用户实测那篇 123KB / 1244 个 CR 的形态)
  const line = '这是一行正文内容,用来把文档撑大一点。\r\n'
  const big = '# 标题\r\n\r\n' + line.repeat(5000)
  const bigAnchor = initialAnchor(big)
  assert.equal(bigAnchor, cm6Length(big))
  assert.equal(bigAnchor < big.length, true, 'CRLF 文本的锚点必须小于原文长度(否则就是当年那个越界)')
  assert.equal(big.length - bigAnchor, 5002, '差距正好是 CR 的个数')
})

test('normalizedLength: 与 CM6 的文档长度一致', () => {
  assert.equal(normalizedLength('abc'), 3)
  assert.equal(normalizedLength('a\r\nb'), 3)
  assert.equal(normalizedLength('a\rb'), 3, '孤立 CR 也是换行分隔符')
  assert.equal(normalizedLength('a\nb'), 3)
  assert.equal(normalizedLength(''), 0)
  assert.equal(normalizedLength(undefined), 0)
})

test('孤立 CR(老 Mac 行尾)同样不能越界', () => {
  const cr = '---\rdsh-note-id: n_x\r---\r\r# 标题\r'
  assert.equal(initialAnchor(cr), cm6Length(cr))
})
