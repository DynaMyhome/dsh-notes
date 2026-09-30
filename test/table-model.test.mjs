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

/* ------------------------------------------------------------------ */
/* applyTableAction:表内右键「插/删行与列」                              */
/* ------------------------------------------------------------------ */

/** 表头 + 分隔行 + 三行数据。 */
const BLOCK = ['| A | B | C |', '| --- | --- | --- |', '| 1 | 2 | 3 |', '| 4 | 5 | 6 |', '| 7 | 8 | 9 |'].join('\n')

/** 改动前的行号算法(照抄 `EditorPane.tableAction`):把 row 当"表头=0"的源码行号。 */
function legacyRowAction(kind, rowIndex) {
  const lines = BLOCK.split('\n')
  const body = lines.slice(2)
  if (kind === 'rowDelete') {
    if (rowIndex <= 0) return null // 表头不删
    const rows = [...body]
    rows.splice(rowIndex - 1, 1)
    return [lines[0], lines[1], ...rows].join('\n')
  }
  const at = Math.max(0, rowIndex - 1) + (kind === 'rowBelow' ? 1 : 0)
  const rows = [...body]
  rows.splice(at, 0, '|    |    |    |')
  return [lines[0], lines[1], ...rows].join('\n')
}

const dataRows = (block) => block.split('\n').slice(2)
/** 空单元格行的格式是 `|   |   |`(buildRow 用 3 个空格占位),比较时压掉空格。 */
const norm = (line) => String(line).replace(/\s+/g, ' ').trim()
/** 整行都是空单元格(新插入的占位行)。 */
const isBlank = (line) => {
  const cells = String(line).replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')
  return cells.length > 0 && cells.every((cell) => cell.trim() === '')
}

maybe('applyTableAction:rowDelete 删的**就是右键那一行**(首行也能删)', () => {
  const deleted = (row) => dataRows(model.applyTableAction({ block: BLOCK, row, col: 0, kind: 'rowDelete' }))
  assert.deepEqual(deleted(0), ['| 4 | 5 | 6 |', '| 7 | 8 | 9 |'], '删第 1 个数据行')
  assert.deepEqual(deleted(1), ['| 1 | 2 | 3 |', '| 7 | 8 | 9 |'], '删第 2 个数据行')
  assert.deepEqual(deleted(2), ['| 1 | 2 | 3 |', '| 4 | 5 | 6 |'], '删最后一个数据行')
  assert.equal(model.applyTableAction({ block: BLOCK, row: -1, col: 0, kind: 'rowDelete' }), null, '表头删不掉')
  assert.equal(model.applyTableAction({ block: BLOCK, row: 3, col: 0, kind: 'rowDelete' }), null, '越界不动')
})

maybe('反向锁:改动前"删第 2 行"删掉的是第 1 行、"删第 1 行"是空操作', () => {
  const legacyFirst = legacyRowAction('rowDelete', 0)
  assert.equal(legacyFirst, null, '旧算法:第一个数据行的下标也是 0 → 被当成表头,空操作(实测过)')
  const legacySecond = legacyRowAction('rowDelete', 1)
  assert.deepEqual(dataRows(legacySecond), ['| 4 | 5 | 6 |', '| 7 | 8 | 9 |'], '旧算法:删的是第 1 行')
  assert.notDeepEqual(dataRows(legacySecond), dataRows(model.applyTableAction({ block: BLOCK, row: 1, col: 0, kind: 'rowDelete' })))
})

maybe('applyTableAction:插行落在被点行的上/下', () => {
  const above = (row) => dataRows(model.applyTableAction({ block: BLOCK, row, col: 0, kind: 'rowAbove' }))
  const below = (row) => dataRows(model.applyTableAction({ block: BLOCK, row, col: 0, kind: 'rowBelow' }))
  assert.equal(isBlank(above(0)[0]), true, '第 1 行上方插入 → 新行成为第一行')
  assert.equal(above(0)[1], '| 1 | 2 | 3 |')
  assert.equal(isBlank(above(1)[1]), true, '第 2 行上方插入 → 新行在第 2 位')
  assert.equal(isBlank(above(2)[2]), true, '最后一行上方插入 → 新行在最后一行之前')
  assert.equal(above(2)[3], '| 7 | 8 | 9 |', '原最后一行被挤到其后')
  assert.equal(isBlank(below(0)[1]), true, '第 1 行下方插入 → 新行在第二行')
  assert.equal(isBlank(below(2)[3]), true, '最后一行下方插入 → 追加到末尾')
  assert.equal(below(2).length, 4)
  // 表头(-1)上/下插都落到第一个数据行之前
  assert.equal(isBlank(above(-1)[0]), true)
  assert.equal(isBlank(below(-1)[0]), true)
  assert.equal(model.applyTableAction({ block: BLOCK, row: 9, col: 0, kind: 'rowAbove' }), null, '越界不动')
})

maybe('applyTableAction:列操作(含表头行)与越界', () => {
  const lines = (block) => block.split('\n')
  const left = model.applyTableAction({ block: BLOCK, row: 0, col: 1, kind: 'colLeft' })
  assert.equal(norm(lines(left)[0]), '| A | | B | C |', '在第 2 列左侧插一列')
  assert.equal(norm(lines(left)[1]), '| --- | --- | --- | --- |', '分隔行同步插 ---')
  const right = model.applyTableAction({ block: BLOCK, row: 0, col: 2, kind: 'colRight' })
  assert.equal(norm(lines(right)[0]), '| A | B | C | |', '在最右列右侧插一列')
  const del = model.applyTableAction({ block: BLOCK, row: 0, col: 0, kind: 'colDelete' })
  assert.equal(lines(del)[0], '| B | C |')
  assert.equal(lines(del)[2], '| 2 | 3 |', '数据行同步删列')
  assert.equal(model.applyTableAction({ block: BLOCK, row: 0, col: 3, kind: 'colDelete' }), null, '列越界不动')
  const single = '| A |\n| --- |\n| 1 |'
  assert.equal(model.applyTableAction({ block: single, row: 0, col: 0, kind: 'colDelete' }), null, '只剩一列不删')
})

maybe('applyTableAction:块不成表 / 结果无变化 → null(调用方不该写文档)', () => {
  assert.equal(model.applyTableAction({ block: '| A |', row: 0, col: 0, kind: 'rowDelete' }), null, '只有一行')
  assert.equal(model.applyTableAction({ block: '', row: 0, col: 0, kind: 'rowAbove' }), null)
  assert.equal(model.applyTableAction({ block: BLOCK, row: 0, col: 0, kind: 'colDelete', }), model.applyTableAction({ block: BLOCK, row: 1, col: 0, kind: 'colDelete' }))
})
