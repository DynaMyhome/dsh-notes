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
  stats: { notes: number; collections: number; refs: number; unfiled: number }
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
): Promise<{ version: string; path: string }> {
  return call('save', { sessionId, path, text, expectedVersion })
}

/** 调一条写路由。 */
export async function call<T = any>(action: string, payload: Record<string, unknown>): Promise<T> {
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
