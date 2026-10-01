/**
 * 目录选择器的纯逻辑(可单测):过滤、相对化、面包屑夹取。
 *
 * 数据来自官方 Client 服务 `uiWorkspace.listDirectory(path)` —— **只能用它**:
 * 本 profile 组合的是 `browse` 后端(见 `dsh-host-directory-picker` 的 capability 契约),
 * `uiWorkspace.pickDirectory()` 需要的是 `native` capability,在这里会被
 * `directory-picker/unavailable` 拒绝(实测)。所以自己拿 list 原语拼一个面板内浏览器。
 */

/** `DirectoryListing` 的子集(不 import 官方包:构建期的 nodePaths 里没有它)。 */
export interface DirEntryLike {
  name: string
  /** 绝对路径 —— **客户端绝不自己拼路径段**(官方契约如此)。 */
  path: string
  hidden: boolean
}

/** 一层目录 + 它的祖先链(官方 `DirectoryListing` 的子集)。 */
export interface DirListingLike {
  /** 被列出的这一层(绝对路径)。 */
  path: string
  /** Host 账号的家目录(面包屑根)。 */
  home: string
  /** 从文件系统根到当前目录的祖先链。 */
  crumbs: DirEntryLike[]
  /** 直接子目录(只有目录,已按名排序)。 */
  entries: DirEntryLike[]
  /** 子目录过多被截断。 */
  truncated: boolean
}

/** 与 `lib/notes.js` 的 `SKIP_DIRS` 保持一致(客户端不能 import 那个模块:它依赖 node:crypto)。 */
export const SKIP_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', '.obsidian', '.dsh-assets', '.trash'])

/**
 * 一个层里**值得给用户看/选的**子目录。
 *
 * 与 Host 的走目录规则对齐(点目录 + SKIP_DIRS 一律跳过),免得让用户选一个
 * 扫描器根本不会进去的目录,选完了什么都没有。
 * @param entries - 一层目录列表。
 * @returns 过滤并按名排序的新数组。
 */
export function visibleDirs(entries: readonly DirEntryLike[]): DirEntryLike[] {
  return entries
    .filter((entry) => entry.hidden !== true)
    .filter((entry) => !entry.name.startsWith('.'))
    .filter((entry) => !SKIP_DIRS.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'))
}

/**
 * 绝对路径 → 工作区相对路径。
 *
 * **Host 侧还会再校验一次**(`service.setScanRoots`),这里只是为了在面板里
 * 提前给出人话报错。两边规则必须一致:工作区根 → `''`,越界 → 失败。
 * @param root - 工作区根。
 * @param absolute - 绝对路径。
 * @returns 相对路径(`rel` 为 `''` 表示工作区根);越界时 `ok: false`。
 */
export function relativeToRoot(root: string, absolute: string): { ok: true; rel: string } | { ok: false } {
  const base = String(root ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const target = String(absolute ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (base === '' || target === '') return { ok: false }
  const bothDrive = /^[a-zA-Z]:\//.test(base) && /^[a-zA-Z]:\//.test(target)
  const left = bothDrive ? base.toLowerCase() : base
  const right = bothDrive ? target.toLowerCase() : target
  if (right === left) return { ok: true, rel: '' }
  if (!right.startsWith(`${left}/`)) return { ok: false }
  return { ok: true, rel: target.slice(base.length + 1) }
}

/**
 * 面包屑只画到工作区根为止(用户不许从浏览器里走出工作区)。
 * @param root - 工作区根的绝对路径。
 * @param crumbs - 官方给的祖先链(从文件系统根到当前目录)。
 * @returns 从工作区根开始的那一段;当前目录在工作区外时返回空数组。
 */
export function crumbsWithin(root: string, crumbs: readonly DirEntryLike[]): DirEntryLike[] {
  const mapped = relativeToRoot(root, String(crumbs[crumbs.length - 1]?.path ?? ''))
  if (!mapped.ok) return []
  const rootText = String(root ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const index = crumbs.findIndex((crumb) => String(crumb.path ?? '').replace(/\\/g, '/').replace(/\/+$/, '') === rootText)
  return index < 0 ? [] : crumbs.slice(index)
}

/**
 * 「选择这个目录」要提交的相对路径(工作区根 → `''` = 整个工作区)。
 * @param root - 工作区根。
 * @param current - 浏览器当前所在目录。
 * @returns 相对路径;越界时 null。
 */
export function pickValueOf(root: string, current: string): string | null {
  const mapped = relativeToRoot(root, current)
  return mapped.ok ? mapped.rel : null
}
