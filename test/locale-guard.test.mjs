import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 文案守卫(纯文本扫描,不需要 import 任何 TS/DOM)。
 *
 * 兜三类问题,都是用户审计里真出现过的:
 *   1. **zh / en 字典必须一一对应**(以前靠人肉同步,漏一个键就有一处回落成 key);
 *   2. **英文界面里不能出现中文**(词典值 + widget 里硬编码的中文都算);
 *   3. 命令式 DOM(widget)里的用户可见文案必须走 `strings`(见 table.ts 的 WidgetStrings),
 *      不允许再写死 `textContent = '…'`。
 *
 * 这类"守卫"测试的价值在于:以后再加文案时,忘了加 key / 忘了走字典会立刻变红,
 * 而不是等到有人切到英文界面才发现。
 */

const MAIN = 'src/client/main.tsx'
/** 常见的中文范围(CJK 统一表意 + 全角标点)。 */
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/

/** 取 `const ZH: Record<string, string> = { … }` 这一段。 */
function dictionary(source, name) {
  const start = source.indexOf(`const ${name}: Record<string, string> = {`)
  assert.notEqual(start, -1, `找不到 ${name} 字典`)
  const end = source.indexOf('\n}\n', start)
  assert.notEqual(end, -1, `${name} 字典没有结束`)
  const body = source.slice(start, end)
  const entries = [...body.matchAll(/'([^']+)':\s*'([^']*)'/g)].map(([, key, value]) => ({ key, value }))
  return entries
}

const main = await readFile(MAIN, 'utf8')
const zh = dictionary(main, 'ZH')
const en = dictionary(main, 'EN')

test('zh / en 两份字典的键必须完全一致', () => {
  const zhKeys = new Set(zh.map((entry) => entry.key))
  const enKeys = new Set(en.map((entry) => entry.key))
  const onlyZh = [...zhKeys].filter((key) => !enKeys.has(key))
  const onlyEn = [...enKeys].filter((key) => !zhKeys.has(key))
  assert.deepEqual(onlyZh, [], '只有中文的键(英文界面会露出 key)')
  assert.deepEqual(onlyEn, [], '只有英文的键(中文界面会露出 key)')
  assert.equal(zhKeys.size > 150, true, `字典条数异常:${zhKeys.size}`)
})

test('英文词典里不能有中文', () => {
  const leaked = en.filter((entry) => CJK.test(entry.value))
  assert.deepEqual(leaked.map((entry) => entry.key), [], '英文值里混进了中文')
})

test('widget / 快速打开要用的键必须在两份字典里都有', () => {
  const need = ['editor.chipMeta', 'editor.chipExpand', 'editor.codeCopy', 'editor.codeCopied', 'editor.codeLang', 'quick.placeholder', 'quick.empty']
  for (const key of need) {
    assert.equal(zh.some((entry) => entry.key === key), true, `中文缺 ${key}`)
    assert.equal(en.some((entry) => entry.key === key), true, `英文缺 ${key}`)
  }
})

/** 递归收集 src/client 下的源文件。 */
async function sources(dir) {
  const found = []
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name)
    if (item.isDirectory()) found.push(...(await sources(path)))
    else if (/\.(ts|tsx)$/.test(item.name)) found.push(path)
  }
  return found
}

/** 去掉注释(块注释 / JSX 注释 / 行注释),免得把说明文字当成界面文案。 */
function stripComments(source) {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

test('用户可见的 DOM 文案不能写死中文(要走 strings / t)', async () => {
  const files = await sources('src/client')
  const offenders = []
  for (const file of files) {
    const source = stripComments(await readFile(file, 'utf8'))
    // 命令式组件:`.textContent = '中文'`、`.title = '中文'`
    for (const match of source.matchAll(/\.(?:textContent|title|placeholder)\s*=\s*'([^']*)'/g)) {
      if (CJK.test(match[1])) offenders.push(`${file}: ${match[0]}`)
    }
    // JSX:文字直接写在标签属性里
    for (const match of source.matchAll(/(?:placeholder|title|aria-label)="([^"]*)"/g)) {
      if (CJK.test(match[1])) offenders.push(`${file}: ${match[0]}`)
    }
    // JSX 文本节点(整行就是一个中文句子)也必须走 t():只查 .tsx,且跳过 import/类型行
    if (!file.endsWith('.tsx')) continue
    for (const line of source.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('import ') || trimmed.startsWith('export ')) continue
      if (!/^[\u4e00-\u9fff][^<>{}=,;:()[\]]*$/.test(trimmed)) continue
      offenders.push(`${file}: ${trimmed}`)
    }
  }
  assert.deepEqual(offenders, [], '这些地方的用户可见文案写死了中文')
})
