/**
 * 「引用此处」的载荷构造(纯函数,可单测)。
 *
 * 目标:让用户右键一下就能把**这篇笔记的哪一段**贴进对话,agent 既能找到文件、
 * 也能定位到具体位置。参照了 Obsidian 的 `[[Note#Heading]]` 思路,但我们多加两样:
 *
 *   - `@<工作区相对路径>:L12-L14` —— DSH 消息框认的**文件引用**语法,粘进对话即被识别,
 *     agent 也能按行号精确定位(行号会漂,所以还有下面那样);
 *   - `§ 标题面包屑` —— 标题比行号稳,两样都给,agent 可以互相校正。
 *
 * **不采用** Obsidian 的 `^blockid`:那要往 md 里写标记,破坏"永不改用户内容"的不变量,
 * 而且出了 Obsidian 就失效。
 */

/** 构造输入。 */
export interface ReferenceInput {
  /** 工作区相对路径(如 `notes/编辑器验收.md`)。 */
  relPath: string
  /** 文件全文。 */
  text: string
  /** 选区起点(0-based offset)。 */
  from: number
  /** 选区终点(=起点表示没有选区)。 */
  to: number
  /** 标题面包屑(如 `外部改的标题 › d`),可空。 */
  heading?: string
  /** 跨工作区映射时,标注这篇笔记来自哪个工作区。 */
  workspaceName?: string
}

/** 引文最多几行 / 多少字(超出截断,避免把整篇笔记灌进对话)。 */
export const QUOTE_MAX_LINES = 12
export const QUOTE_MAX_CHARS = 600

/** 1-based 行号(offset 落在第几行)。 */
function lineOf(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(text.length, offset))
  let line = 1
  for (let index = 0; index < clamped; index += 1) if (text[index] === '\n') line += 1
  return line
}

/** 取某一行的文本(1-based)。 */
function lineText(text: string, line: number): string {
  const lines = text.split(/\r?\n/)
  return lines[line - 1] ?? ''
}

/**
 * 生成可以直接粘进消息框的引用载荷。
 * @param input - 见 {@link ReferenceInput}。
 * @returns 多行文本(路径行 + 可选标题行 + 引用块)。
 */
export function buildNoteReference(input: ReferenceInput): string {
  const text = String(input.text ?? '')
  const from = Math.max(0, Math.min(text.length, Math.min(input.from, input.to)))
  const to = Math.max(from, Math.min(text.length, Math.max(input.from, input.to)))
  const startLine = lineOf(text, from)
  const endLine = lineOf(text, to)

  // 第一行:文件 + 行号(单行不写成 L12-L12)
  const where = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`
  const out: string[] = [`@${input.relPath}:${where}`]

  if (input.heading !== undefined && input.heading.trim() !== '') out.push(`§ ${input.heading.trim()}`)
  if (input.workspaceName !== undefined && input.workspaceName.trim() !== '') {
    out.push(`(来自工作区 ${input.workspaceName.trim()})`)
  }

  // 引用块:有选区就用选区,没有就用光标所在那一行
  const raw = to > from ? text.slice(from, to) : lineText(text, startLine)
  const lines = raw.replace(/\s+$/, '').split(/\r?\n/)
  const clipped = lines.slice(0, QUOTE_MAX_LINES).map((line) => `> ${line}`.trimEnd())
  if (lines.length > QUOTE_MAX_LINES) clipped.push('> …')
  for (const line of clipped) {
    if ((out.join('\n') + line).length > QUOTE_MAX_CHARS) {
      out.push('> …')
      break
    }
    out.push(line)
  }
  return out.join('\n')
}

/**
 * 光标上文最近的标题路径(如 `一级 › 二级`),给引用载荷做"比行号稳"的锚点。
 * @param text - 文件全文。
 * @param offset - 光标/选区起点。
 * @returns 面包屑;没有标题时空串。
 */
export function headingBreadcrumb(text: string, offset: number): string {
  const clamped = Math.max(0, Math.min(String(text ?? '').length, offset))
  const before = String(text ?? '').slice(0, clamped).split(/\r?\n/)
  const stack = new Map<number, string>()
  for (const line of before) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (match === null) continue
    const level = match[1].length
    for (const key of [...stack.keys()]) if (key >= level) stack.delete(key)
    stack.set(level, match[2].trim())
  }
  return [...stack.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1]).join(' › ')
}
