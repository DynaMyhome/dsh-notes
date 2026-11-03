import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/**
 * 公式字体的**回归守卫**(纯文本扫描,不 import TS、不需要 DOM)。
 *
 * Temml 只输出 MathML,而可拉伸定界符(`\left\{` / `\begin{cases}` 的大括号、`\left(` …)
 * 依赖字体里的 MATH 表做「组装」。`math` 元素的有效字体一旦落到普通字体,大括号就缩成
 * 基号大小并垂直居中(只对齐某一行)—— 2026-10-05 用户实测,Edge 153 上同一段 MathML:
 * `math` 默认字体 mo=147.0/table=142.8(拉伸),显式 `monospace`/`inherit` 时 mo=35.0/table=133.8。
 *
 * 所以 `styles.ts` 里那条 `.dsh-notes-root math{font-family:…}` **不能被删掉**;
 * 这条用例就是拦住「顺手清理」的那一刀,并顺带拦住「改了样式忘了 `npm run build`」。
 */

const STYLES = 'src/client/styles.ts'
const BUNDLE = 'lib/client.js'

const styles = await readFile(STYLES, 'utf8')

/** 取出 `.dsh-notes-root math{…}` 的声明体。 */
function mathRule(source) {
  const rule = /\.dsh-notes-root\s+math\s*\{([^}]*)\}/.exec(source)
  assert.ok(rule !== null, `${STYLES} 里必须有 \`.dsh-notes-root math\` 规则(可拉伸定界符的字体来源)`)
  return rule[1]
}

test('math 元素显式指定数学字体(否则大括号不拉伸)', () => {
  const body = mathRule(styles)
  const family = /font-family:([^;}]*)/.exec(body)
  assert.ok(family !== null, '`.dsh-notes-root math` 必须设置 font-family')
  const stack = family[1]

  // Windows 上一定有、且带 MATH 表 —— 列表按顺序取第一个可用的,所以必须排在 serif/math 之前。
  assert.match(stack, /"Cambria Math"/, '字体栈必须含 Cambria Math(Windows 的数学字体)')
  assert.ok(
    stack.indexOf('"Cambria Math"') < stack.indexOf('serif'),
    'Cambria Math 必须在 serif 之前(否则永远轮不到它)',
  )
  // 平台 math 泛型与 serif 只作兜底。
  assert.match(stack, /(^|,)\s*math\s*(,|$)/, '字体栈必须保留平台 `math` 泛型作兜底')
  // 绝不能退回继承:那正是「大括号塌掉」的形态。
  assert.ok(!/inherit/.test(stack), '字体栈不允许出现 inherit')
})

test('公式字体只改 font-family,不动行高', () => {
  // 行高参与 CM6 的行盒测量与点击落点(见 AGENTS「点击落点」),不许在 math 上改它。
  assert.ok(!/line-height/.test(mathRule(styles)), 'math 规则不许设置 line-height')
})

test('构建产物里带着这条字体栈(改完样式别忘了 npm run build)', async () => {
  let bundle = null
  try {
    bundle = await readFile(BUNDLE, 'utf8')
  } catch {
    bundle = null
  }
  if (bundle === null) return // 还没构建过:跳过(构建后会由本用例接管)
  assert.match(bundle, /"Cambria Math"/, `${BUNDLE} 里没有数学字体栈 —— 样式改了但没重新构建`)
})
