/**
 * frontmatter 的区间判断(客户端侧,纯函数)。
 *
 * 与 Host 的 `lib/notes.js#frontmatterRange` 同款正则 —— 客户端不能 import 那个模块
 * (它依赖 `node:crypto`,打不进浏览器包)。
 */

import type { EditorState } from '@codemirror/state'

/**
 * frontmatter 收尾行的结束位置(只看前 200 行、只读行文本,不做 `doc.toString()`
 * —— 那个在每次状态更新时都很贵)。
 * @param state - 编辑器状态。
 * @returns 结束位置,或 null(不是 frontmatter)。
 */
export function frontmatterEndOf(state: EditorState): number | null {
  if (state.doc.lines < 2) return null
  if (state.doc.line(1).text.trim() !== '---') return null
  const limit = Math.min(state.doc.lines, 200)
  for (let number = 2; number <= limit; number += 1) {
    const line = state.doc.line(number)
    if (line.text.trim() === '---') return line.to
    if (line.text.trim() === '') return null
  }
  return null
}

/** frontmatter 文本区间(`---` … `---`,不含收尾行后的换行)。 */
export function frontmatterSpan(text: string): { from: number; to: number } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''))
  return match === null ? null : { from: 0, to: match[0].length }
}

/**
 * 打开笔记时光标该放在哪:frontmatter 之后的第一行。
 *
 * 不放 0 是因为"光标在 frontmatter 里 → 展开源码"这条规则会让**每次打开笔记**
 * 都把 frontmatter 摊开(实测)。放到正文第一行,chip 才会显示;想改就点 chip。
 * @param text - 文件全文。
 * @returns 光标位置(没有 frontmatter 时 0)。
 */
export function initialAnchor(text: string): number {
  const span = frontmatterSpan(text)
  if (span === null) return 0
  let anchor = span.to
  while (anchor < text.length && (text[anchor] === '\n' || text[anchor] === '\r')) anchor += 1
  return anchor
}
