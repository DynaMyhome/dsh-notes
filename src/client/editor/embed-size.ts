/**
 * 网页演示的**高度记忆**(纯模型 + 可注入 storage,照 `image-size.ts` 的写法)。
 *
 * 为什么需要:演示是**一块用户调过的视口**。不记住的话,每次重开笔记、每次 widget
 * 重建(切标签 / 滚动出视口)都回到默认高度,用户刚拖好的尺寸白拖 —— 而且这个
 * "观感偏好"不该写进用户的 markdown(否则一篇笔记里全是 `height:` 噪音)。
 *
 * 键 = 演示文件的**绝对路径**(同一份演示在几篇笔记里共用同一个高度),
 * 值 = 容器高度(px)。写不进(隐私模式)/被写坏一律静默回落默认值。
 */

// 同上:带 `.ts` 扩展名,保证 `node --test` 能直接跑这个纯模型。
import { DEFAULT_EMBED_HEIGHT, clampEmbedHeight } from './embed-model.ts'

/** localStorage 键(与 `dsh-notes:ui-scale` / `dsh-notes:img-size` 同族)。 */
export const EMBED_SIZE_KEY = 'dsh-notes:embed-size'

/** 最多记多少个演示(超出从最旧裁)。 */
export const EMBED_SIZE_MAX_ENTRIES = 200

/** 只读的 storage 面(测试里传假对象即可)。 */
export interface EmbedSizeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 高度面:widget 只碰这两个方法。 */
export interface EmbedHeightStore {
  /** 命中缓存返回高度,否则 `null`(调用方按"用默认值"处理)。 */
  heightOf(path: string): number | null
  /** 记一个高度(非法值按默认值落盘;省略 = 删除该条)。 */
  remember(path: string, height: unknown): void
}

/** 拿默认 storage;非浏览器环境(SSR / 单测)返回 null。 */
function defaultStorage(): EmbedSizeStorage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    // 隐私模式等:访问 localStorage 本身就会抛
    return null
  }
}

/**
 * 建一个高度缓存。
 * @param storage - 可注入的 storage(省略 = `window.localStorage`;null = 纯内存)。
 */
export function createEmbedHeightStore(
  storage: EmbedSizeStorage | null | undefined = defaultStorage(),
): EmbedHeightStore {
  /** 只在第一次用到时才读盘(import 本模块不该碰 storage)。 */
  let map: Map<string, number> | null = null
  /** 读盘只做一次:读坏了也不重试。 */
  let loaded = false

  const load = (): Map<string, number> => {
    if (map !== null) return map
    map = new Map()
    if (loaded) return map
    loaded = true
    if (storage === null || storage === undefined) return map
    try {
      const raw = storage.getItem(EMBED_SIZE_KEY)
      if (raw === null) return map
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object') return map
      for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof path !== 'string' || path === '') continue
        const height = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
        if (!Number.isFinite(height) || height <= 0) continue
        map.set(path, clampEmbedHeight(height))
      }
    } catch {
      // 坏 JSON / storage 抛错:当作空
    }
    return map
  }

  const persist = (current: Map<string, number>): void => {
    if (storage === null || storage === undefined) return
    try {
      // 超出上限从最旧裁(Map 保持插入顺序)
      while (current.size > EMBED_SIZE_MAX_ENTRIES) {
        const oldest = current.keys().next()
        if (oldest.done === true) break
        current.delete(oldest.value)
      }
      storage.setItem(EMBED_SIZE_KEY, JSON.stringify(Object.fromEntries(current)))
    } catch {
      /* 存不了就算了:内存里的那份照样管用 */
    }
  }

  return {
    heightOf(path: string): number | null {
      if (typeof path !== 'string' || path === '') return null
      return load().get(path) ?? null
    },
    remember(path: string, height: unknown): void {
      if (typeof path !== 'string' || path === '') return
      const current = load()
      if (height === null || height === undefined) {
        if (!current.delete(path)) return
        persist(current)
        return
      }
      const next = clampEmbedHeight(height)
      if (current.get(path) === next) return
      // 重新 set 让它排到最新(裁的时候先丢最旧的)
      current.delete(path)
      current.set(path, next)
      persist(current)
    },
  }
}

/** 编辑器里用的那一个(浏览器 localStorage;拿不到就是纯内存)。 */
export const embedHeights: EmbedHeightStore = createEmbedHeightStore()

/** 默认高度(转发,免得 widget 同时 import 两个模块只为拿它)。 */
export { DEFAULT_EMBED_HEIGHT }
