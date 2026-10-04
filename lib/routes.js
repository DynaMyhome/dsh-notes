/**
 * 同源 HTTP 路由(`/dsh-notes/*`)。
 *
 * 这些路由不在官方 `/api` 栅栏内,**每条必须自己鉴权**
 * (`connection.requestRejection({ headers })`);只跑在 loopback / 已认证会话上。
 *
 * 客户端只用这里的**写**与**树**;读文件内容走官方 Remote
 * (`ctx.remote.workspaceFiles`),不重复造一条读接口。
 *
 * @module dsh-notes/routes
 */

import { NotesError } from './service.js'

/** 路由前缀。 */
export const ROUTE_PREFIX = '/dsh-notes'
/**
 * JSON 请求体上限(**保存笔记正文也走这里**)。
 *
 * 原来是 64KB —— 对"一篇正经笔记"来说太小了:用户那篇
 * `research/TIA/TIA跨阻放大器调研.md` 是 **123,530 字节**(74,160 字符),
 * 于是编辑器里每次保存都被这条闸门挡住,界面只显示「Save failed」、
 * 真正的错误「请求体过大」藏在响应里(2026-10-01 实测)。
 * 笔记是纯文本,本地同源路由、自带鉴权,放到 8MB 足够宽容又仍有界。
 */
const BODY_LIMIT = 8 * 1024 * 1024
/** 资产(图片)体上限。 */
const ASSET_LIMIT = 16 * 1024 * 1024

/** 写一个 JSON 响应。 */
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 读 JSON 请求体(有上限)。 */
async function readJsonBody(req, limit = BODY_LIMIT) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new NotesError('请求体过大', 'INVALID')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}

/** 读原始字节体(资产上传)。 */
async function readRawBody(req, limit = ASSET_LIMIT) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new NotesError('图片过大(上限 16MB)', 'INVALID')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** NotesError → HTTP 状态。 */
function statusOf(error) {
  const code = error instanceof NotesError ? error.code : ''
  if (code === 'NOT_FOUND') return 404
  if (code === 'INVALID' || code === 'NOT_MARKDOWN' || code === 'EXISTS') return 400
  if (code === 'FS_STALE_VERSION' || code === 'WORKSPACE_UNKNOWN') return 409
  return 500
}

/** 自鉴权包装:`{ ok, value | error, code }` 信封。
 *
 * 非 GET 的路由在这里就把 JSON body 读出来并**合并进 handler 的入参**
 * —— 早期版本只传了 `{ req, res, query }`,于是每个写路由拿到的
 * `sessionId`/`title`/`path` 全是 undefined(表现为「新建笔记需要非空 title」,
 * 更早还表现为把笔记写进进程 cwd)。`raw: true` 的路由(资产上传)自己读字节流。
 */
function makeHandler(connection, fn, { method = 'POST', log, raw = false } = {}) {
  return async (req, res) => {
    let rejection
    try {
      rejection = connection.requestRejection({ headers: req.headers })
    } catch {
      rejection = 403
    }
    if (rejection !== undefined) {
      json(res, typeof rejection === 'number' ? rejection : 403, { ok: false, error: '未授权', code: 'UNAUTHORIZED' })
      return
    }
    if (req.method !== method) {
      json(res, 405, { ok: false, error: `只接受 ${method}`, code: 'METHOD' })
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      log?.info?.('[dsh-notes] %s %s%s', req.method, url.pathname, url.search === '' ? '' : url.search)
      let payload = { req, res, query: url.searchParams }
      if (!raw && req.method !== 'GET' && req.method !== 'HEAD') {
        const body = await readJsonBody(req)
        if (body !== null && typeof body === 'object' && !Array.isArray(body)) payload = { ...payload, ...body }
      }
      const value = await fn(payload)
      if (res.writableEnded) return
      json(res, 200, { ok: true, value })
    } catch (error) {
      const payload = { ok: false, error: error?.message ?? String(error), code: error?.code ?? 'ERROR' }
      if (error?.currentVersion !== undefined) payload.currentVersion = error.currentVersion
      if (error?.currentText !== undefined) payload.currentText = error.currentText
      json(res, statusOf(error), payload)
    }
  }
}

/**
 * 注册全部路由。
 * @param ctx - 插件上下文。
 * @param service - 笔记服务。
 */
export function installRoutes(ctx, service) {
  return ctx.inject(['webServer', 'connection'], (httpCtx) => {
    const connection = httpCtx.connection
    const log = typeof ctx.logger === 'function' ? ctx.logger('dsh-notes') : undefined
    const disposers = []
    const on = (path, fn, options) =>
      disposers.push(
        httpCtx.webServer.register({ kind: 'exact', path, handler: makeHandler(connection, fn, { log, ...options }) }),
      )

    // 树:GET /dsh-notes/tree?sessionId=&force=1
    on(
      `${ROUTE_PREFIX}/tree`,
      ({ query }) =>
        service.tree({
          sessionId: query.get('sessionId') ?? undefined,
          workspaceKey: query.get('workspaceKey') ?? undefined,
          force: query.get('force') === '1',
        }),
      { method: 'GET' },
    )

    on(`${ROUTE_PREFIX}/collection`, (payload) => service.collection(payload))
    on(`${ROUTE_PREFIX}/register`, (payload) => service.register(payload))
    on(`${ROUTE_PREFIX}/unregister`, (payload) => service.unregister(payload))
    on(`${ROUTE_PREFIX}/move`, (payload) => service.moveNote(payload))
    on(`${ROUTE_PREFIX}/reference`, (payload) => service.reference(payload))
    on(`${ROUTE_PREFIX}/unreference`, (payload) => service.unreference(payload))
    on(`${ROUTE_PREFIX}/create`, (payload) => service.createNote(payload))
    // 三类分类:GET /dsh-notes/files?sessionId=&force=1&query=&sort=recent|path&folder=&limit=
    on(
      `${ROUTE_PREFIX}/files`,
      async ({ query }) => {
        const sessionId = query.get('sessionId') ?? undefined
        const workspace = await service.workspaceOf(sessionId, query.get('workspaceKey') ?? undefined)
        return service.classify(workspace.key, {
          force: query.get('force') === '1',
          query: query.get('query') ?? '',
          sort: query.get('sort') === 'path' ? 'path' : 'recent',
          folder: query.get('folder') ?? '',
          limit: Number(query.get('limit') ?? 500),
        })
      },
      { method: 'GET' },
    )
    // 纳入(批量)/ 忽略(批量、可撤销)
    on(`${ROUTE_PREFIX}/include`, (payload) => service.includePaths(payload))
    // 笔记根:改成本工作区里已有的目录 / 创建目录(只创建,永不删除或覆盖)
    on(`${ROUTE_PREFIX}/notes-root`, (payload) => service.setNotesRoot(payload))
    on(`${ROUTE_PREFIX}/notes-dir`, (payload) => service.createNotesDir(payload))
    // 工作区:列出已登记的工作区 / 打开一个目录作为工作区(笔记区域可切换)
    on(`${ROUTE_PREFIX}/workspaces`, ({ query }) => service.listWorkspaces({ sessionId: query.get('sessionId') ?? undefined }), {
      method: 'GET',
    })
    on(`${ROUTE_PREFIX}/workspace/open`, (payload) => service.openWorkspace(payload))
    // 扫描范围(工作区相对目录;空数组 = 回到 notesDir)
    on(`${ROUTE_PREFIX}/scan-roots`, (payload) => service.setScanRoots(payload))
    on(`${ROUTE_PREFIX}/ignore`, (payload) => service.ignorePaths(payload))
    on(`${ROUTE_PREFIX}/rescan`, async (payload) => {
      // 一次「重新扫描」= notesDir 那一遍(tree(force),带 scanReport)+
      // 整个工作区那一遍(classify(force),候选/杂项)。返回仍是 tree 形状,
      // 额外挂一个 `files` 摘要给界面回显。
      const tree = await service.tree({ sessionId: payload.sessionId, force: true })
      const files = await service.classify(tree.workspace.key, { force: true })
      return {
        ...tree,
        files: { stats: files.stats, truncated: files.truncated, indexAt: files.indexAt },
      }
    })
    on(`${ROUTE_PREFIX}/pin`, (payload) => service.pin(payload))
    on(`${ROUTE_PREFIX}/rename`, (payload) => service.renameNote(payload))
    // 回收站:删除笔记 = 移入回收站(可恢复);真正 unlink 只在「彻底删除」时发生
    on(`${ROUTE_PREFIX}/trash`, (payload) => service.trashNote(payload))
    on(
      `${ROUTE_PREFIX}/trash/list`,
      ({ query }) =>
        service.listTrash({
          sessionId: query.get('sessionId') ?? undefined,
          workspaceKey: query.get('workspaceKey') ?? undefined,
        }),
      { method: 'GET' },
    )
    on(`${ROUTE_PREFIX}/trash/restore`, (payload) => service.restoreTrash(payload))
    on(`${ROUTE_PREFIX}/trash/purge`, (payload) => service.purgeTrash(payload))
    on(`${ROUTE_PREFIX}/import`, (payload) => service.importFile(payload))
    // 版本探针:客户端每 1.5s 问一次"打开着的笔记磁盘版本变了没有"(只 stat,不读正文)。
    on(`${ROUTE_PREFIX}/stat`, (payload) => service.statNotes(payload))
    // 历史快照:列表 / 读一条正文(预览)/ 恢复 / 撤销最近一次外部改动。
    on(
      `${ROUTE_PREFIX}/history`,
      ({ query }) =>
        service.listHistory({
          sessionId: query.get('sessionId') ?? undefined,
          workspaceKey: query.get('workspaceKey') ?? undefined,
          noteId: query.get('noteId') ?? '',
        }),
      { method: 'GET' },
    )
    on(
      `${ROUTE_PREFIX}/history/read`,
      ({ query }) =>
        service.readHistoryEntry({
          sessionId: query.get('sessionId') ?? undefined,
          workspaceKey: query.get('workspaceKey') ?? undefined,
          noteId: query.get('noteId') ?? '',
          file: query.get('file') ?? '',
        }),
      { method: 'GET' },
    )
    on(`${ROUTE_PREFIX}/history/restore`, (payload) => service.restoreHistory(payload))
    on(`${ROUTE_PREFIX}/history/undo-external`, (payload) => service.undoExternal(payload))
    on(`${ROUTE_PREFIX}/read`, (payload) => service.readNote(payload))
    on(`${ROUTE_PREFIX}/save`, (payload) => service.save(payload))

    // 资产:POST /dsh-notes/asset?sessionId=&noteId=&name=<原始字节>
    on(
      `${ROUTE_PREFIX}/asset`,
      async ({ req, query }) => {
        const bytes = await readRawBody(req)
        const name = query.get('name') ?? ''
        const extension = extensionOf(name, req.headers['content-type'])
        return service.saveAsset({
          sessionId: query.get('sessionId') ?? undefined,
          workspaceKey: query.get('workspaceKey') ?? undefined,
          noteId: query.get('noteId') ?? undefined,
          bytes,
          extension,
        })
      },
      { method: 'POST', raw: true },
    )

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 卸载期忽略 */
        }
      }
    }
  })
}

/** 资产后缀:mime → 后缀,否则取文件名后缀。 */
function extensionOf(name, contentType) {
  const fromMime = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
    'image/avif': '.avif',
    'image/svg+xml': '.svg',
  }[String(contentType ?? '').split(';')[0].trim()]
  if (fromMime !== undefined) return fromMime
  const match = /\.([a-z0-9]{1,5})$/i.exec(String(name ?? ''))
  return match === null ? '.png' : `.${match[1].toLowerCase()}`
}
