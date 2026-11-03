/**
 * 外部改动落进编辑器时的**最小改动**计算(纯函数,可单测)。
 *
 * ## 为什么不是"整篇替换"
 *
 * 磁盘内容变了,以前的写法是 `dispatch({changes:{from:0,to:doc.length,insert:text}})`
 * —— 一次事务把整篇换掉。后果有两个,用户 2026-10-09 都看到了:
 *
 *   1. **位置丢掉(被置顶)**:CM6 的高度图对"被改动的行"会丢掉已测高度、退回
 *      `lineHeight` 估算。整篇替换 = 全篇都变成估算,文档总高瞬间缩水(带图的行实测
 *      高到 320px,估算只有 ~24px),`scrollTop` 被夹到错误的范围;同时
 *      `ChangeDesc.mapPos` 对整篇替换把所有位置映射到插入段末尾,光标/视口一起失准。
 *   2. 撤销栈里也是一次"全文重写"。
 *
 * 只把**真正变了的那一段**交出去,未改动的行就仍然留在高度图里,CM6 的
 * `scrollSnapshot()`(按文档位置还原像素级滚动位置)才有意义。
 *
 * 归一化也在这里做:编辑器文档**恒为 LF**(`EditorState.create` 用
 * `/\r\n?|\n/` 切分),而 `readNote` 给的是**磁盘原文**(`lib/service.js` 未归一,
 * CRLF 文件原样返回)—— 不归一就会把"只是行尾不同"的整篇判成全文重写。
 */

/** 一处最小改动(语义同 CM6 的 change spec)。 */
export interface TextChange {
  /** 起始偏移(相对**旧**文档)。 */
  from: number
  /** 结束偏移(相对旧文档,不含)。 */
  to: number
  /** 替换进去的新文本。 */
  insert: string
}

/** 把任意行尾归一成 LF(编辑器文档的形态)。 */
export function normalizeToLf(text: string): string {
  return String(text ?? '').replace(/\r\n?/g, '\n')
}

/**
 * 夹出「公共前缀 + 公共后缀」之外的最小改动。
 * @param oldText - 当前编辑器文档(旧文本)。
 * @param newText - 磁盘上的新文本(CRLF 会被归一)。
 * @returns 最小改动;两边内容相同(归一后)返回 `null`。
 */
export function minimalChange(oldText: string, newText: string): TextChange | null {
  const before = normalizeToLf(oldText)
  const after = normalizeToLf(newText)
  if (before === after) return null

  const max = Math.min(before.length, after.length)
  let from = 0
  while (from < max && before.charCodeAt(from) === after.charCodeAt(from)) from += 1

  // 后缀不能越过前缀已经吃掉的部分(否则 insert 会带上重复内容)
  let tail = 0
  while (
    tail < max - from &&
    before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
  ) {
    tail += 1
  }

  return { from, to: before.length - tail, insert: after.slice(from, after.length - tail) }
}

/**
 * 这处改动是不是"把原来那篇换掉了"(存活下来的原样部分不到全文的 10%)。
 *
 * 是的话,**位置映射没有意义**:整篇替换时 `ChangeDesc.mapPos` 会把所有位置塌到插入段
 * 开头,表现就是"agent 改完,笔记被置顶"(用户 2026-10-09 实测)。所以调用方要换一条
 * 锚定策略:按**行号** + 行内像素偏移 —— 停在同一深度,而不是回到顶部。
 *
 * 用比例而不是"前后毫无公共部分":真实的重写往往还留着结尾那个换行(甚至留着页首页尾),
 * 严格相等会几乎永远不触发,兜底等于没有。
 * @param change - 最小改动。
 * @param oldLength - 旧文档长度。
 */
export function isMostlyRewritten(change: TextChange, oldLength: number): boolean {
  const surviving = change.from + (oldLength - change.to)
  return surviving < Math.max(2, Math.floor(oldLength * 0.1))
}
