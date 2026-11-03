/**
 * 网页演示(`embed` 围栏)的**纯逻辑**:解析、路径解析、URL 拼装、高度夹取。
 *
 * 这里不碰 DOM / CM6 / fetch,**全部能在 `node --test` 里直接跑**。
 * 运行时把这些结果翻译成 iframe;所有"该不该显示、显示哪个文件"的判断只在这里,
 * 避免又出现"测试里验过的行为"和"编辑器里的行为"两套规则。
 *
 * ## 语法
 *
 * ````md
 * ```embed ../.dsh-assets/<noteId>/demo.html
 * title: 三电平 SAR 的 ΔV 与全部码区间
 * height: 560
 * ```
 * ````
 *
 * - 路径写在 info 串;也可以只写 `embed`,把路径放在正文第一行(两种写法都认);
 * - 正文里可选的配置行只有 `path` / `src` / `title` / `height`;未知的 `key:` 视为坏配置;
 * - 只接受本地文件(相对笔记目录解析),`http(s)` / `data:` 一律拒绝;
 * - 只接受 `.html` / `.htm`(决定服务端那个只读路由能不能出文件)。
 */

// 带 `.ts` 扩展名:本模块要能被 `node --test`(类型剥离模式)直接 import,
// Node 的 ESM 解析不做"无扩展名猜后缀"(esbuild 两种写法都认)。
import { resolveLocalPath } from './media.ts'

/** 默认展示高度(px)。演示页是"一块可见的视口",不是整页。 */
export const DEFAULT_EMBED_HEIGHT = 560
/** 高度下限(再矮连标题条都放不下)。 */
export const EMBED_MIN_HEIGHT = 160
/** 高度上限(再高会把笔记顶成"一屏一个演示")。 */
export const EMBED_MAX_HEIGHT = 2400

/** 解析失败的原因(由 widget 映射成字典文案)。 */
export type EmbedProblem = 'not-embed' | 'no-path' | 'not-html' | 'remote' | 'bad-config' | 'no-document'

/** 围栏里解析出的演示描述(路径还是**原始**写法,尚未相对笔记解析)。 */
export interface EmbedFence {
  path: string
  title: string | null
  height: number | null
}

/** {@link parseEmbedFence} 的结果。 */
export type EmbedParse = ({ ok: true } & EmbedFence) | { ok: false; problem: EmbedProblem }

/** {@link planEmbed} 的结果(已解析成绝对路径,可直接拿去拼 URL)。 */
export type EmbedPlan =
  | { ok: true; absolutePath: string; title: string; height: number | null }
  | { ok: false; problem: EmbedProblem }

/** 认出 iframe 的那套依据(表层的两条边界)。 */
export interface EmbedContext {
  /** 会话 id:Host 侧靠它把请求映射到执行世界与工作区。 */
  sessionId: string
  /** 笔记面板当前看的工作区(可能不是会话 cwd;`null` = 会话自己的工作区)。 */
  workspaceKey: string | null
  /** 当前笔记的绝对路径(相对路径以它所在目录为基准)。 */
  documentPath: string | null
}

/** 围栏首行:栅栏符 + 语言 + info 串。 */
interface FenceParts {
  fence: string
  language: string
  info: string
  body: string[]
}

/** 切开围栏(不判断语言)。 */
function fenceParts(source: string): FenceParts | null {
  const lines = String(source ?? '').split(/\r?\n/)
  const header = /^\s*(```|~~~)\s*(\S*)\s*(.*)$/.exec(lines[0] ?? '')
  if (header === null) return null
  const fence = header[1]
  const last = lines.length - 1
  // 收尾必须与首行**同一种**围栏(``` 与 ~~~ 不能混用);未闭合按"到文末"处理。
  const closed = last > 0 && new RegExp(`^\\s*${fence}\\s*$`).test(lines[last])
  return {
    fence,
    language: String(header[2] ?? '').toLowerCase(),
    info: String(header[3] ?? '').trim(),
    body: lines.slice(1, closed ? last : last + 1),
  }
}

/** 这段围栏是不是网页演示(`embed`)。 */
export function isEmbedFence(source: string): boolean {
  const parts = fenceParts(source)
  return parts !== null && parts.language === 'embed'
}

/** 去掉路径两侧的引号/尖括号(`<path>`、`"path"`、`'path'`)。 */
function unwrapPath(value: string): string {
  const text = String(value ?? '').trim()
  const match = /^([<"'])([\s\S]*)([>"'])$/.exec(text)
  if (match === null) return text
  const pairs: Record<string, string> = { '<': '>', '"': '"', "'": "'" }
  return pairs[match[1]] === match[3] ? match[2].trim() : text
}

/** 配置行的键(大小写不敏感)。`path` 与 `src` 等价。 */
const CONFIG_KEY = /^(path|src|height|title)\s*:\s*(.*)$/i
/** 看起来像 `key: value`、但不是上面四个键的行 —— 视为坏配置,而不是路径。 */
const UNKNOWN_KEY = /^[A-Za-z][A-Za-z0-9_-]*\s*:/
/** Windows 盘符路径(`C:\x` / `C:/x`)不算 `key:`。 */
const DRIVE_PATH = /^[a-zA-Z]:[\\/]/

/** 把高度输入压到合法区间;非法/缺省用默认值。 */
export function clampEmbedHeight(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(parsed)) return DEFAULT_EMBED_HEIGHT
  return Math.max(EMBED_MIN_HEIGHT, Math.min(EMBED_MAX_HEIGHT, Math.round(parsed)))
}

/** 路径的最后一段(标题缺省值)。 */
export function basenameOf(path: string): string {
  const text = String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  const cut = text.lastIndexOf('/')
  return cut < 0 ? text : text.slice(cut + 1)
}

/**
 * 解析 `embed` 围栏(纯语法,不做路径解析)。
 * @param source - 含围栏的完整 markdown 片段。
 */
export function parseEmbedFence(source: string): EmbedParse {
  const parts = fenceParts(source)
  if (parts === null || parts.language !== 'embed') return { ok: false, problem: 'not-embed' }
  let infoPath = unwrapPath(parts.info)
  let bodyPath: string | null = null
  let title: string | null = null
  let height: number | null = null
  const problems: EmbedProblem[] = []

  for (const rawLine of parts.body) {
    const line = rawLine.trim()
    if (line === '') continue
    const keyed = CONFIG_KEY.exec(line)
    if (keyed !== null) {
      const key = keyed[1].toLowerCase()
      const value = keyed[2].trim()
      if (key === 'path' || key === 'src') {
        if (infoPath !== '' || bodyPath !== null) {
          problems.push('bad-config')
          continue
        }
        const unwrapped = unwrapPath(value)
        if (unwrapped === '') problems.push('no-path')
        else bodyPath = unwrapped
      } else if (key === 'height') {
        // 允许 `560` / `560px`;别的一律坏配置(不猜)。
        const match = /^(\d+)\s*(?:px)?$/i.exec(value)
        if (match === null) problems.push('bad-config')
        else height = clampEmbedHeight(match[1])
      } else {
        title = value === '' ? null : value
      }
      continue
    }
    // 不是已知配置行:只有"长得不像 key:"的才是路径。
    if (UNKNOWN_KEY.test(line) && !DRIVE_PATH.test(line)) {
      problems.push('bad-config')
      continue
    }
    if (bodyPath !== null || infoPath !== '') {
      problems.push('bad-config')
      continue
    }
    bodyPath = unwrapPath(line)
  }

  if (problems.length > 0) return { ok: false, problem: problems[0] }
  const path = infoPath !== '' ? infoPath : (bodyPath ?? '')
  if (path === '') return { ok: false, problem: 'no-path' }
  return { ok: true, path, title, height }
}

/**
 * 从围栏解析到"可渲染"的完整描述:语法 → URL 拒绝 → 相对笔记解析 → 扩展名。
 * @param source - 含围栏的完整 markdown 片段。
 * @param documentPath - 当前笔记的绝对路径。
 */
export function planEmbed(source: string, documentPath: string | null): EmbedPlan {
  const parsed = parseEmbedFence(source)
  if (parsed.ok !== true) return parsed
  const raw = parsed.path.trim()
  // 远程/内联/其它 URI scheme 一律不在"本地工作区文件"的范围内;
  // Windows 盘符(`C:\` / `C:/`)不算 scheme。
  const looksLikeDrive = DRIVE_PATH.test(raw)
  if (/^(?:https?:)?\/\//i.test(raw)) return { ok: false, problem: 'remote' }
  if (!looksLikeDrive && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return { ok: false, problem: 'remote' }
  if (documentPath === null || documentPath === '') return { ok: false, problem: 'no-document' }
  const absolutePath = resolveLocalPath(documentPath, raw)
  if (absolutePath === undefined) return { ok: false, problem: 'no-path' }
  if (!/\.html?$/i.test(absolutePath)) return { ok: false, problem: 'not-html' }
  return {
    ok: true,
    absolutePath,
    title: parsed.title !== null && parsed.title.trim() !== '' ? parsed.title.trim() : basenameOf(absolutePath),
    height: parsed.height,
  }
}

/**
 * 拼 iframe 的地址。
 *
 * 用**根相对**路径(与 `api.ts` 的 `/dsh-notes/*` 一致):`dsh-app://app/` 与
 * `http://127.0.0.1:<port>/` 两种载体都能解析;`workspaceKey` 为空时省略,
 * 让 Host 回落到会话自己的工作区。
 */
export function embedSrc(context: EmbedContext, absolutePath: string): string {
  const query = new URLSearchParams({ sessionId: context.sessionId, path: absolutePath })
  if (context.workspaceKey !== null && context.workspaceKey !== '') query.set('workspaceKey', context.workspaceKey)
  return `/dsh-notes/embed?${query.toString()}`
}

/** 给刷新按钮用:同一地址换一个 `r=` 参数(强制绕过缓存与同一 src 不重载)。 */
export function withReloadNonce(src: string, now: number = Date.now()): string {
  try {
    const url = new URL(src, 'http://dsh.invalid')
    url.searchParams.set('r', String(now))
    return url.pathname === '' ? src : `${url.pathname}${url.search}${url.hash}`
  } catch {
    return src
  }
}
