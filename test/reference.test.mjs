import { test } from 'node:test'
import assert from 'node:assert/strict'

/** 「引用此处」的载荷(纯函数)。 */
const ref = await import('../src/client/editor/reference.ts')
const base = { relPath: 'notes/甲.md', text: '第一行\n第二行\n第三行\n第四行\n' }

test('引用:单行(没有选区时用光标所在行)', () => {
  const offset = base.text.indexOf('第二行') + 1
  const out = ref.buildNoteReference({ ...base, from: offset, to: offset })
  assert.equal(out, '@notes/甲.md:L2\n> 第二行')
})

test('引用:多行选区给出行范围', () => {
  const from = base.text.indexOf('第二行')
  const to = base.text.indexOf('第三行') + '第三行'.length
  const out = ref.buildNoteReference({ ...base, from, to })
  assert.equal(out, '@notes/甲.md:L2-L3\n> 第二行\n> 第三行')
})

test('引用:标题面包屑与跨工作区来源', () => {
  const out = ref.buildNoteReference({ ...base, from: 0, to: 0, heading: '外部改的标题 › d', workspaceName: 'Analog IC' })
  assert.equal(out, '@notes/甲.md:L1\n§ 外部改的标题 › d\n(来自工作区 Analog IC)\n> 第一行')
})

test('引用:引文超长时截断(最多 12 行,并留省略号)', () => {
  const text = Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join('\n')
  const out = ref.buildNoteReference({ relPath: 'n.md', text, from: 0, to: text.length })
  const quoted = out.split('\n').filter((line) => line.startsWith('> '))
  assert.equal(quoted.length, ref.QUOTE_MAX_LINES + 1, '12 行 + 一行省略号')
  assert.equal(quoted[quoted.length - 1], '> …')
  assert.ok(out.length < ref.QUOTE_MAX_CHARS + 100, '整体也要有上限')
})

test('引用:选区/offset 越界不炸(clamp)', () => {
  const out = ref.buildNoteReference({ ...base, from: 9999, to: 9999 })
  assert.match(out, /^@notes\/甲\.md:L5\n/, '越界就当文末')
  const weird = ref.buildNoteReference({ ...base, from: -5, to: -1 })
  assert.match(weird, /^@notes\/甲\.md:L1\n/)
})
