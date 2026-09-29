import { test } from 'node:test'
import assert from 'node:assert/strict'

import { markdownSyntaxConfig } from '../lib/markdown-syntax.js'

/** 真解析器(纯 JS,不需要 DOM);依赖装在构建工具链目录,走相对路径 deep import。 */
const { markdownLanguage } = await import('../scripts/node_modules/@codemirror/lang-markdown/dist/index.js')

const parser = markdownLanguage.parser.configure(markdownSyntaxConfig())

/** 把语法树摊平成 `名字[from-to]`(去掉 Document 这层噪声)。 */
function nodes(text) {
  const out = []
  parser.parse(text).iterate({
    enter: (node) => out.push(`${node.name}[${node.from}-${node.to}]`),
  })
  return out.filter((line) => !line.startsWith('Document'))
}

/** 只要某前缀的节点。 */
const pick = (text, prefix) => nodes(text).filter((item) => item.startsWith(prefix))

test('==高亮==:解析成 Highlight + 两个 HighlightMark', () => {
  // `==`(2) + `高亮`(2) + `==`(2) = 6(UTF-16 长度,不是字符数)
  assert.deepEqual(nodes('==高亮=='), ['Paragraph[0-6]', 'Highlight[0-6]', 'HighlightMark[0-2]', 'HighlightMark[4-6]'])
})

test('==高亮==:未闭合 / 空内容 / 跨行都不成节点', () => {
  assert.equal(pick('前面 ==没闭合\n', 'Highlight').length, 0)
  assert.equal(pick('====\n', 'Highlight').length, 0)
  // `==\n==` 会被 markdown 自己解析成 Setext 标题 —— 只要不产生 Highlight 就算对
  assert.equal(pick('==\n==\n', 'Highlight').length, 0)
})

test('==高亮== 与标准行内语法共存', () => {
  const list = nodes('**粗** 与 ==高亮== 与 `码`\n')
  assert.ok(list.includes('StrongEmphasis[0-5]'))
  assert.ok(list.includes('Highlight[8-14]'))
  assert.ok(list.includes('InlineCode[17-20]'))
})

test('==高亮== 在代码块里不解析', () => {
  assert.equal(pick('```\n==x==\n```\n', 'Highlight').length, 0)
})

test('[[双链]]:目标 / 别名 / 标记', () => {
  assert.deepEqual(nodes('[[目标]]'), [
    'Paragraph[0-6]',
    'WikiLink[0-6]',
    'WikiLinkMark[0-2]',
    'WikiLinkTarget[2-4]',
    'WikiLinkMark[4-6]',
  ])

  assert.deepEqual(nodes('[[目标|显示名]]'), [
    'Paragraph[0-10]',
    'WikiLink[0-10]',
    'WikiLinkMark[0-2]',
    'WikiLinkTarget[2-4]',
    'WikiLinkAlias[5-8]',
    'WikiLinkMark[8-10]',
  ])
})

test('[[双链]]:未闭合 / 空目标 / 只有别名都不成 WikiLink', () => {
  assert.equal(pick('[[没闭合\n', 'WikiLink').length, 0)
  assert.equal(pick('[[]]\n', 'WikiLink').length, 0)
  assert.equal(pick('[[|别名]]\n', 'WikiLink').length, 0)
})

test('[[双链]] 抢在标准 Link 之前:不会被当成本地链接引用', () => {
  const list = nodes('[[目标]] 与 [普通](https://x)\n')
  assert.ok(list.includes('WikiLink[0-6]'))
  assert.ok(
    list.some((item) => item.startsWith('Link[')),
    '普通链接仍要正常解析',
  )
  assert.equal(list.some((item) => item.startsWith('LinkReference')), false)
})

test('同一行多个构造互不干扰', () => {
  const list = nodes('a ==一== b [[二]] c ==三==\n')
  assert.equal(pick('a ==一== b [[二]] c ==三==\n', 'Highlight[').length, 2)
  assert.equal(pick('a ==一== b [[二]] c ==三==\n', 'WikiLink[').length, 1)
  void list
})
