/**
 * 图片尺寸缓存(纯模型 + 可注入 storage,照 `scale.ts` 的写法)。
 *
 * ## 为什么需要它(2026-10-09 用户实测:滚动时"内容突然往下挪一截")
 *
 * 图片是**行内 widget**,而 `<img>` 只有位图到位后才有高度 —— 于是:
 *   1. 向上滚动时视口上方的图片 widget 被重建,`h=0`;
 *   2. CM6 把那行重新量成 ~24px(高度图缩水,内容先跳一下);
 *   3. 位图到位后涨到 `max-height:320px` 以内(内容**再**往下跳一截)。
 *
 * 实测(插件同一套 CSS,src 指向永不返回的地址 = 位图未到):
 * 不写字面尺寸 → `w=115.3 h=0`;写 `width=800 height=1600` → `w=460 h=320`
 * (被 `max-width:100%` / `max-height:320px` 正确夹取,`object-fit:contain` 内缩)。
 *
 * 所以只要**记住每张图曾经量到的固有尺寸**,下次创建 widget 时把 `width`/`height`
 * 写到 `<img>` 上,盒子在位图到达之前就是最终大小 —— 高度图不再抖。
 *
 * ## 存哪
 *
 * 会话内用内存 Map;同时持久化到 `localStorage`(设备本地观感数据,与
 * `dsh-notes:tabs:<key>` 里存 `tab.path` 同类),这样刷新页面后第一次滚动也不跳。
 * 键就是 `<img src>`(`api/file?path=…`)。写不进(隐私模式)/被写坏一律静默回落。
 */

/** localStorage 键(与 `dsh-notes:ui-scale` / `dsh-notes:tabs:` 同族)。 */
export const SIZE_KEY = 'dsh-notes:img-size'

/** 最多记多少张(超出从最旧裁)。一篇笔记几十张图,400 足够跨若干篇。 */
export const MAX_ENTRIES = 400

/** 只读的 storage 面(测试里传假对象即可)。 */
export interface SizeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 一张图的固有尺寸(像素,已取整)。 */
export interface ImageSize {
  w: number
  h: number
}

/** 尺寸面:widget 只碰这两个方法。 */
export interface ImageSizeStore {
  /** 命中缓存返回尺寸,否则 `null`(调用方按"还不知道"处理)。 */
  sizeOf(url: string): ImageSize | null
  /** 记一张图的固有尺寸(非法值直接忽略)。 */
  remember(url: string, width: unknown, height: unknown): void
}

/** 拿默认 storage;非浏览器环境(SSR / 单测)返回 null。 */
function defaultStorage(): SizeStorage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    // 隐私模式等:访问 localStorage 本身就会抛
    return null
  }
}

/** 单边尺寸上限:再大也不可能是笔记里的图(挡住坏数据把盒子撑爆)。 */
const MAX_SIDE = 20000

/** 把一个输入规范化成合法边长;不合法返回 null。 */
function toSide(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(parsed)) return null
  const rounded = Math.round(parsed)
  if (rounded <= 0 || rounded > MAX_SIDE) return null
  return rounded
}

/**
 * 建一个尺寸缓存。
 * @param storage - 可注入的 storage(省略 = `window.localStorage`;null = 纯内存)。
 */
export function createImageSizeStore(storage: SizeStorage | null | undefined = defaultStorage()): ImageSizeStore {
  /** 只在第一次用到时才读盘(import 本模块不该碰 storage)。 */
  let map: Map<string, ImageSize> | null = null
  /** 读盘只做一次:读坏了也不重试(免得每次 load 都 JSON.parse 一坨垃圾)。 */
  let loaded = false

  const load = (): Map<string, ImageSize> => {
    if (map !== null) return map
    map = new Map()
    if (loaded) return map
    loaded = true
    if (storage === null || storage === undefined) return map
    try {
      const raw = storage.getItem(SIZE_KEY)
      if (raw === null) return map
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object') return map
      for (const [url, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof url !== 'string' || url === '') continue
        // 落盘的是 `{ w, h }`;数组形状也认(容忍手改/旧数据)
        let w: number | null = null
        let h: number | null = null
        if (Array.isArray(value)) {
          w = toSide(value[0])
          h = toSide(value[1])
        } else if (value !== null && typeof value === 'object') {
          const record = value as Record<string, unknown>
          w = toSide(record.w)
          h = toSide(record.h)
        }
        if (w === null || h === null) continue
        map.set(url, { w, h })
      }
    } catch {
      // 坏 JSON / storage 抛错:当作空
    }
    return map
  }

  const persist = (current: Map<string, ImageSize>): void => {
    if (storage === null || storage === undefined) return
    try {
      // 超出上限从最旧裁(Map 保持插入顺序)
      while (current.size > MAX_ENTRIES) {
        const oldest = current.keys().next()
        if (oldest.done === true) break
        current.delete(oldest.value)
      }
      storage.setItem(SIZE_KEY, JSON.stringify(Object.fromEntries(current)))
    } catch {
      /* 存不了就算了:内存里的那份照样管用 */
    }
  }

  return {
    sizeOf(url: string): ImageSize | null {
      if (typeof url !== 'string' || url === '') return null
      return load().get(url) ?? null
    },
    remember(url: string, width: unknown, height: unknown): void {
      if (typeof url !== 'string' || url === '') return
      const w = toSide(width)
      const h = toSide(height)
      if (w === null || h === null) return
      const current = load()
      const previous = current.get(url)
      if (previous !== undefined && previous.w === w && previous.h === h) return
      // 重新 set 让它排到最新(裁的时候先丢最旧的)
      current.delete(url)
      current.set(url, { w, h })
      persist(current)
    },
  }
}

/** 编辑器里用的那一个(浏览器 localStorage;拿不到就是纯内存)。 */
export const imageSizes: ImageSizeStore = createImageSizeStore()
