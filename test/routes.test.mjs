import { test } from 'node:test'
import assert from 'node:assert/strict'

import { EMBED_CSP, installRoutes, ROUTE_PREFIX } from '../lib/routes.js'

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

/** 极简 res:记录状态码、响应头与响应体。 */
function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writableEnded: false,
    headersSent: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
      this.headersSent = true
    },
    end(value) {
      const text = value ?? ''
      this.body = Buffer.isBuffer(text) ? text.toString('utf8') : String(text)
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

test('POST 路由:大笔记(>64KB)必须能保存 —— 以前的 64KB 闸门让"保存"永远失败', async () => {
  const seen = []
  const { ctx, routes } = fakeCtx()
  installRoutes(ctx, serviceSpy(seen))
  // 用户实测那篇笔记:123,530 字节(74,160 字符)。旧上限 64KB 会回「请求体过大」,
  // 而界面上只显示「Save failed」—— 正文其实完全没写下去。
  const big = '这是一段用来撑大请求体的正文。'.repeat(9000)
  assert.equal(Buffer.byteLength(big, 'utf8') > 128 * 1024, true, '测试数据本身要超过旧的 64KB 上限')
  const res = fakeRes()
  await routes.get(`${ROUTE_PREFIX}/save`)(
    fakeReq('POST', `${ROUTE_PREFIX}/save`, JSON.stringify({ sessionId: 's-1', path: '/ws/notes/big.md', text: big })),
    res,
  )
  assert.equal(res.status, 200, `大正文不该被闸门挡住:${res.body}`)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].text.length, big.length, '正文一个字都不能被截断')
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

test('POST 路由:/stat 把路径列表交给 service,并原样回版本映射(含 null)', async () => {
  const seen = []
  const { ctx, routes } = fakeCtx()
  installRoutes(ctx, {
    statNotes: async (payload) => {
      seen.push(payload)
      return { versions: { '/ws/notes/a.md': 'v2', '/ws/notes/b.md': null } }
    },
    tree: async () => ({}),
  })
  const res = fakeRes()
  await routes.get(`${ROUTE_PREFIX}/stat`)(
    fakeReq(
      'POST',
      `${ROUTE_PREFIX}/stat`,
      JSON.stringify({ sessionId: 's-1', paths: ['/ws/notes/a.md', '/ws/notes/b.md'] }),
    ),
    res,
  )
  assert.equal(res.status, 200)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].sessionId, 's-1')
  assert.deepEqual(seen[0].paths, ['/ws/notes/a.md', '/ws/notes/b.md'])
  assert.deepEqual(JSON.parse(res.body).value.versions, { '/ws/notes/a.md': 'v2', '/ws/notes/b.md': null })
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

test('GET /embed:query 透传,响应体是原始字节、不被 JSON 信封包住', async () => {
  const seen = []
  const { ctx, routes } = fakeCtx()
  installRoutes(ctx, {
    readEmbed: async (payload) => {
      seen.push(payload)
      return { bytes: Buffer.from('<!doctype html><title>demo</title>', 'utf8'), absolutePath: 'D:/ws/demo.html' }
    },
    tree: async () => ({}),
  })
  const handler = routes.get(`${ROUTE_PREFIX}/embed`)
  assert.equal(typeof handler, 'function', 'embed 路由应已注册')
  const res = fakeRes()
  await handler(
    fakeReq(
      'GET',
      `${ROUTE_PREFIX}/embed?sessionId=s-1&workspaceKey=k9&path=${encodeURIComponent('D:/ws/demo.html')}`,
    ),
    res,
  )
  assert.equal(res.status, 200)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].sessionId, 's-1')
  assert.equal(seen[0].workspaceKey, 'k9')
  assert.equal(seen[0].path, 'D:/ws/demo.html')
  assert.equal(res.headers['content-security-policy'], EMBED_CSP)
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(res.body, '<!doctype html><title>demo</title>')
})

test('GET /embed:CSP 必须放行内联脚本/样式、断网、且不带 allow-same-origin', () => {
  assert.equal(EMBED_CSP.includes('sandbox'), true)
  assert.equal(EMBED_CSP.includes("default-src 'none'"), true)
  assert.equal(EMBED_CSP.includes("script-src 'unsafe-inline'"), true)
  assert.equal(EMBED_CSP.includes("style-src 'unsafe-inline'"), true)
  assert.equal(EMBED_CSP.includes("connect-src 'none'"), true)
  assert.equal(EMBED_CSP.includes('allow-same-origin'), false, '沙箱不能给同源:演示页会拿到宿主权限')
})

test('GET /embed:失败回 HTML 错误页(不是 JSON),状态码按 code 映射', async () => {
  const { NotesError } = await import('../lib/service.js')
  const cases = [
    ['INVALID', 400],
    ['EMBED_OUTSIDE', 403],
    ['EMBED_DISABLED', 403],
    ['FS_PERMISSION_DENIED', 403],
    ['NOT_FOUND', 404],
    ['FS_TOO_LARGE', 413],
  ]
  for (const [code, status] of cases) {
    const { ctx, routes } = fakeCtx()
    installRoutes(ctx, {
      readEmbed: async () => {
        throw new NotesError('拒绝的原因', code)
      },
      tree: async () => ({}),
    })
    const res = fakeRes()
    await routes.get(`${ROUTE_PREFIX}/embed`)(fakeReq('GET', `${ROUTE_PREFIX}/embed?sessionId=s-1&path=x`), res)
    assert.equal(res.status, status, `${code} → HTTP ${status}`)
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(res.headers['content-security-policy'], EMBED_CSP)
    assert.equal(res.body.includes('无法显示这个网页演示'), true)
    assert.equal(res.body.includes('拒绝的原因'), true)
  }
})
