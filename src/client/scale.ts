/**
 * 笔记区域的「字号 / 图标大小」偏好(纯模型,无 React)。
 *
 * 两层叠加(见 dsh-notes/AGENTS.md「字号与缩放」):
 *   1. **跟随全局**:宿主的「字体大小」(设置 → 通用,ui-theme 拥有)把
 *      `--dsh-content-font-delta` 写在 `body` 上 —— 笔记区根字号直接加上这个增量,
 *      所以聊天区调大多少,笔记区就大多少,不需要用户再调一次。
 *   2. **本区微调**:`--dsh-notes-scale`(0.85–1.5)只作用于笔记区,
 *      因为侧栏本身比正文密,有人希望它更紧凑或更松。
 *
 * 存 `localStorage` 而不是 Host Config:这是**显示器级**的观感偏好
 * (笔记本屏 vs 4K 屏各要一个值),按浏览器存才对;也因此不动 Host 半、
 * 不需要重启 web。
 *
 * 所有对外函数都是纯的或只碰传入的 storage,便于单测(见 test/scale.test.mjs)。
 */

/** localStorage 键(与 `dsh-notes:ws:` / `dsh-notes:tabs:` 同族)。 */
export const SCALE_KEY = 'dsh-notes:ui-scale'

/** 微调系数下限(再小就该去调全局字号了)。 */
export const SCALE_MIN = 0.85
/** 微调系数上限。 */
export const SCALE_MAX = 1.5

/** 浮层里的五档预设(紧凑 → 超大),默认档是 1。 */
export const SCALE_PRESETS = [0.9, 1, 1.15, 1.3, 1.5] as const

/** 默认系数 = 设计原样(与改动前逐像素一致)。 */
export const SCALE_DEFAULT = 1

/** 只读的 storage 面(测试里传假对象即可)。 */
export interface ScaleStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 拿默认 storage;非浏览器环境(SSR / 单测)返回 null。 */
function defaultStorage(): ScaleStorage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    // 隐私模式等:访问 localStorage 本身就会抛
    return null
  }
}

/**
 * 把任意输入夹到 [SCALE_MIN, SCALE_MAX]。
 *
 * 坏值(非数字、NaN、空串、字符串数字)一律回落到默认档,而不是抛错 ——
 * 偏好是用户可写的数据,读坏一个值不能让整个面板崩。
 * @param value - 磁盘/输入框来的原始值。
 * @returns 合法系数。
 */
export function clampScale(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(parsed) || parsed <= 0) return SCALE_DEFAULT
  if (parsed < SCALE_MIN) return SCALE_MIN
  if (parsed > SCALE_MAX) return SCALE_MAX
  return Math.round(parsed * 100) / 100
}

/**
 * 读偏好。
 * @param storage - 可注入的 storage(省略 = `window.localStorage`)。
 * @returns 合法系数;没有/读不到/坏了都是默认档。
 */
export function readScale(storage: ScaleStorage | null | undefined = defaultStorage()): number {
  if (storage === null || storage === undefined) return SCALE_DEFAULT
  try {
    const raw = storage.getItem(SCALE_KEY)
    if (raw === null) return SCALE_DEFAULT
    return clampScale(raw)
  } catch {
    return SCALE_DEFAULT
  }
}

/**
 * 写偏好(失败静默:隐私模式/配额满都不该阻断调字号)。
 * @param value - 目标系数(会先夹取)。
 * @param storage - 可注入的 storage(省略 = `window.localStorage`)。
 * @returns 实际写入的系数。
 */
export function writeScale(value: unknown, storage: ScaleStorage | null | undefined = defaultStorage()): number {
  const scale = clampScale(value)
  if (storage === null || storage === undefined) return scale
  try {
    storage.setItem(SCALE_KEY, String(scale))
  } catch {
    /* 存不了就算了:本次会话仍然生效 */
  }
  return scale
}

/**
 * 系数 → 根节点上的 CSS 自定义属性。
 *
 * 只给一个变量:`--dsh-notes-scale`。字号、行高、图标、编辑器正文字号
 * 全部由它派生(见 styles.ts 与 editor/setup.ts),避免"改了 CSS 忘了改图标"。
 * @param value - 目标系数(会先夹取)。
 * @returns 可直接展开到 `style` 的属性表。
 */
export function scaleVars(value: unknown): Record<string, string> {
  return { '--dsh-notes-scale': String(clampScale(value)) }
}

/**
 * 缩放后的长度:设计值(px)→ 实际 CSS 值。
 *
 * = `calc(设计值 × 本区系数 + 宿主的全局字号增量)`。**样式表的唯一入口**
 * (`styles.ts` 以 `sc` 的名字 import 它),行内样式也用同一个,免得公式写两遍。
 *
 * 为什么是绝对 calc 而不是 `em`:`em` 会逐层相乘(父级设了字号、子级再设一次就叠),
 * 而这里每个尺寸都要彼此独立,并且在「系数 1 + 增量 0」时与改动前逐像素一致。
 * @param px - 系数 1、全局增量 0 时的设计尺寸。
 * @returns 可直接放进 CSS 值位置的表达式。
 */
export function cssSize(px: number): string {
  return `calc(${px}px * var(--dsh-notes-scale, 1) + var(--dsh-content-font-delta, 0px))`
}
