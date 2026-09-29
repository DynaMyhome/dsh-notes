/**
 * 按标题切分与搬移章节(大纲拖拽用)。
 *
 * 纯函数、零依赖:输入正文与行号,输出新正文。这样"拖动大纲重排章节"这种
 * 容易写坏的逻辑可以单测,而不是只能靠手点。
 *
 * 章节 = 该标题行 + 直到 **下一个层级 <= 自己** 的标题之前的全部内容。
 */

import { parseOutline } from './outline.js'

/**
 * 算出某一行所属章节的范围。
 * @param {Array<{level:number,line:number,text:string}>} headings - `parseOutline` 的结果。
 * @param {number} line - 章节内任意行(1 基)。
 * @param {number} lineCount - 总行数。
 * @returns {{ start:number, end:number, level:number }|null} 1 基闭区间 `[start, end]`。
 */
export function sectionRange(headings, line, lineCount) {
  let index = -1
  for (let cursor = 0; cursor < headings.length; cursor += 1) {
    if (headings[cursor].line <= line) index = cursor
    else break
  }
  if (index === -1) return null
  const start = headings[index].line
  const level = headings[index].level
  let end = lineCount
  for (let cursor = index + 1; cursor < headings.length; cursor += 1) {
    if (headings[cursor].level <= level) {
      end = headings[cursor].line - 1
      break
    }
  }
  return { start, end, level }
}

/**
 * 把 `fromLine` 所在的章节搬到 `toLine` 所在标题的前面/后面。
 *
 * @param {string} text - 正文。
 * @param {number} fromLine - 被拖动章节的标题行(1 基)。
 * @param {number} toLine - 落点标题行(1 基)。
 * @param {'before'|'after'} mode - 落在目标标题之前 / 目标章节之后。
 * @returns {{ text:string, line:number }|null} 新正文与新标题行号;不能移动时返回 null。
 */
export function moveSection(text, fromLine, toLine, mode = 'before') {
  const source = String(text ?? '')
  const lines = source.split(/\r?\n/)
  const count = lines.length
  const inRange = (line) => Number.isFinite(line) && line >= 1 && line <= count
  if (!inRange(fromLine) || !inRange(toLine)) return null
  const headings = parseOutline(source)
  const sourceRange = sectionRange(headings, fromLine, count)
  const targetRange = sectionRange(headings, toLine, count)
  if (sourceRange === null || targetRange === null) return null
  if (sourceRange.start === targetRange.start) return null
  // 落点在源章节内部 = 没有意义
  if (targetRange.start >= sourceRange.start && targetRange.start <= sourceRange.end) return null

  const block = lines.slice(sourceRange.start - 1, sourceRange.end)
  const rest = lines.slice(0, sourceRange.start - 1).concat(lines.slice(sourceRange.end))

  // 目标在源之后时,摘除源会让目标整体上移 block.length 行
  const shift = targetRange.start > sourceRange.start ? block.length : 0
  const anchorSectionStart = targetRange.start - 1 - shift
  const insertAt = mode === 'after' ? targetRange.end - shift : anchorSectionStart
  const at = Math.max(0, Math.min(rest.length, insertAt))
  const next = rest.slice(0, at).concat(block, rest.slice(at))
  return { text: next.join('\n'), line: at + 1 }
}
