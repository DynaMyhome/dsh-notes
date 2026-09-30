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
  if (text.length === 0) return 0
  // 打开笔记时的初始光标放在**最后一行**。
  //
  // 为什么不是开头:预览模式会"光标所在行显示源码"(需要就地编辑),而初始光标若落在
  // 第一行,那一行的标记(`#` 标题等)就会一直**展开**着,看起来像没渲染(用户实测:
  // "每个新打开的笔记第一行总是展开的,必须点一下别处才行")。放文末既避开第一行,
  // 又正好是"继续往下写"的位置。
  const lines = text.split('\n')
  let offset = 0
  for (let index = 0; index < lines.length - 1; index += 1) offset += lines[index].length + 1
  const last = lines[lines.length - 1]
  // 末行是空行时,光标放这一行(而不是加一个字符);否则放行尾
  return last.trim() === '' ? offset : offset + last.length
}
