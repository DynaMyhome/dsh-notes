/**
 * 客户端 → Host 的薄封装。
 *
 * 写与树走自建同源路由(`/dsh-notes/*`,自带鉴权与 `{ok,value|error}` 信封);
 * **读文件内容不走这里** —— 编辑器用官方 Remote(`ctx.remote.workspaceFiles`)。
 */

/** 路由前缀(与 Host 的 routes.js 一致)。 */
const PREFIX = '/dsh-notes'

/** 一条分类节点。 */
export interface TreeNode {
  id: string
  name: string
  parentId: string | null
  order: number
  count: number
}

/** 一篇本工作区的笔记。 */
export interface TreeNote {
  id: string
  title: string
  path: string
  relPath: string
  collectionId: string | null
  /** 同级手动顺序(越小越靠前);未设过 = Number.MAX_SAFE_INTEGER。 */
  order?: number
  pinned: boolean
}

/** 一篇从别的工作区映射进来的笔记。 */
export interface TreeRef {
  noteId: string
  title: string
  path: string
  relPath: string
  workspaceKey: string
  workspaceName: string
  collectionId: string | null
}

/** 磁盘上存在、但还没纳入笔记树的 md。 */
export interface TreeUnfiled {
  path: string
  relPath: string
  title: string
  id: string | null
}

/** 一次对账/重扫的结果(重扫按钮用它回显"到底扫到了什么")。 */
export interface ScanReport {
  at: number
  scanned: number
  rebound: number
  dropped: number
  unfiled: number
  truncated: boolean
}

/** 一棵完整的笔记树。 */
export interface Tree {
  workspace: { key: string; root: string; name: string; notesRoot: string; notesDir: string }
  collections: TreeNode[]
  notes: TreeNote[]
  refs: TreeRef[]
  unfiled: TreeUnfiled[]
  unfiledTruncated: boolean
  pinned: string[]
  recent: string[]
  /** 最近一次扫描的报告;**普通取树(读缓存)时为 null**。 */
  scanReport?: ScanReport | null
  stats: { notes: number; collections: number; refs: number; unfiled: number }
}

/**
 * 工作区里的一个 md 文件(三类分类的载体)。
 *
 * `at` 是 Host 给的版本号(本地 provider 就是 mtime),用于「最近」排序;
 * 拿不到时为 0。
 */
export interface FileEntry {
  path: string
  relPath: string
  title: string
  id: string | null
  folder: string
  bytes: number
  at: number
}

/** 三类分类结果(纳入管理面板的数据源)。 */
export interface FileScan {
  workspace: { key: string; root: string; name: string; notesRoot: string }
  notes: { id: string; title: string; path: string; relPath: string; collectionId: string | null }[]
  /** 未纳入、还没标记。 */
  candidates: FileEntry[]
  /** 未纳入、已标为杂项。 */
  ignored: FileEntry[]
  /** 批量忽略规则(glob)。 */
  ignoredGlobs: string[]
  stats: { notes: number; candidates: number; ignored: number; total: number; changed: number; dirs: number }
  truncated: boolean
  indexAt: number
  /** 扫描时的首个错误(provider 拒绝/超时);没有就是 null。 */
  scanError?: string | null
  /** 正向正在扫时的进度;不在扫时为 null。 */
  scanProgress?: { phase: string; dirs: number; files: number } | null
  /** 还有目录没走完:前端应继续拉(分块续扫),直到 false。 */
  scanning?: boolean
  /** 这次的扫描范围(工作区相对;`''` = 工作区根)。 */
  scanRoots?: string[]
  /** 走目录/读 frontmatter 各花了多久(诊断用)。 */
  timing?: { walkMs: number; readMs: number }
}

/** 路由错误(带 Host 的 code 与冲突时的当前版本/内容)。 */
export class RouteError extends Error {
  code: string
  currentVersion?: string
  currentText?: string

  constructor(message: string, code: string, extra: { currentVersion?: string; currentText?: string } = {}) {
    super(message)
    this.name = 'RouteError'
    this.code = code
    this.currentVersion = extra.currentVersion
    this.currentText = extra.currentText
  }
}

/** 展开信封;失败时抛 {@link RouteError}。 */
async function unwrap(response: Response): Promise<any> {
  let envelope: any = null
  try {
    envelope = await response.json()
  } catch {
    throw new RouteError(`路由返回了非 JSON(HTTP ${response.status})`, 'BAD_RESPONSE')
  }
  if (envelope === null || envelope.ok !== true) {
    throw new RouteError(
      String(envelope?.error ?? `路由失败(HTTP ${response.status})`),
      String(envelope?.code ?? 'ERROR'),
      { currentVersion: envelope?.currentVersion, currentText: envelope?.currentText },
    )
  }
  return envelope.value
}

/** 读整棵树。 */
export async function fetchTree(sessionId: string, force = false): Promise<Tree> {
  const query = new URLSearchParams({ sessionId })
  if (force) query.set('force', '1')
  const response = await fetch(`${PREFIX}/tree?${query.toString()}`, { credentials: 'same-origin' })
  return (await unwrap(response)) as Tree
}

/**
 * 读工作区的三类分类(候选/杂项/统计)。
 * @param sessionId - 会话 id(决定工作区)。
 * @param options - `force` 忽略 Host 侧 TTL;`query`/`folder`/`sort`/`limit` 过滤。
 * @returns 分类结果。
 */
export async function fetchFiles(
  sessionId: string,
  options: { force?: boolean; query?: string; folder?: string; sort?: 'recent' | 'path'; limit?: number } = {},
): Promise<FileScan> {
  const query = new URLSearchParams({ sessionId })
  if (options.force) query.set('force', '1')
  if (options.query) query.set('query', options.query)
  if (options.folder) query.set('folder', options.folder)
  if (options.sort) query.set('sort', options.sort)
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  const response = await fetch(`${PREFIX}/files?${query.toString()}`, { credentials: 'same-origin' })
  return (await unwrap(response)) as FileScan
}

/** 批量纳入(逐条等同 register;已纳入的幂等跳过)。 */
export async function includePaths(
  sessionId: string,
  paths: string[],
  collectionId: string | null = null,
): Promise<{ included: { id: string; path: string; title: string }[]; failed: { path: string; message: string }[] }> {
  return call('include', { sessionId, paths, collectionId })
}

/**
 * 设置扫描范围(工作区相对目录;空数组 = 回到 notesDir)。
 *
 * 本机实测一次 listDir 约 330ms,扫整个工作区要按分钟算 —— 所以"要多看哪里"
 * 由用户显式说出来(面板上的「扫描范围」一行)。
 */
export async function setScanRoots(sessionId: string, roots: string[]): Promise<{ scanRoots: string[] }> {
  return call('scan-roots', { sessionId, roots })
}

/** 批量标为杂项 / 放回候选(`on: false` = 撤销忽略)。 */
export async function ignorePaths(
  sessionId: string,
  payload: { paths?: string[]; globs?: string[]; on?: boolean },
): Promise<{ ignored: string[]; ignoredGlobs: string[] }> {
  return call('ignore', { sessionId, ...payload })
}

/** 读一篇笔记的正文 + 版本号(编辑器打开时用)。 */
export async function readNote(
  sessionId: string,
  path: string,
): Promise<{ text: string; version: string; absolutePath: string }> {
  return call('read', { sessionId, path })
}

/** 守卫式保存:版本不符时抛 `RouteError('FS_STALE_VERSION')`,带上磁盘版本与内容。 */
export async function saveNote(
  sessionId: string,
  path: string,
  text: string,
  expectedVersion: string,
): Promise<{ version: string; path: string; restoredId?: boolean; text?: string }> {
  return call('save', { sessionId, path, text, expectedVersion })
}

/** 重命名笔记(显式动作;Host 只做同目录 rename,目标存在则拒绝)。 */
export async function renameNote(
  sessionId: string,
  noteId: string,
  title: string,
): Promise<{ id: string; path: string; title: string }> {
  return call('rename', { sessionId, noteId, title })
}

/** 置顶 / 取消置顶。 */
export async function pinNote(sessionId: string, noteId: string, pinned: boolean): Promise<boolean> {
  return call('pin', { sessionId, noteId, pinned })
}

/** 回收站里的一条记录。 */
export interface TrashEntry {
  id: string
  noteId: string
  title: string
  originalPath: string
  file: string
  workspaceKey: string
  deletedAt: number
  /** 文件是否还在回收站目录里(可能被外部动过)。 */
  exists: boolean
}

/** 删除笔记 → 移入回收站(文件没被真删,可恢复)。 */
export async function trashNote(
  sessionId: string,
  noteId: string,
): Promise<{ id: string; title: string; path: string; file: string }> {
  return call('trash', { sessionId, noteId })
}

/** 读回收站清单。 */
export async function fetchTrash(): Promise<{ root: string; entries: TrashEntry[] }> {
  const response = await fetch(`${PREFIX}/trash/list`, { credentials: 'same-origin' })
  return (await unwrap(response)) as { root: string; entries: TrashEntry[] }
}

/** 从回收站恢复(原位置被占用则报错)。 */
export async function restoreTrash(
  sessionId: string,
  id: string,
): Promise<{ path: string; note: TreeNote }> {
  return call('trash/restore', { sessionId, id })
}

/** 彻底删除(`all` = 清空回收站)。 */
export async function purgeTrash(id: string | null, all = false): Promise<{ removed: number }> {
  return call('trash/purge', all ? { all: true } : { id })
}

/** 把外部内容导入成笔记(拖进来的 `.md`)。 */
export async function importNote(
  sessionId: string,
  name: string,
  text: string,
  collectionId: string | null = null,
): Promise<TreeNote> {
  return call('import', { sessionId, name, text, collectionId })
}

/** 调一条写路由。 */export async function call<T = any>(action: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${PREFIX}/${action}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return (await unwrap(response)) as T
}

/** 上传一张图片,返回可写进 markdown 的相对链接。 */
export async function uploadAsset(
  sessionId: string,
  noteId: string | null,
  name: string,
  bytes: Blob,
): Promise<{ absolutePath: string; relative: string; markdown: string }> {
  const query = new URLSearchParams({ sessionId, name })
  if (noteId !== null) query.set('noteId', noteId)
  const response = await fetch(`${PREFIX}/asset?${query.toString()}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': bytes.type || 'application/octet-stream' },
    body: bytes,
  })
  return unwrap(response)
}
