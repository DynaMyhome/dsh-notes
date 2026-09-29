/**
 * 从 Markdown 正文里抽出标题树(大纲面板用)。
 *
 * 纯函数、零依赖 —— Host 与客户端共用同一份实现,也便于单测。
 * 规则:跳过代码围栏内的 `#`,标题文本去掉常见行内标记(便于在大纲里阅读)。
 */

/**
 * @typedef {object} OutlineItem
 * @property {number} level - 1..6
 * @property {string} text - 清理过行内标记的标题文本
 * @property {number} line - 1 基行号(用于跳转)
 */

/** 去掉行内标记,得到适合显示的标题文本。 */
export function cleanHeadingText(text) {
  return String(text ?? '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/==([^=]*)==/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/~~([^~]*)~~/g, '$1')
    .trim()
}

/**
 * 解析大纲。
 * @param {string} text - Markdown 正文。
 * @returns {OutlineItem[]} 标题序列(按出现顺序)。
 */
export function parseOutline(text) {
  const out = []
  const lines = String(text ?? '').split(/\r?\n/)
  let fence = null
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const trimmed = raw.trim()
    const open = /^(```|~~~)/.exec(trimmed)
    if (open !== null) {
      if (fence === null) fence = open[1]
      else if (trimmed.startsWith(fence)) fence = null
      continue
    }
    if (fence !== null) continue
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(trimmed)
    if (match === null) continue
    const cleaned = cleanHeadingText(match[2])
    if (cleaned === '') continue
    out.push({ level: match[1].length, text: cleaned, line: index + 1 })
  }
  return out
}
