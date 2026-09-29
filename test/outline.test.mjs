import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cleanHeadingText, parseOutline } from '../lib/outline.js'

test('parseOutline: 层级、文本、行号;行内标记被清理', () => {
  const text = [
    '---',
    'dsh-note-id: n_1',
    '---',
    '',
    '# 顶层标题',
    '',
    '正文 **不是** 标题',
    '',
    '## 二级 `代码` 与 [链接](http://x)',
    '',
    '### 三级 ==高亮==',
    '',
    '###### 六级',
    '',
    '# 结尾 #',
  ].join('\n')

  assert.deepEqual(parseOutline(text), [
    { level: 1, text: '顶层标题', line: 5 },
    { level: 2, text: '二级 代码 与 链接', line: 9 },
    { level: 3, text: '三级 高亮', line: 11 },
    { level: 6, text: '六级', line: 13 },
    { level: 1, text: '结尾', line: 15 },
  ])
})

test('parseOutline: 代码围栏里的 # 不算标题;`#无空格` 也不算', () => {
  const text = ['```md', '# 围栏里的假标题', '```', '', '#无空格不是标题', '', '# 真标题'].join('\n')
  assert.deepEqual(parseOutline(text), [{ level: 1, text: '真标题', line: 7 }])

  const tilde = ['~~~', '# 也不算', '~~~', '# 算'].join('\n')
  assert.deepEqual(parseOutline(tilde), [{ level: 1, text: '算', line: 4 }])
})

test('parseOutline: 空文档 / 无标题 / 空标题文本', () => {
  assert.deepEqual(parseOutline(''), [])
  assert.deepEqual(parseOutline('正文\n\n更多正文'), [])
  assert.deepEqual(parseOutline('#\n'), [])
  assert.deepEqual(parseOutline('###   \n'), [])
})

test('cleanHeadingText: 常见行内标记', () => {
  assert.equal(cleanHeadingText('**粗** 与 *斜* 与 ~~删~~'), '粗 与 斜 与 删')
  assert.equal(cleanHeadingText('![图](a.png) 与 [链](b)'), '图 与 链')
  assert.equal(cleanHeadingText('`码` 与 ==亮=='), '码 与 亮')
})
