import { test } from 'node:test'
import assert from 'node:assert/strict'

import { installRoutes, ROUTE_PREFIX } from '../lib/routes.js'

/** 极简 ctx:捕获注册的 handler,并立刻执行 inject 回调。 */
function fakeCtx() {
  const routes = new Map()
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, debug: () => {} }),
    inject: (deps, callback) => {
      callback({
        webServer: {
          register: (route) => {
            routes.set(route.path, route.handler)
            return () => {}
          },
        },
        connection: { requestRejection: () => undefined },
      })
      return () => {}
    },
  }
  return { ctx, routes }
}

/** 极简 req:body 为一串 Buffer。 */
function fakeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** 极简 res:记录状态码与响应体。 */
function fakeRes() {
  return {
    status: 0,
    body: '',
    writableEnded: false,
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.body = text ?? ''
      this.writableEnded = true
    },
  }
}

function serviceSpy(seen) {
  return {
    createNote: async (payload) => {
      seen.push(payload)
      return { id: 'n_1', path: '/ws/notes/x.md' }
    },
    collection: async (payload) => {
      seen.push(payload)
      return { id: 'c_1' }
    },
    save: async (payload) => {
      seen.push(payload)
      return { version: 'v2' }
    },
    tree: async (payload) => {
      seen.push(payload)
      return { workspace: { key: 'k' }, notes: [], collections: [], refs: [], unfiled: [], stats: {} }
    },
  }
}

test('POST 路由:JSON body 必须合并进 handler 入参(回归:曾只传 {req,res,query})', async () => {
  const seen = []
  const { ctx, routes } = fakeCtx()
  installRoutes(ctx, serviceSpy(seen))
  const handler = routes.get(`${ROUTE_PREFIX}/create`)
  assert.equal(typeof handler, 'function', 'create 路由应已注册')

  const res = fakeRes()
  await handler(
    fakeReq('POST', `${ROUTE_PREFIX}/create`, JSON.stringify({ sessionId: 's-1', title: 'P1 验收笔记', collectionId: null })),
    res,
  )

  assert.equal(res.status, 200)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].sessionId, 's-1')
  assert.equal(seen[0].title, 'P1 验收笔记')
  assert.deepEqual(JSON.parse(res.body), { ok: true, value: { id: 'n_1', path: '/ws/notes/x.md' } })
})

test('POST 路由:空 body 也不会抛(交给 service 层校验)', async () => {
  const seen = []
  const { ctx, routes } = fakeCtx()
  installRoutes(ctx, serviceSpy(seen))
  const res = fakeRes()
  await routes.get(`${ROUTE_PREFIX}/save`)(fakeReq('POST', `${ROUTE_PREFIX}/save`, ''), res)
  assert.equal(res.status, 200)
  assert.deepEqual(seen[0], { req: seen[0].req, res: seen[0].res, query: seen[0].query })
})

test('GET 路由:sessionId 从查询串取,不读 body', async () => {
  const seen = []
  const { ctx, routes } = fakeCtx()
  installRoutes(ctx, serviceSpy(seen))
  const res = fakeRes()
  await routes.get(`${ROUTE_PREFIX}/tree`)(fakeReq('GET', `${ROUTE_PREFIX}/tree?sessionId=s-9&force=1`), res)
  assert.equal(res.status, 200)
  assert.equal(seen[0].sessionId, 's-9')
  assert.equal(seen[0].force, true)
})

test('错误映射:NotesError.code → HTTP 状态 + 冲突字段', async () => {
  const { NotesError } = await import('../lib/service.js')
  const { ctx, routes } = fakeCtx()
  installRoutes(ctx, {
    createNote: async () => {
      throw new NotesError('文件已被外部修改', 'FS_STALE_VERSION', { currentVersion: 'v9', currentText: 'x' })
    },
    tree: async () => ({}),
  })
  const res = fakeRes()
  await routes.get(`${ROUTE_PREFIX}/create`)(fakeReq('POST', `${ROUTE_PREFIX}/create`, '{}'), res)
  assert.equal(res.status, 409)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'FS_STALE_VERSION')
  assert.equal(body.currentVersion, 'v9')
})

test('鉴权:connection 拒绝时一律 401/403,不进入 handler', async () => {
  const seen = []
  const routes = new Map()
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, debug: () => {} }),
    inject: (deps, callback) => {
      callback({
        webServer: {
          register: (route) => {
            routes.set(route.path, route.handler)
            return () => {}
          },
        },
        connection: { requestRejection: () => 401 },
      })
      return () => {}
    },
  }
  installRoutes(ctx, serviceSpy(seen))
  const res = fakeRes()
  await routes.get(`${ROUTE_PREFIX}/create`)(fakeReq('POST', `${ROUTE_PREFIX}/create`, '{}'), res)
  assert.equal(res.status, 401)
  assert.equal(seen.length, 0)
})
