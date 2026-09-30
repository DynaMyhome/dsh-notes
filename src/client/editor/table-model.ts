/**
 * 表格的**纯解析**(不含 DOM / CodeMirror)。
 *
 * 单独成模块有两个原因:
 *   1. 测试:`node --experimental-strip-types` 能直接 import 它(而 table.ts 用了
 *      参数属性,那个开关不认);
 *   2. 这里出过一个真 bug —— 旧的分隔行判据"只含 `| : - 空格`"把**全空单元格**的表头
 *      也当成分隔行吞掉,于是工具栏插入的表格(表头是空单元格)`parseTable` 返回 0 列,
 *      整块不渲染。判据现在要求"每一格都是 --- 这种"。
 */

export interface TableCell {
  text: string
  from: number
  to: number
}

/** 表格模型。 */
export interface TableModel {
  header: TableCell[]
  rows: TableCell[][]
}

/** `|---|:--|` 这种分隔行。 */
export function isDelimiterRow(line: string): boolean {
  // 判据是"**每一格都是** `---` / `:--:` 这种",而不是"只含 `| : - 空格`" ——
  // 旧正则把 `|  |  |  |  |`(全空单元格的表头/数据行)也当成分隔行吞掉了,
  // 结果**工具栏插入的表格**(表头是空单元格)parseTable 返回 0 列 → 整块不渲染。
  const text = String(line ?? '').trim()
  if (!text.includes('-')) return false
  const cells = splitCells(text)
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))
}

/** 把一行的 `|a|b|` 切成单元格文本。 */
function splitCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

/**
 * 解析表格源码(相对偏移 + `base` = 表格在文档里的起点)。
 * @param source - 表格文本(不含前后空行)。
 * @param base - 该文本在文档中的起始位置。
 */
export function parseTable(source: string, base: number): TableModel {
  const header: TableCell[] = []
  const rows: TableCell[][] = []
  let offset = 0
  let seenHeader = false
  for (const line of source.split(/\r?\n/)) {
    const lineStart = base + offset
    offset += line.length + 1 // +1 = 换行
    if (line.trim() === '') {
      // 空行 = 表格结束
      if (seenHeader) break
      continue
    }
    if (isDelimiterRow(line)) continue
    // **表格行必须含 `|`**。以前不判,于是"表格后面紧跟的文段"被当成一行吃掉
    // (用户实测:表格下直接写 `端到端`,它变成了表格里的一个格子)。
    if (!line.includes('|')) break
    // 逐个单元格算出绝对范围:按 `|` 切,并把相对位置加回 base
    const cells: TableCell[] = []
    let cursor = 0
    const parts = line.split('|')
    for (const part of parts) {
      const partStart = cursor
      cursor += part.length + 1
      if (part.trim() === '' && (partStart === 0 || partStart + part.length >= line.length)) continue
      cells.push({
        text: part.trim(),
        from: lineStart + partStart + (line[partStart] === ' ' ? 1 : 0),
        to: lineStart + partStart + part.length,
      })
    }
    if (cells.length === 0) continue
    if (!seenHeader) {
      header.push(...cells)
      seenHeader = true
    } else {
      rows.push(cells)
    }
  }
  return { header, rows }
}

