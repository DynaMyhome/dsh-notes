/**
 * 行内 markdown 的**共享解析器**(单例)。
 *
 * 为什么单独成一个模块:渲染决策层(`lib/markdown-render.js` 的 `decideDecorations`)
 * 只认 lezer 语法树,而 `[[双链]]` / `==高亮==` / `$公式$` 是**自定义行内语法**
 * (见 `lib/markdown-syntax.js`)—— 裸 `markdownLanguage.parser` 根本不会把它们
 * 解析成节点(硬规则 4:单测必须与运行时同构)。
 *
 * 以前每个调用点各写一遍 `markdownLanguage.parser.configure(markdownSyntaxConfig())`,
 * 现在收敛到**一个**配置好的 parser:表格单元格(`table.ts`)、图题(`decorate.ts`)、
 * 回退装饰层(`setup.ts`)共用它,避免"某个调用点漏配置 → 那一处的 `$公式$` 永远是原文"。
 * `configure()` 有成本,所以只在模块加载时做一次。
 */

import { markdownLanguage } from '@codemirror/lang-markdown'

import { markdownSyntaxConfig } from '../../../lib/markdown-syntax.js'

/** 配置过自定义行内语法的解析器(单例)。 */
const parser = markdownLanguage.parser.configure(markdownSyntaxConfig())

/**
 * 解析一段**行内** markdown,返回 lezer 语法树。
 * @param source - 行内原文(表格单元格 / 图题 / 其它单段文本)。
 * @returns 语法树(类型交给 `decideDecorations`,这里不做断言)。
 */
export const parseInlineMarkdown = (source: string): unknown => parser.parse(source)
