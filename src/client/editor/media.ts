/**
 * 编辑器里的媒体地址工具(纯函数)。
 *
 * 单独成模块是为了**打断循环依赖**:`decorate.ts` 需要它,而 `setup.ts` 需要
 * `decorate.ts` —— 两边互相 import 会让其中一个模块初始化到一半就被对方用到,
 * 运行时表现为 `Cannot access '<x>' before initialization`(实测踩到,整个笔记
 * 面板渲染失败)。
 */

/**
 * 解析图片地址:本地相对路径 → 宿主同源 `api/file?path=`。
 * @param documentPath - 当前笔记的绝对路径(用于解析相对路径)。
 * @param destination - md 里写的地址。
 * @returns 可用于 `<img src>` 的地址,或 undefined。
 */
export function resolveImageUrl(documentPath: string | null, destination: string): string | undefined {
  const raw = String(destination ?? '').trim()
  if (raw === '') return undefined
  if (/^https?:\/\//i.test(raw) || raw.startsWith('data:')) return raw
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
  return `api/file?path=${encodeURIComponent(query)}`
}
