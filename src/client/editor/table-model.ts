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

/** 表内右键菜单的动作。 */
export type TableActionKind = 'rowAbove' | 'rowBelow' | 'colLeft' | 'colRight' | 'rowDelete' | 'colDelete'

/** 一次表内操作的目标(纯数据,便于单测)。 */
export interface TableActionTarget {
  /** 表格的源码块(表头行 + 分隔行 + 数据行)。 */
  block: string
  /**
   * 行下标:**数据行 = `<tbody>` 内下标**(0 = 第一个数据行),**表头 = -1**。
   *
   * 这个语义是踩过坑才定下来的:`<thead>` 与 `<tbody>` 各自从 0 开始编号,
   * 旧代码直接拿"节点在父元素里的下标"当行号 → 表头和第一个数据行**都是 0**,
   * 于是"删第一行"被当成删表头(空操作)、"删第二行"删掉的是第一行。
   */
  row: number
  /** 列下标:0 = 第一列(含表头行)。 */
  col: number
  kind: TableActionKind
}

/** 把单元格数组拼回一行 `| a | b |`(空格用 `   ` 占位,免得整行塌成 `||`)。 */
function buildRow(cells: readonly string[]): string {
  return `| ${cells.map((cell) => cell || '   ').join(' | ')} |`
}

/**
 * 表内操作 → 新的源码块(**纯函数**)。
 *
 * 行号语义见 {@link TableActionTarget.row};列操作与行无关(`col` 始终按含表头行的
 * 单元格下标算)。动不了(删表头、下标越界、块不成表、结果没变化)时返回 `null`,
 * 调用方据此**不写文档**。
 * @param target - 见 {@link TableActionTarget}。
 * @returns 新的表格源码块;不需要改动时 null。
 */
export function applyTableAction(target: TableActionTarget): string | null {
  const lines = String(target.block ?? '').split('\n')
  if (lines.length < 2) return null
  const header = splitCells(lines[0])
  const cols = header.length
  if (cols === 0) return null
  const body = lines.slice(2)
  const blank = Array.from({ length: cols }, () => '')
  const inBody = (index: number): boolean => Number.isInteger(index) && index >= 0 && index < body.length
  const draggable = (index: number): boolean => index < 0 || inBody(index)
  let next: string[]
  if (target.kind === 'rowAbove' || target.kind === 'rowBelow') {
    if (!draggable(target.row)) return null
    // 表头(-1)= 插到第一个数据行之前
    const at = target.row < 0 ? 0 : target.row + (target.kind === 'rowBelow' ? 1 : 0)
    const rows = [...body]
    rows.splice(at, 0, buildRow(blank))
    next = [lines[0], lines[1], ...rows]
  } else if (target.kind === 'rowDelete') {
    if (!inBody(target.row)) return null // 表头删不掉,越界也不动
    const rows = [...body]
    rows.splice(target.row, 1)
    next = [lines[0], lines[1], ...rows]
  } else if (target.kind === 'colLeft' || target.kind === 'colRight') {
    if (target.col < 0 || target.col >= cols) return null
    const at = target.col + (target.kind === 'colRight' ? 1 : 0)
    const add = (line: string, isDelimiter: boolean): string => {
      const cells = splitCells(line)
      cells.splice(at, 0, isDelimiter ? '---' : '')
      return buildRow(cells)
    }
    next = [add(lines[0], false), add(lines[1], true), ...body.map((line) => add(line, false))]
  } else {
    if (cols <= 1 || target.col < 0 || target.col >= cols) return null
    const drop = (line: string): string => {
      const cells = splitCells(line)
      cells.splice(target.col, 1)
      return buildRow(cells)
    }
    next = [drop(lines[0]), drop(lines[1]), ...body.map((line) => drop(line))]
  }
  const result = next.join('\n')
  return result === target.block ? null : result
}

