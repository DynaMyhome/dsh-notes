import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 外部改动落进编辑器时的最小改动计算。
 *
 * 为什么必须有靶子(用户 2026-10-09 实测:agent 改完笔记,视口被置顶):
 * 整篇替换会让 CM6 的高度图全篇退回估算、位置映射塌到末尾 —— 所以这里夹出的
 * **最小改动**是"位置不丢"的前提。CRLF 归一也在这里(编辑器文档恒为 LF,
 * 而读盘接口给的是磁盘原文)。
 *
 * 模型是 `.ts`(靠 `--experimental-strip-types` 才 import 得进来),没有该能力就跳过
 * —— 与 `test/scale.test.mjs` 同一写法。
 */
let diff = null
try {
  diff = await import('../src/client/editor/diff.ts')
} catch {
  diff = null
}

const maybe = diff === null ? test.skip : test

/** 改动的定义式不变式:`旧 = 前缀 + 删除段 + 后缀`,`新 = 前缀 + insert + 后缀`。 */
function assertRoundTrip(before, after, change) {
  assert.equal(before.slice(0, change.from) + change.insert + before.slice(change.to), after)
  assert.ok(change.from >= 0 && change.to >= change.from && change.to <= before.length)
}

maybe('内容相同(含只有行尾不同)→ 没有改动', () => {
  assert.equal(diff.minimalChange('a\nb\n', 'a\nb\n'), null)
  assert.equal(diff.minimalChange('a\nb\n', 'a\r\nb\r\n'), null)
})

maybe('纯追加 / 纯前置只动边界那一段', () => {
  const appended = diff.minimalChange('a\nb', 'a\nb\nc')
  assert.deepEqual(appended, { from: 3, to: 3, insert: '\nc' })
  assertRoundTrip('a\nb', 'a\nb\nc', appended)

  const prepended = diff.minimalChange('a\nb', 'z\na\nb')
  assert.deepEqual(prepended, { from: 0, to: 0, insert: 'z\n' })
  assertRoundTrip('a\nb', 'z\na\nb', prepended)
})

maybe('中段改动只覆盖真正变了的那一段(前后行原样保留)', () => {
  const before = '# 标题\n\n第一段\n第二段\n第三段\n'
  const after = '# 标题\n\n第一段\n第二段改了\n第三段\n'
  const change = diff.minimalChange(before, after)
  assert.deepEqual(change, { from: 13, to: 13, insert: '改了' })
  assertRoundTrip(before, after, change)
  // 前后缀就是没被动过的那两截 —— 它们对应的行仍留在 CM6 的高度图里
  assert.equal(before.slice(0, change.from), '# 标题\n\n第一段\n第二段')
  assert.equal(before.slice(change.to), '\n第三段\n')
  assert.equal(diff.isMostlyRewritten(change, before.length), false)
})

maybe('整篇重写 → 位置映射没意义,应该退回"按行号"兜底', () => {
  const before = 'a\nb\n'
  const change = diff.minimalChange(before, 'x\ny\n')
  // 结尾那个换行是共同的,所以严格说不是"全无公共部分" —— 但存活部分只有 1 字节
  assert.deepEqual(change, { from: 0, to: 3, insert: 'x\ny' })
  assert.equal(diff.isMostlyRewritten(change, before.length), true)

  // 只有开头变了(公共后缀很长)→ 位置可以照常映射
  const partial = diff.minimalChange('a\nb\n', 'x\nb\n')
  assert.deepEqual(partial, { from: 0, to: 1, insert: 'x' })
  assert.equal(diff.isMostlyRewritten(partial, 4), false)

  // 长文档里改一小段 → 不动用兜底
  const long = `${'行\n'.repeat(100)}尾\n`
  const tweaked = long.replace('尾\n', '尾改了\n')
  assert.equal(diff.isMostlyRewritten(diff.minimalChange(long, tweaked), long.length), false)
})

maybe('空文档两个方向都不炸', () => {
  const grow = diff.minimalChange('', 'abc')
  assert.deepEqual(grow, { from: 0, to: 0, insert: 'abc' })
  const shrink = diff.minimalChange('abc', '')
  assert.deepEqual(shrink, { from: 0, to: 3, insert: '' })
  assert.equal(diff.minimalChange('', ''), null)
})

maybe('CRLF 原文与 LF 文档之间判成"只有行尾不同"', () => {
  assert.equal(diff.normalizeToLf('a\r\nb\rc\nd'), 'a\nb\nc\nd')
  assert.equal(diff.minimalChange('a\nb\n', 'a\r\nb\r\n'), null)
  // 归一之后,真正变了的那一行才被认出来(而不是判成整篇)
  const change = diff.minimalChange('a\nb\n', 'a\r\nB\r\n')
  assert.deepEqual(change, { from: 2, to: 3, insert: 'B' })
})

maybe('乱值按空串处理,不抛错', () => {
  assert.deepEqual(diff.minimalChange(null, 'x'), { from: 0, to: 0, insert: 'x' })
  assert.deepEqual(diff.minimalChange(undefined, 'x'), { from: 0, to: 0, insert: 'x' })
  assert.deepEqual(diff.minimalChange('x', null), { from: 0, to: 1, insert: '' })
})
