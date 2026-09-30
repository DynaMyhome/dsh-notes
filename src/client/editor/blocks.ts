/**
 * 块级插入的**规划**(纯函数):算出该往哪插、插什么、光标落在哪。
 *
 * 为什么单独成模块:块级构造(markdown 里 `---`、代码围栏、`$$…$$`、表格)必须
 * **独占整段** —— 前后各留一个空行。踩过的坑:在表格最后一行后面直接插 `---`,
 * 解析器会把 `| … |` + `---` 当成 **SetextHeading2 的下划线**,整张表直接消失
 * (用户实测:"工具栏的分隔线按钮一按,上面那张表就没了")。
 *
 * 纯函数 → 可以被 `node --experimental-strip-types` 直接测(见 test/blocks.test.mjs)。
 */

/** 只需要文档的行访问能力(CodeMirror 的 `Text` 满足,测试里可以手搓)。 */
export interface DocLines {
  lines: number
  line(number: number): { number: number; from: number; to: number; text: string }
  lineAt(position: number): { number: number; from: number; to: number; text: string }
}

/** 一次插入的完整描述。 */
export interface BlockInsert {
  from: number
  to: number
  insert: string
  caret: number
}

/**
 * 规划一次块级插入。
 * @param doc - 文档(只需行访问)。
 * @param range - 当前选区。
 * @param block - 要插入的块(自带结尾换行,如 `'---\n'`)。
 * @param caretFromStart - 光标在块内的偏移(相对 block 起点)。
 * @returns 插入参数(交给 `view.dispatch`)。
 */
export function planBlockInsert(
  doc: DocLines,
  range: { from: number; to: number },
  block: string,
  caretFromStart: number,
): BlockInsert {
  // 统一成"块自带结尾换行":有的调用方(表格)不带 —— 行中间插入时后面的字会被粘到
  // 最后一行上(表格最后一行会多出一个单元格)。
  const text = block.endsWith('\n') ? block : `${block}\n`
  const line = doc.lineAt(range.from)
  const beforeOnLine = line.text.slice(0, range.from - line.from)
  const afterOnLine = line.text.slice(range.to - line.from)
  const prev = line.number > 1 ? doc.line(line.number - 1).text : ''
  const next = line.number < doc.lines ? doc.line(line.number + 1).text : ''
  // 前置:光标前面还有字 → 先把那一行收尾、再补一个空行(两个换行);否则上一行有内容
  // 时补一个换行,让块前面成为空行。
  const lead = beforeOnLine.trim() !== '' ? '\n\n' : prev.trim() !== '' ? '\n' : ''
  // 后置(`block` 自带结尾换行,所以这里最多再加一个):
  //   - 光标后面还有字:块的换行已经把它顶到下一行,不用再加;
  //   - 光标所在的空行:它自己的换行就是块后面的空行;
  //   - 否则下一行有内容时补一个换行,隔出一个空行。
  const caretLineEmpty = line.text.trim() === ''
  const tail = afterOnLine.trim() !== '' || (caretLineEmpty && next.trim() !== '') ? '' : next.trim() !== '' ? '\n' : ''
  return {
    from: range.from,
    to: range.to,
    insert: lead + text + tail,
    caret: range.from + lead.length + caretFromStart,
  }
}
