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
 * CM6 切分行的正则(与 `@codemirror/state` 的 `DefaultSplit` 完全一致)。
 *
 * 别改成 `'\n'`:CRLF 会留下 `\r`,`normalizedLength` / `initialAnchor` 与编辑器里的
 * `doc.length` 就对不上了。
 */
export const LINE_SPLIT = /\r\n?|\n/

/**
 * 一段磁盘原文进编辑器之后的**文档长度**(CRLF / CR 归一掉之后的长度)。
 *
 * 状态栏的"字数"必须用它:CRLF 笔记按原文长度显示会多出"行数"那么多,
 * 与编辑器自己的计数对不上。
 * @param text - 磁盘原文。
 * @returns 归一后长度。
 */
export function normalizedLength(text: string): number {
  const value = String(text ?? '')
  if (!value.includes('\r')) return value.length
  return value.split(LINE_SPLIT).join('\n').length
}

/**
 * 打开笔记时光标该放在哪。
 *
 * **坐标必须是"归一后文档"里的偏移**:`EditorState.create({ doc })` 内部是
 * `Text.of(doc.split(/\r\n?|\n/))`(见 {@link LINE_SPLIT}),CRLF 会被归一成 LF ——
 * 同一段文本进编辑器后 `doc.length` **比原文少掉 CR 的个数**。旧实现按 `'\n'` 切分、
 * 拿原文长度当坐标,于是 CRLF 笔记(用户实测 123KB / 1244 个 CR)一打开就抛
 * `Selection points outside of document`。所以这里与 {@link normalizedLength}
 * 用的是**同一个切分规则**。
 *
 * 不放 0 是因为"光标在 frontmatter 里 → 展开源码"这条规则会让**每次打开笔记**
 * 都把 frontmatter 摊开(实测)。放到文末既避开第一行,又正好是"继续往下写"的位置。
 * @param text - 文件全文(磁盘原文,可能是 CRLF)。
 * @returns 光标位置(归一后文档里的偏移)。
 */
export function initialAnchor(text: string): number {
  const value = String(text ?? '')
  if (value.length === 0) return 0
  const lines = value.split(LINE_SPLIT)
  let offset = 0
  for (let index = 0; index < lines.length - 1; index += 1) offset += lines[index].length + 1
  const last = lines[lines.length - 1]
  // 末行是空行时,光标放这一行(而不是加一个字符);否则放行尾
  return last.trim() === '' ? offset : offset + last.length
}
