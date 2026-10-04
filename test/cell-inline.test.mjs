import { test } from 'node:test'
import assert from 'node:assert/strict'

import { HIDE, MARK, WIDGET, decideDecorations } from '../lib/markdown-render.js'
import { markdownSyntaxConfig } from '../lib/markdown-syntax.js'
import { MARK_CLASS, inlineNodes, nodeClasses, nodeText } from '../src/client/editor/cell-inline.ts'

/**
 * 表格单元格里的**行内**渲染(纯逻辑那一半)。
 *
 * 靶子(用户实测):单元格以前是 `td.textContent = cell.text`,于是表格里的
 * `**加粗**`、`$公式$`、`==高亮==`、`` `代码` `` 全显示原文 —— "表格里面没法渲染"。
 *
 * 这里锁住两件事:
 *   1. 折叠**嵌套**区间要对:`**粗体里的 `代码`**` 是 MARK 套 MARK + 两个 HIDE;
 *   2. 标记(`**`、`$`、`[[`…`]]`)必须从可见文字里消失,内容一个字都不能丢。
 *
 * 解析器必须与运行时同构(配置过自研行内语法),否则 `[[x]]` / `==x==` / `$x$`
 * 根本不会被解析成对应节点 —— 项目里的第四条硬规则。
 */
const parse = (text) => markdownLanguage.parser.configure(markdownSyntaxConfig()).parse(text)
const { markdownLanguage } = await import('../scripts/node_modules/@codemirror/lang-markdown/dist/index.js')

/** 单元格原文 → 节点树(与运行时同一条路)。 */
const nodesOf = (text, knownTitles = new Set()) =>
  inlineNodes(text, decideDecorations({ tree: parse(text), text, knownTitles }))

test('加粗 / 斜体 / 行内码 / 删除线 / 高亮:标记消失、内容还在、类名对', () => {
  const cases = [
    ['**加粗**', '加粗', 'dsh-cm-strong'],
    ['*斜体*', '斜体', 'dsh-cm-em'],
    ['`code`', 'code', 'dsh-cm-code'],
    ['~~删除~~', '删除', 'dsh-cm-strike'],
    ['==高亮==', '高亮', 'dsh-cm-highlight'],
  ]
  for (const [source, visible, cls] of cases) {
    const nodes = nodesOf(source)
    assert.equal(nodeText(nodes), visible, `${source} 的可见文字`)
    assert.deepEqual(nodeClasses(nodes), [cls], `${source} 的类名`)
    assert.equal(MARK_CLASS[cls.replace('dsh-cm-', '')], cls, 'MARK_CLASS 与 theme 的类名要对得上')
  }
})

test('嵌套:`**粗体里的 `代码`**` 两个类名都在,标记全消失', () => {
  const source = '**粗体里的 `代码`**'
  const nodes = nodesOf(source)
  assert.equal(nodeText(nodes), '粗体里的 代码', '四个标记(`**` ×2 + `` ` `` ×2)都要藏掉')
  assert.deepEqual(nodeClasses(nodes).sort(), ['dsh-cm-code', 'dsh-cm-strong'])
})

test('公式:整段换成 widget,teX 取到 `$` 之间的内容', () => {
  const nodes = nodesOf('$kC_n \\approx C_{po}$ 一阶抵消寄生电流')
  const widget = nodes.find((node) => node.kind === 'widget')
  assert.notEqual(widget, undefined, '必须有 math widget(否则公式会显示成原文)')
  assert.equal(widget.widget, 'math')
  assert.equal(widget.tex, 'kC_n \\approx C_{po}', 'tex 不该带两边的 `$`')
  // nodeText 是调试/断言助手:widget 参与时用它的**原文**(所以还带着 `$`)
  assert.equal(nodeText(nodes), '$kC_n \\approx C_{po}$ 一阶抵消寄生电流')
})

test('图题(图片 alt)里的公式要能渲染 —— 论文图注的典型写法', () => {
  // 用户实测:`![图 4 纳米孔源 + 运放 $A$ + 单位增益 buffer $A_1$](…)` 的**图题**
  // 以前是 `caption.textContent = alt`,于是 `$A$` / `$A_1$` 原样显示成源码。
  // 现在图题与表格单元格走**同一套**决策层(renderCell),这条用例锁住那一半纯逻辑。
  const caption = '图 4 纳米孔源 + 运放 $A$ + 单位增益 buffer $A_1$'
  const nodes = nodesOf(caption)
  const maths = nodes.filter((node) => node.kind === 'widget' && node.widget === 'math').map((node) => node.tex)
  assert.deepEqual(maths, ['A', 'A_1'], '两个行内公式都要变成 math widget')
  assert.equal(nodeText(nodes), caption, '除公式本身外,图题文字一个字都不能丢')
  // 图题里写 `**图 4**` 很常见:加粗也必须认
  assert.deepEqual(nodeClasses(nodesOf('**图 4** 示意')), ['dsh-cm-strong'])
})

test('双链:按标题表上色,`[[` `]]` 消失', () => {
  const known = nodesOf('见 [[TC 机制]]', new Set(['TC 机制']))
  assert.equal(nodeText(known), '见 TC 机制')
  assert.deepEqual(nodeClasses(known), ['dsh-cm-wiki'])
  const missing = nodesOf('见 [[还没有的笔记]]')
  assert.deepEqual(nodeClasses(missing), ['dsh-cm-wiki-new'], '不存在的标题要用另一种样式')
})

test('链接:地址与标记藏掉,只留文字', () => {
  const nodes = nodesOf('[IEEE](https://ieee.org) 的文献')
  assert.equal(nodeText(nodes), 'IEEE 的文献')
  assert.deepEqual(nodeClasses(nodes), ['dsh-cm-link'])
})

test('一张典型表格行里的每格都能渲染(用户报的那张表)', () => {
  const cells = ['10 kHz 主指标', '**45.0 fF**', '$C_{FB,opt}=\\dfrac{\\sqrt2}{\\omega_{CL}R_F}$', '残留 ≤5% 即回到 9.7 kHz']
  assert.equal(nodeText(nodesOf(cells[1])), '45.0 fF')
  assert.deepEqual(nodeClasses(nodesOf(cells[1])), ['dsh-cm-strong'])
  const formula = nodesOf(cells[2])
  assert.equal(formula.some((node) => node.kind === 'widget' && node.widget === 'math'), true, '公式必须变成 widget')
  assert.equal(nodeText(nodesOf(cells[3])), '残留 ≤5% 即回到 9.7 kHz', '普通文字原样保留')
})

test('认不出来的 widget 退回原文(绝不吞内容)', () => {
  const nodes = inlineNodes('![图](a.png)', [
    { kind: WIDGET, from: 0, to: 11, widget: 'image', data: {} },
  ])
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].kind, 'widget')
  assert.equal(nodes[0].raw, '![图](a.png)', '单元格里的图片没有意义,但内容不能凭空消失')
})

test('区间越界 / 空文本 / 只给 HIDE 都不能崩', () => {
  assert.deepEqual(inlineNodes('', []), [])
  assert.deepEqual(nodeText(inlineNodes('abc', [{ kind: MARK, from: 0, to: 99, cls: 'strong' }])), 'abc', '越界的区间被丢掉')
  assert.deepEqual(nodeText(inlineNodes('abc', [{ kind: HIDE, from: 0, to: 3 }])), '', '整段被藏掉就是空的')
  assert.deepEqual(nodeText(inlineNodes('abc', [])), 'abc')
})

test('重叠区间不会把同一段文字吐两遍', () => {
  // 防御性:决策层给的是嵌套区间,真出现重叠也要退化成"只渲染一次"
  const nodes = inlineNodes('abcdef', [
    { kind: MARK, from: 0, to: 4, cls: 'strong' },
    { kind: MARK, from: 2, to: 6, cls: 'em' },
  ])
  assert.equal(nodeText(nodes), 'abcdef')
})
