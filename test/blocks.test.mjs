import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 块级插入的规划:必须让块**独占整段**(前后留空行)。
 *
 * 回归点:在表格最后一行后面直接插 `---`,markdown 会把它解析成 SetextHeading2 的
 * 下划线,整张表消失(用户实测)。
 */
let blocks = null
try {
  blocks = await import('../src/client/editor/blocks.ts')
} catch {
  blocks = null
}
const maybe = blocks === null ? test.skip : test

/** 手搓一个满足 DocLines 的文档。 */
function doc(text) {
  const lines = text.split('\n').map((lineText, index) => ({ number: index + 1, text: lineText }))
  let offset = 0
  for (const item of lines) {
    item.from = offset
    item.to = offset + item.text.length
    offset = item.to + 1
  }
  return {
    lines: lines.length,
    line: (number) => lines[number - 1],
    lineAt: (position) => lines.find((item) => position >= item.from && position <= item.to) ?? lines[lines.length - 1],
  }
}

maybe('表格后紧跟插入:必须补空行,否则整张表会被吞掉', () => {
  const text = '| A | B |\n| --- | --- |\n| 1 | 2 |'
  const document = doc(text)
  const plan = blocks.planBlockInsert(document, { from: text.length, to: text.length }, '---\n', 4)
  const result = text.slice(0, plan.from) + plan.insert + text.slice(plan.to)
  assert.equal(result, '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n---\n', '插入后表格与分隔线之间要有空行')
})

maybe('行中间插入:前后都补空行,不劈开原行', () => {
  const text = 'abc'
  const plan = blocks.planBlockInsert(doc(text), { from: 1, to: 1 }, '---\n', 4)
  // 块自带结尾换行,`bc` 因此已经被顶到下一行;前面补两个换行(收尾当前行 + 空行)
  assert.equal(plan.insert, '\n\n---\n')
  assert.equal(plan.caret, 1 + 2 + 4)
})

maybe('空行上插入:相邻是内容行时才补一个空行', () => {
  const text = '上一段\n\n下一段'
  // 光标落在中间那个空行(offset = 4)
  const plan = blocks.planBlockInsert(doc(text), { from: 4, to: 4 }, '---\n', 4)
  const result = text.slice(0, plan.from) + plan.insert + text.slice(plan.to)
  assert.match(result, /上一段\n\n---\n\n下一段/, result)
})

maybe('块自己没有结尾换行(表格)时:要补上,不能让后面的字粘到最后一行', () => {
  const text = 'abc'
  const plan = blocks.planBlockInsert(doc(text), { from: 1, to: 1 }, '| A |\n| --- |', 2)
  // 2 = `| ` 之后,落在第一个表头单元格里
  assert.equal(plan.caret, 1 + 2 + 2)
  const result = text.slice(0, plan.from) + plan.insert + text.slice(plan.to)
  assert.equal(result, 'a\n\n| A |\n| --- |\nbc')
})

maybe('空文档:不补多余空行', () => {
  const plan = blocks.planBlockInsert(doc(''), { from: 0, to: 0 }, '---\n', 4)
  assert.equal(plan.insert, '---\n')
})
