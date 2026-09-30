import { test } from 'node:test'
import assert from 'node:assert/strict'

import { HIDE, LINE, MARK, WIDGET, cursorInRange, decideDecorations, lineIndex } from '../lib/markdown-render.js'

/**
 * 语法树直接用 `@codemirror/lang-markdown` 的 lezer 语言(纯 JS,不需要 DOM)。
 * 这些依赖装在构建工具链目录里(见 AGENTS.md:`node_modules` 是符号链接,不在本目录装包),
 * 所以这里走相对路径 deep import。
 */
const { markdownLanguage } = await import('../scripts/node_modules/@codemirror/lang-markdown/dist/index.js')

/** 解析正文。 */
const parse = (text) => markdownLanguage.parser.parse(text)

/**
 * 决策一层。
 *
 * 默认选区放在**文档末尾**(通常是最后那行空行):真实编辑器里光标也总在某处,
 * 而放在 0 就等于"光标落在第一个构造上",按设计那一条就该显示源码 —— 早期
 * 用例因此误判成"标记没隐藏"。
 */
const decide = (text, selection, knownTitles = new Set()) =>
  decideDecorations({
    tree: parse(text),
    text,
    selection: selection ?? [{ from: text.length, to: text.length }],
    knownTitles,
    // 这些用例测的是"还原"行为,显式打开 reveal;预览模式的默认行为见下面单独一条
    reveal: true,
  })

test('预览模式(默认 reveal: false):光标在构造里也**不还原**源码(Typora 手感)', () => {
  const text = '> 引用\n\n**粗**\n'
  const descs = decideDecorations({
    tree: parse(text),
    text,
    selection: [{ from: 3, to: 3 }],
  })
  const hidden = descs.filter((item) => item.kind === 'hide').map((item) => text.slice(item.from, item.to))
  assert.deepEqual(hidden.sort(), ['**', '**', '>'])
})

/** 取某类描述。 */
const only = (descs, kind) => descs.filter((item) => item.kind === kind)
/** 取覆盖某位置的描述。 */
const at = (descs, pos) => descs.filter((item) => item.from <= pos && item.to > pos)

test('cursorInRange: 相交判定(含边界)', () => {
  assert.equal(cursorInRange([{ from: 3, to: 5 }], 0, 3), true)
  assert.equal(cursorInRange([{ from: 3, to: 5 }], 5, 8), true)
  assert.equal(cursorInRange([{ from: 3, to: 5 }], 6, 8), false)
  assert.equal(cursorInRange([{ from: 3, to: 3 }], 4, 5), false)
})

test('lineIndex: 行号/行首/行尾/行文本', () => {
  const lines = lineIndex('a\nbb\n\nccc')
  assert.equal(lines.count, 4)
  assert.deepEqual([lines.text(1), lines.text(2), lines.text(3), lines.text(4)], ['a', 'bb', '', 'ccc'])
  assert.equal(lines.lineOf(0), 1)
  assert.equal(lines.lineOf(2), 2)
  assert.equal(lines.lineOf(6), 4)
  assert.equal(lines.start(4), 6)
  assert.equal(lines.end(2), 4)
})

test('标题:非还原态隐藏 `#`,光标进这一行就显示;行装饰按层级', () => {
  const text = '# 一级\n\n## 二级\n'
  const hidden = decide(text)
  assert.deepEqual(only(hidden, LINE).map((item) => item.cls), ['h1', 'h2'])
  assert.deepEqual(only(hidden, HIDE).map((item) => [item.from, item.to]), [[0, 1], [6, 8]])

  // 光标落在第一行 → `#` 还原,第二行的 `##` 仍隐藏
  const revealed = decide(text, [{ from: 3, to: 3 }])
  const hides = only(revealed, HIDE).map((item) => item.from)
  assert.equal(hides.includes(0), false)
  assert.equal(hides.includes(6), true)
})

test('加粗/斜体/行内码/删除线:标记隐藏,文本着色;光标进节点则还原', () => {
  const text = '**粗** 与 *斜* 与 `码` 与 ~~删~~\n'
  const descs = decide(text)
  assert.deepEqual(only(descs, MARK).map((item) => item.cls), ['strong', 'em', 'code', 'strike'])
  // 4 组标记、共 8 个标记符号被隐藏
  assert.equal(only(descs, HIDE).length, 8)

  const italicAt = text.indexOf('*斜*')
  const revealed = decide(text, [{ from: italicAt + 1, to: italicAt + 1 }])
  const hidden = only(revealed, HIDE).map((item) => `${item.from}-${item.to}`)
  assert.equal(hidden.includes(`${italicAt}-${italicAt + 1}`), false)
  assert.equal(hidden.includes(`${italicAt + 2}-${italicAt + 3}`), false)
})

test('链接:文字着色,非还原态连方括号与地址一起隐藏', () => {
  const text = '[标题](https://x.com)\n'
  const descs = decide(text)
  assert.deepEqual(only(descs, MARK).map((item) => item.cls), ['link'])
  // `[`、`]`、`(`、URL、`)` 都隐藏 → 只剩"标题"
  const hiddenText = only(descs, HIDE)
    .sort((a, b) => a.from - b.from)
    .map((item) => text.slice(item.from, item.to))
    .join('')
  assert.equal(hiddenText, '[](https://x.com)')

  const inside = decide(text, [{ from: 1, to: 1 }])
  assert.equal(only(inside, HIDE).length, 0)
})

test('图片:行内 widget(不跨行替换),光标进去**展开成源码**', () => {
  const text = '前 ![示意图](img/a.png) 后\n'
  const descs = decide(text)
  const widgets = only(descs, WIDGET)
  assert.equal(widgets.length, 1)
  assert.equal(widgets[0].widget, 'image')
  assert.deepEqual(widgets[0].data, { alt: '示意图', destination: 'img/a.png' })

  const revealed = decide(text, [{ from: 5, to: 5 }])
  // 展开 = 该区间**不加任何装饰**,直接看到 `![示意图](img/a.png)`
  assert.equal(only(revealed, WIDGET).length, 0)
  assert.equal(only(revealed, MARK).length, 0)
})

test('任务列表:复选框 widget(勾选状态),`-` 一起隐藏(结构标记,光标进去也不展开)', () => {
  const text = '- [ ] 未完成\n- [x] 已完成\n'
  const descs = decide(text)
  const tasks = only(descs, WIDGET).filter((item) => item.widget === 'task')
  assert.deepEqual(tasks.map((item) => item.data.checked), [false, true])
  // 两条 `-` 都隐藏(任务项不留 `-`),没有 bullet widget
  assert.equal(only(descs, WIDGET).filter((item) => item.widget === 'bullet').length, 0)
  assert.deepEqual(only(descs, HIDE).map((item) => text.slice(item.from, item.to)), ['-', '-'])

  // 光标进任务行:复选框**依然是复选框**(结构标记不展开),只把 `-` 留着隐藏
  const onTask = decide(text, [{ from: 3, to: 3 }])
  assert.equal(only(onTask, WIDGET).filter((item) => item.widget === 'task').length, 2)
  assert.deepEqual(only(onTask, HIDE).map((item) => text.slice(item.from, item.to)), ['-', '-'])
})

test('无序列表:`-` 渲染成项目符号;有序列表保留数字', () => {
  const bullet = decide('- 甲\n- 乙\n')
  assert.equal(only(bullet, WIDGET).filter((item) => item.widget === 'bullet').length, 2)
  assert.equal(only(bullet, HIDE).length, 0)

  const ordered = decide('1. 甲\n2. 乙\n')
  assert.equal(only(ordered, WIDGET).length, 0)
  assert.equal(only(ordered, HIDE).length, 0)

  // 光标在列表行:项目符号**保持渲染**(与 `>` 一致,结构标记不展开)
  const revealed = decide('- 甲\n', [{ from: 2, to: 2 }])
  assert.equal(only(revealed, WIDGET).filter((item) => item.widget === 'bullet').length, 1)
  assert.equal(only(revealed, HIDE).length, 0)
})

test('引用:整块行装饰,`>` 非还原态隐藏', () => {
  const text = '> 第一行\n> 第二行\n'
  const descs = decide(text)
  assert.deepEqual(only(descs, LINE).map((item) => item.cls), ['quote', 'quote'])
  assert.deepEqual(only(descs, HIDE).map((item) => text.slice(item.from, item.to)), ['>', '>'])
})

test('代码围栏:首行 codeLang、其余 code,围栏 ``` 隐藏;代码里的标记语法不参与渲染', () => {
  const text = '```js\nconst a = **不是加粗**\n```\n'
  const descs = decide(text)
  // 首行语言 chip、正文 code、末行围栏 codeEnd(折叠掉)
  assert.deepEqual(only(descs, LINE).map((item) => item.cls), ['codeLang', 'code', 'codeEnd'])
  assert.equal(only(descs, MARK).length, 0, '代码块里不应产生加粗装饰')
  assert.deepEqual(
    only(descs, HIDE).map((item) => text.slice(item.from, item.to)),
    ['```', '```'],
  )
})

test('代码围栏:还原态区分围栏两行(codeOpen/codeClose)—— 卡片与源码等高靠它补留白', () => {
  const text = '```js\nconst a = 1\n```\n'
  const descs = decide(text, [{ from: 12, to: 12 }]) // 光标落在 `const a = 1` 这一行里
  assert.deepEqual(only(descs, LINE).map((item) => item.cls), ['codeOpen', 'code', 'codeClose'])
})

test('表格:表头/分隔行/数据行的行装饰', () => {
  const text = '| A | B |\n| --- | --- |\n| 1 | 2 |\n'
  const descs = decide(text)
  assert.deepEqual(only(descs, LINE).map((item) => item.cls), ['tableHead', 'tableDelim', 'tableRow'])
})

test('frontmatter:整块弱化,里面的 `#`/`---` 不产生标题与分隔线', () => {
  const text = '---\ndsh-note-id: n_1\n# 不是标题\n---\n\n# 真标题\n'
  const descs = decide(text)
  const lineClasses = only(descs, LINE).map((item) => item.cls)
  assert.deepEqual(lineClasses.filter((cls) => cls === 'frontmatter').length, 4)
  assert.deepEqual(lineClasses.filter((cls) => cls === 'h1').length, 1)
  assert.equal(lineClasses.includes('rule'), false)
})

test('分隔线产生 rule;空文档与纯文本不炸', () => {
  assert.deepEqual(only(decide('---\n'), LINE).map((item) => item.cls), ['rule'])
  assert.deepEqual(decide(''), [])
  assert.deepEqual(only(decide('就是一段普通文字\n'), LINE).length, 0)
})

test('描述按位置有序(运行时用 RangeSet.of(..., sort) 也依赖这一点)', () => {
  const descs = decide('# 标题\n\n**粗**、`码`\n\n- 项\n')
  const positions = descs.map((item) => item.from)
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b))
})
