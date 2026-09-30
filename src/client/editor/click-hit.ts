/**
 * 点击落点:**把鼠标坐标换成文档位置**(纯函数,单测 `test/click-hit.test.mjs`)。
 *
 * 为什么不能直接用 `EditorView.posAtCoords`:它按 CM6 自己的行盒模型换算,而我们的装饰
 * (`[[ ]]`、标题折叠、元数据 chip、表格块、代码卡)会改变真实行高 → 出现约 0.7 行的
 * 系统偏差(用户实测:鼠标在 `端到端` 这一行,光标落到相邻行)。所以笔记区自己算:
 * 先用**真实 DOM 行**定行,再在这一行里定位。
 *
 * **软换行是这里最容易踩的坑**(用户实测:从别处粘进来的长段落,"不管鼠标怎么点,
 * 光标一直在行的前面")。一"行"(`\n` 之间)在屏幕上可能折成好几个**视觉行**,
 * 而这些视觉行的 x 是各自从左边重新开始的 —— 只要二分里用"不在同一视觉行"
 * 当"点在更前面"的判据,搜索就会一路塌回行首。所以这里先**按视觉行夹出位置区间**,
 * 再在区间内按 x 二分:同一视觉行内 `left` 才是单调的。
 *
 * 本模块不碰 DOM、不碰 CM6,只做区间与二分;取 DOM/坐标的活在 `editor/setup.ts` 里。
 */

/** 一条视觉行的垂直范围(视口坐标)。 */
export interface VerticalBand {
  top: number
  bottom: number
}

/** 某个文档位置在屏幕上的横向/纵向坐标;拿不到(未被渲染)时为 null。 */
export type CoordAt = (pos: number) => number | null

/** 纵向容差:同一视觉行内不同 fragment 的 top 会差 1–2px。 */
const TOLERANCE = 2

/**
 * 把 DOM 里拿到的若干矩形按 top 归并成"视觉行"。
 *
 * `Range.getClientRects()` 对一段折行文本会返回**很多**矩形(每个 fragment 一个),
 * 但它们只落在少数几个 top 上 —— 按 top 分组就是视觉行。
 * @param rects - 视口坐标的矩形(top/bottom 就够)。
 * @param tolerance - 同一行的 top 容差。
 * @returns 按 top 升序的视觉行。
 */
export function bandsFromRects(rects: readonly { top: number; bottom: number }[], tolerance = TOLERANCE): VerticalBand[] {
  const bands: VerticalBand[] = []
  for (const rect of rects) {
    if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom) || rect.bottom < rect.top) continue
    const last = bands[bands.length - 1]
    if (last !== undefined && Math.abs(rect.top - last.top) <= tolerance) {
      last.top = Math.min(last.top, rect.top)
      last.bottom = Math.max(last.bottom, rect.bottom)
      continue
    }
    bands.push({ top: rect.top, bottom: rect.bottom })
  }
  return bands.sort((left, right) => left.top - right.top)
}

/**
 * 点(y)落在第几条视觉行。
 * @param bands - {@link bandsFromRects} 的结果。
 * @param y - 鼠标 y(视口坐标)。
 * @returns 视觉行下标;没有行时 null。落在行间/上下越界时取垂直距离最近的一条(夹取)。
 */
export function bandIndexFor(bands: readonly VerticalBand[], y: number): number | null {
  if (bands.length === 0) return null
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index]
    if (y >= band.top - TOLERANCE && y <= band.bottom + TOLERANCE) return index
    const distance = y < band.top ? band.top - y : y > band.bottom ? y - band.bottom : 0
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  }
  return best
}

/**
 * 求某条视觉行在文档里的位置区间 `[first, last]`。
 *
 * 依据:`coordsAtPos(pos).top` 沿文档序单调不减 → 二分两次即可夹出这一行
 * (上一行的 top 明显更小、下一行的明显更大)。
 * @param band - 目标视觉行。
 * @param from - 行首文档位置。
 * @param to - 行尾文档位置。
 * @param topAt - 位置 → 视口 top。
 * @returns 该视觉行的位置区间;探针拿不到坐标(位置未被渲染)时 null。
 */
export function rowPositionRange(
  band: VerticalBand,
  from: number,
  to: number,
  topAt: CoordAt,
): { first: number; last: number } | null {
  // first = 最小的 pos 满足 top >= band.top - 容差(即这一行的第一个位置)
  let low = from
  let high = to
  let first: number | null = null
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const top = topAt(mid)
    if (top === null) return null
    if (top >= band.top - TOLERANCE) {
      first = mid
      high = mid - 1
    } else {
      low = mid + 1
    }
  }
  if (first === null) return null
  // last = 最大的 pos 满足 top <= band.bottom + 容差(即这一行的最后一个位置)
  low = first
  high = to
  let last: number | null = null
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const top = topAt(mid)
    if (top === null) return null
    if (top <= band.bottom + TOLERANCE) {
      last = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  if (last === null || last < first) return null
  return { first, last }
}

/**
 * 在一条视觉行内按 x 二分出"鼠标落在第几个字符之前"。
 *
 * **只在同一视觉行内调用** —— 跨视觉行的 left 不单调,那是上面这层要挡掉的。
 * @param first - 视觉行首位置。
 * @param last - 视觉行尾位置。
 * @param x - 鼠标 x(视口坐标)。
 * @param leftAt - 位置 → 视口 left。
 * @returns 文档位置(一定落在 `[first, last]` 内)。
 */
export function columnInRow(first: number, last: number, x: number, leftAt: CoordAt): number {
  let low = first
  let high = last
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    const left = leftAt(mid)
    // 拿不到坐标就不再往下猜:停在当前(仍在区间内的)位置
    if (left === null) return low
    if (left <= x) low = mid
    else high = mid - 1
  }
  return low
}

/**
 * 完整落点:视觉行 → 该行位置区间 → 行内列位。
 * @param input - 行的文档区间、视觉行、鼠标坐标与两个坐标探针。
 * @returns 文档位置;任何一步拿不到依据就返回 null(调用方应当**不纠正**)。
 */
export function hitInLine(input: {
  from: number
  to: number
  bands: readonly VerticalBand[]
  y: number
  x: number
  topAt: CoordAt
  leftAt: CoordAt
}): number | null {
  const index = bandIndexFor(input.bands, input.y)
  if (index === null) return null
  const range = rowPositionRange(input.bands[index], input.from, input.to, input.topAt)
  if (range === null) return null
  return columnInRow(range.first, range.last, input.x, input.leftAt)
}
