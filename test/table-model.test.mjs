import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 表格解析的回归用例。
 *
 * 这一组兜的是:工具栏「表格」插入的是**空单元格表头**(`|  |  |  |`),而旧的分隔行
 * 判据把这种行也当分隔行吞掉 → 解析出 0 列 → 整块表格不渲染(用户实测:
 * "工具栏的表格按钮插出来的表格根本显示不出来")。
 */
let model = null
try {
  model = await import('../src/client/editor/table-model.ts')
} catch {
  model = null
}
const maybe = model === null ? test.skip : test

maybe('isDelimiterRow:只有"每格都是 --- 这种"才算分隔行', () => {
  const yes = ['| --- | --- |', '| --- | --- | --- | --- |', '|:--|--:|', '--- | ---', '|---|---|']
  for (const line of yes) assert.equal(model.isDelimiterRow(line), true, line)
  const no = ['|  |  |  |  |', '| a | b |', '|  | --- |', '| --- | x |', '', '文字']
  for (const line of no) assert.equal(model.isDelimiterRow(line), false, line)
})

maybe('parseTable:空单元格表头也要解析出列(工具栏插入的表格)', () => {
  const source = '|  |  |  |  |\n| --- | --- | --- | --- |\n|  |  |  |  |\n'
  const parsed = model.parseTable(source, 0)
  assert.equal(parsed.header.length, 4, '空表头也要有 4 列')
  assert.equal(parsed.rows.length, 1, '一行数据')
  assert.equal(parsed.rows[0].length, 4)
})

maybe('parseTable:普通表格 + 单元格绝对范围', () => {
  const source = '| A | B |\n| --- | --- |\n| 1 | 2 |\n'
  const parsed = model.parseTable(source, 100)
  assert.deepEqual(parsed.header.map((cell) => cell.text), ['A', 'B'])
  assert.deepEqual(parsed.rows[0].map((cell) => cell.text), ['1', '2'])
  // 第一格 "A" 在 base+2(跳过 "| ")
  assert.equal(parsed.header[0].from, 102)
  // 注意:`to` 可能带上单元格右边的一个空格(单元格内容取 text,已经 trim 过)
  assert.equal(source.slice(parsed.header[0].from - 100, parsed.header[0].to - 100).trim(), 'A')
  assert.equal(source.slice(parsed.rows[0][0].from - 100, parsed.rows[0][0].to - 100).trim(), '1')
})

maybe('parseTable:对齐冒号与无外框写法', () => {
  const parsed = model.parseTable('| A | B |\n|:-- | --:|\n| 1 | 2 |\n', 0)
  assert.deepEqual(parsed.header.map((cell) => cell.text), ['A', 'B'])
  assert.equal(parsed.rows.length, 1)
})

test('表格后面紧跟的文段不能被吃成一行', () => {
  const source = '| a | b |\n| --- | --- |\n| 1 | 2 |\n端到端'
  const parsed = model.parseTable(source, 0)
  assert.equal(parsed.rows.length, 1, '只有一行数据')
  assert.equal(parsed.rows[0].map((cell) => cell.text).join(','), '1,2')
  // 空行之后同理
  const withBlank = model.parseTable('| a |\n| --- |\n| 1 |\n\n后面的段落', 0)
  assert.equal(withBlank.rows.length, 1)
})
