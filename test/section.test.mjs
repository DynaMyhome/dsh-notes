import { test } from 'node:test'
import assert from 'node:assert/strict'

import { moveSection, sectionRange } from '../lib/section.js'
import { parseOutline } from '../lib/outline.js'

const DOC = [
  '# A', // 1
  '', // 2
  'A 正文', // 3
  '## A1', // 4
  'A1 正文', // 5
  '## A2', // 6
  'A2 正文', // 7
  '# B', // 8
  'B 正文', // 9
  '# C', // 10
  'C 正文', // 11
].join('\n')

test('sectionRange: 章节 = 标题到下一个同级/更高级标题之前', () => {
  const headings = parseOutline(DOC)
  assert.deepEqual(sectionRange(headings, 1, 11), { start: 1, end: 7, level: 1 })
  assert.deepEqual(sectionRange(headings, 4, 11), { start: 4, end: 5, level: 2 })
  assert.deepEqual(sectionRange(headings, 3, 11), { start: 1, end: 7, level: 1 })
  assert.deepEqual(sectionRange(headings, 8, 11), { start: 8, end: 9, level: 1 })
  assert.deepEqual(sectionRange(headings, 10, 11), { start: 10, end: 11, level: 1 })
})

test('moveSection: 整个一级章节搬到另一个一级章节之前', () => {
  const result = moveSection(DOC, 1, 10, 'before')
  assert.notEqual(result, null)
  assert.deepEqual(parseOutline(result.text).map((h) => h.text), ['B', 'A', 'A1', 'A2', 'C'])
  // A 的正文跟着走,且 A 内部结构不变
  assert.match(result.text, /# A\n\nA 正文\n## A1\nA1 正文\n## A2\nA2 正文/)
})

test('moveSection: 落到目标章节之后,搬的是整段而不是插在中间', () => {
  const result = moveSection(DOC, 1, 8, 'after')
  assert.notEqual(result, null)
  assert.deepEqual(parseOutline(result.text).map((h) => h.text), ['B', 'A', 'A1', 'A2', 'C'])
  // B 在前,A 整段在后
  assert.ok(result.text.indexOf('# B') < result.text.indexOf('# A'))
  assert.ok(result.text.indexOf('# A') < result.text.indexOf('# C'))
})

test('moveSection: 二级章节可以在文档里搬家', () => {
  const result = moveSection(DOC, 6, 4, 'before')
  assert.notEqual(result, null)
  const texts = parseOutline(result.text).map((h) => h.text)
  assert.deepEqual(texts, ['A', 'A2', 'A1', 'B', 'C'])
  // A2 的内容跟着 A2 走
  assert.match(result.text, /## A2\nA2 正文\n## A1/)
})

test('moveSection: 不移动自己、不落进自己内部、未知行返回 null', () => {
  assert.equal(moveSection(DOC, 1, 1, 'before'), null)
  assert.equal(moveSection(DOC, 1, 4, 'before'), null) // 落点在自己章节内部
  assert.equal(moveSection(DOC, 99, 1, 'before'), null)
})

test('moveSection: 文档末尾没有换行时也不丢内容', () => {
  const text = '# A\na\n# B\nb'
  const result = moveSection(text, 3, 1, 'before')
  assert.deepEqual(parseOutline(result.text).map((h) => h.text), ['B', 'A'])
  assert.match(result.text, /# B\nb\n# A\na/)
  // 已经在前面的章节"搬到前面"= 不动
  assert.equal(moveSection(text, 1, 3, 'before').text, text)
})
