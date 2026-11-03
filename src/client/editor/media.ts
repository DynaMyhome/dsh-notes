/**
 * 编辑器里的媒体地址工具(纯函数)。
 *
 * 单独成模块是为了**打断循环依赖**:`decorate.ts` 需要它,而 `setup.ts` 需要
 * `decorate.ts` —— 两边互相 import 会让其中一个模块初始化到一半就被对方用到,
 * 运行时表现为 `Cannot access '<x>' before initialization`(实测踩到,整个笔记
 * 面板渲染失败)。
 */

/**
 * 把 markdown 里的本地地址解析成**规范化绝对路径**(纯函数)。
 *
 * 只处理本地文件:`http(s)://` 与 `data:` 返回 `undefined`(调用方按需原样使用),
 * 空的/只有 `<...>` 的地址同样返回 `undefined`。
 *
 * 为什么抽出来:图片要走官方 `api/file`,网页演示要走插件自己的 `/dsh-notes/embed`,
 * 但"相对路径按笔记目录展开、`..` 归一、Windows 盘符"这套规则必须只有一份 ——
 * 两份迟早不一致(一份认 `..`、一份不认,表现就是"同一个路径图片能看、演示打不开")。
 *
 * @param documentPath - 当前笔记的绝对路径(用于解析相对路径)。
 * @param destination - md 里写的地址。
 * @returns 规范化的绝对本地路径,或 undefined。
 */
export function resolveLocalPath(documentPath: string | null, destination: string): string | undefined {
  const raw = String(destination ?? '').trim()
  if (raw === '') return undefined
  if (/^https?:\/\//i.test(raw) || raw.startsWith('data:')) return undefined
  const cleaned = raw.replace(/^<|>$/g, '').split(/[?#]/)[0]
  if (cleaned === '') return undefined
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(cleaned) || cleaned.startsWith('/')
  let absolute = cleaned.replace(/\\/g, '/')
  if (!isAbsolute) {
    if (documentPath === null) return undefined
    const dir = documentPath.replace(/\\/g, '/').replace(/\/[^/]*$/, '')
    absolute = `${dir}/${cleaned}`
    // 归一化 ./ 与 ../
    const parts: string[] = []
    for (const segment of absolute.split('/')) {
      if (segment === '.' || segment === '') continue
      if (segment === '..') parts.pop()
      else parts.push(segment)
    }
    absolute = `${absolute.startsWith('/') ? '/' : ''}${parts.join('/')}`
  }
  const query = absolute.replace(/^<|>$/g, '')
  return query === '' ? undefined : query
}

/**
 * 解析图片地址:本地相对路径 → 宿主同源 `api/file?path=`。
 * @param documentPath - 当前笔记的绝对路径(用于解析相对路径)。
 * @param destination - md 里写的地址。
 * @returns 可用于 `<img src>` 的地址,或 undefined。
 */
export function resolveImageUrl(documentPath: string | null, destination: string): string | undefined {
  const raw = String(destination ?? '').trim()
  if (/^https?:\/\//i.test(raw) || raw.startsWith('data:')) return raw
  const absolute = resolveLocalPath(documentPath, destination)
  if (absolute === undefined) return undefined
  return `api/file?path=${encodeURIComponent(absolute)}`
}
