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
/** JSON 请求体上限。 */
const BODY_LIMIT = 64 * 1024
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

/** 自鉴权包装:`{ ok, value | error, code }` 信封。 */
function makeHandler(connection, fn, { method = 'POST' } = {}) {
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
      const value = await fn({ req, res, query: url.searchParams })
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
    const disposers = []
    const on = (path, fn, options) =>
      disposers.push(httpCtx.webServer.register({ kind: 'exact', path, handler: makeHandler(connection, fn, options) }))

    // 树:GET /dsh-notes/tree?sessionId=&force=1
    on(
      `${ROUTE_PREFIX}/tree`,
      ({ query }) =>
        service.tree({
          sessionId: query.get('sessionId') ?? undefined,
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
    on(`${ROUTE_PREFIX}/rescan`, async (payload) => {
      const [workspaceKey] = await workspaceArgs(service, payload)
      await service.reconcile(workspaceKey, { force: true })
      return service.tree({ sessionId: payload.sessionId, force: true })
    })
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
          noteId: query.get('noteId') ?? undefined,
          bytes,
          extension,
        })
      },
      { method: 'POST' },
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

/** 把 payload 收敛成 `reconcile(workspaceKey)`,顺手保证监视已挂。 */
async function workspaceArgs(service, payload) {
  const workspace = await service.workspaceOf(payload?.sessionId)
  await service.armWatch(workspace.key)
  return [workspace.key]
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
