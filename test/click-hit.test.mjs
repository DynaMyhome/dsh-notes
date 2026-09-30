import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 点击落点(软换行)的纯逻辑。
 *
 * 合成一条**折成 4 个视觉行**的文档行(每行 30 字符),用假的坐标探针验:
 *   1. 视觉行归并(`bandsFromRects`);
 *   2. 点在哪一条视觉行;
 *   3. 该视觉行的位置区间;
 *   4. 行内列位;
 *   5. **反向锁**:把改动前的那套二分照抄进来(`legacyHit`),它在第 2/3/4 个
 *      视觉行上都会塌回**行首** —— 这正是用户报的"不管鼠标怎么点,光标一直在行的前面"。
 *
 * 模型是 `.ts`,要靠 Node 的类型剥离才 import 得进来;没有该能力就跳过。
 */
let click = null
try {
  click = await import('../src/client/editor/click-hit.ts')
} catch {
  click = null
}

const maybe = click === null ? test.skip : test

/** 合成的一条"折行":from=100,4 个视觉行 × 30 字符。 */
const FROM = 100
const ROW_CHARS = 30
const ROWS = 4
const TO = FROM + ROW_CHARS * ROWS - 1
const ROW_TOP = 293
const ROW_STEP = 20
const ROW_HEIGHT = 15
const LEFT = 991
const CHAR_WIDTH = 11

const rowOf = (pos) => Math.floor((pos - FROM) / ROW_CHARS)
const topAt = (pos) => (pos < FROM || pos > TO ? null : ROW_TOP + rowOf(pos) * ROW_STEP)
const bottomAt = (pos) => (topAt(pos) === null ? null : topAt(pos) + ROW_HEIGHT)
const leftAt = (pos) => (pos < FROM || pos > TO ? null : LEFT + ((pos - FROM) % ROW_CHARS) * CHAR_WIDTH)

/** `Range.getClientRects()` 的真实样子:同一行会返回一堆 fragment 矩形。 */
function fragmentRects() {
  const rects = []
  for (let row = 0; row < ROWS; row += 1) {
    const top = ROW_TOP + row * ROW_STEP
    for (let fragment = 0; fragment < 5; fragment += 1) {
      rects.push({ top: top + (fragment % 2 === 0 ? 0 : 2), bottom: top + ROW_HEIGHT - (fragment % 2) })
      rects.push({ top: top + 2, bottom: top + ROW_HEIGHT - 2 })
    }
  }
  return rects
}

const bands = () => click.bandsFromRects(fragmentRects())

/** 改动前的二分(`setup.ts` 的 hitTestPosition):"不在同一视觉行"当成"点在更前面"。 */
function legacyHit(x, y) {
  let low = FROM
  let high = TO
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    const sameRow = y >= topAt(mid) - 2 && y <= bottomAt(mid) + 2
    if (!sameRow) {
      high = mid - 1
      continue
    }
    if (leftAt(mid) <= x) low = mid
    else high = mid - 1
  }
  return low
}

maybe('bandsFromRects:把一堆 fragment 矩形归并成 4 条视觉行', () => {
  const result = bands()
  assert.equal(result.length, ROWS, '应归并成 4 条视觉行')
  assert.deepEqual(
    result.map((band) => band.top),
    [293, 313, 333, 353],
  )
  for (let index = 1; index < result.length; index += 1) {
    assert.equal(result[index].top > result[index - 1].top, true, '视觉行按 top 升序')
  }
})

maybe('bandIndexFor:点在哪一条视觉行(含上下越界夹取)', () => {
  const list = bands()
  assert.equal(click.bandIndexFor(list, 300), 0)
  assert.equal(click.bandIndexFor(list, 320), 1)
  assert.equal(click.bandIndexFor(list, 341), 2)
  assert.equal(click.bandIndexFor(list, 361), 3)
  assert.equal(click.bandIndexFor(list, 100), 0, '点在最上面 → 第一行')
  assert.equal(click.bandIndexFor(list, 900), 3, '点在最下面 → 最后一行')
  assert.equal(click.bandIndexFor([], 10), null, '没有视觉行 → null')
})

maybe('rowPositionRange:夹出这一视觉行的位置区间', () => {
  const list = bands()
  const ranges = list.map((band) => click.rowPositionRange(band, FROM, TO, topAt))
  assert.deepEqual(ranges[0], { first: FROM, last: FROM + 29 })
  assert.deepEqual(ranges[1], { first: FROM + 30, last: FROM + 59 })
  assert.deepEqual(ranges[2], { first: FROM + 60, last: FROM + 89 })
  assert.deepEqual(ranges[3], { first: FROM + 90, last: FROM + 119 })
  // 探针拿不到坐标 → 不猜
  assert.equal(click.rowPositionRange(list[1], FROM, TO, () => null), null)
})

maybe('columnInRow:同一视觉行内按 x 二分(不会跑到别的行)', () => {
  const row = click.rowPositionRange(bands()[2], FROM, TO, topAt)
  assert.deepEqual(row, { first: FROM + 60, last: FROM + 89 })
  assert.equal(click.columnInRow(row.first, row.last, LEFT - 5, leftAt), row.first, '点在行首左侧 → 行首')
  assert.equal(click.columnInRow(row.first, row.last, LEFT + CHAR_WIDTH * 4, leftAt), row.first + 4)
  assert.equal(click.columnInRow(row.first, row.last, LEFT + CHAR_WIDTH * 29 + 300, leftAt), row.last, '点在行尾右侧 → 行尾')
})

maybe('hitInLine:4 个视觉行都落在"点的那一行、那一列"(用户报的 bug)', () => {
  const list = bands()
  // 每一条视觉行都点它自己的第 6 个字符
  for (let row = 0; row < ROWS; row += 1) {
    const x = LEFT + CHAR_WIDTH * 6
    const y = ROW_TOP + row * ROW_STEP + Math.floor(ROW_HEIGHT / 2)
    const hit = click.hitInLine({ from: FROM, to: TO, bands: list, x, y, topAt, leftAt })
    assert.equal(hit, FROM + row * ROW_CHARS + 6, `第 ${row + 1} 个视觉行应落在该行第 6 个字符`)
  }
  // 点最后一行的最后一个字符
  const lastY = ROW_TOP + 3 * ROW_STEP + 5
  assert.equal(
    click.hitInLine({ from: FROM, to: TO, bands: list, x: LEFT + CHAR_WIDTH * 40, y: lastY, topAt, leftAt }),
    TO,
    '行尾之后 → 行尾',
  )
})

maybe('反向锁:改动前的二分"塌回行首"(用户报的 bug 本体)', () => {
  const x = LEFT + CHAR_WIDTH * 6
  const list = bands()
  let broken = 0
  for (let row = 0; row < ROWS; row += 1) {
    const y = ROW_TOP + row * ROW_STEP + Math.floor(ROW_HEIGHT / 2)
    const correct = FROM + row * ROW_CHARS + 6
    const legacy = legacyHit(x, y)
    const fixed = click.hitInLine({ from: FROM, to: TO, bands: list, x, y, topAt, leftAt })
    assert.equal(fixed, correct, `新实现:第 ${row + 1} 个视觉行 → 该行第 6 个字符`)
    if (legacy === FROM && correct !== FROM) {
      broken += 1
      assert.equal(legacy, FROM, `旧实现:第 ${row + 1} 个视觉行塌回行首`)
    }
  }
  // 旧实现第一次取的 mid 落在第 3 个视觉行上:点在中点**之后**的行时,
  // 搜索向左走进更靠前的视觉行后就再也回不来 → 一路塌到行首;
  // 点在中点之前的行则侥幸正确。这就是"有时对、有时不管怎么点光标都在行的前面"的来源,
  // 也是它一直没被发现的原因 —— 这里锁住"至少有一行是坏的"。
  assert.equal(broken >= 1, true, '旧实现必须存在塌回行首的视觉行(这条锁证明 bug 真的在)')
})

maybe('单视觉行(不折行)与空行也照常', () => {
  const single = { top: 500, bottom: 515 }
  const hit = click.hitInLine({ from: 0, to: 9, bands: [single], x: 100, y: 507, topAt: () => 500, leftAt: (pos) => 50 + pos * 11 })
  assert.equal(hit, 4, '50+4*11=94 <= 100 → 第 4 个字符前')
  // 空行:调用方直接返回 line.from(这里验"区间退化"也不崩)
  const empty = click.hitInLine({ from: 7, to: 7, bands: [single], x: 100, y: 507, topAt: () => 500, leftAt: () => 50 })
  assert.equal(empty, 7)
})
