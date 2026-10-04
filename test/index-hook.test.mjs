import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

/**
 * `lib/index.js` 的装配契约(端到端,不 mock 业务逻辑)。
 *
 * 这里锁的是**写前钩子那条直通 agent 写入的路径**,三条纪律一条都不能破:
 *   1. 钩子注册在 `tools/execute` 上,`write`/`edit` 落盘**之前**跑;
 *   2. **无论快照成功、失败还是超时,都必须 `return next()`** —— 在 `next()` 之前抛错
 *      会被 tools 的调度层变成工具失败,等于**打断 agent 的写入**(最严重的一种回归);
 *   3. 钩子只读、只写 `.dsh-notes/.history/`,不碰 `exec`,不改工具结果。
 *
 * 顺带端到端验一遍"钩子 → 路由 → 恢复"这条链(不经过任何 mock 的业务逻辑)。
 */

/** 内容哈希当版本号(与真 provider 的守卫语义一致)。 */
function versionOf(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 12)
}

/** ctx:sessionId → 工作区 cwd;fs 落到真目录(listDir/版本都按内容算)。 */
function realContext(root) {
  const session = { header: { cwd: root } }
  return {
    sessions: { get: (id) => (String(id) === 'session-1' ? session : undefined) },
    sandboxPolicy: { resolve: () => undefined },
    fs: {
      resolve: async (path) => ({ path: String(path) }),
      processPath: (target) => String(target?.path ?? target),
      stat: async (target) => {
        try {
          const value = await stat(target.path)
          if (value.isDirectory()) return { type: 'directory', version: 'dir', size: 0 }
          const text = await readFile(target.path, 'utf8')
          return { type: 'file', version: versionOf(text), size: value.size }
        } catch {
          return undefined
        }
      },
      readText: async (target) => readFile(target.path, 'utf8'),
      readByteRange: async (target, range) => {
        const value = await readFile(target.path)
        return value.subarray(range.offset, range.offset + range.length)
      },
      writeText: async (target, text) => {
        await writeFile(target.path, text, 'utf8')
        return { version: versionOf(text) }
      },
      listDir: async (target) => {
        const entries = await readdir(target.path, { withFileTypes: true })
        return Promise.all(
          entries.map(async (entry) => {
            let version = ''
            let size = 0
            try {
              const info = await stat(join(target.path, entry.name))
              size = info.size
              version = entry.isDirectory() ? 'dir' : versionOf(await readFile(join(target.path, entry.name), 'utf8'))
            } catch {
              version = ''
            }
            return {
              name: entry.name,
              type: entry.isDirectory() ? 'directory' : 'file',
              target: { path: join(target.path, entry.name) },
              version,
              size,
            }
          }),
        )
      },
      watch: async () => async () => {},
    },
    logger: undefined,
    inject: () => () => {},
  }
}

/** 极简 ctx:捕获 `tools/execute` 监听者、`knowledge` 工具定义、路由 handler。 */
function fakeCtx() {
  const hooks = []
  const routes = new Map()
  let tool = null
  const effects = []
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, debug: () => {} }),
    tools: {
      register: (definition) => {
        tool = definition
        return () => {}
      },
    },
    on: (name, listener) => {
      if (name === 'tools/execute') hooks.push(listener)
      return () => {}
    },
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
    effect: (fn) => {
      const dispose = fn()
      effects.push(dispose)
      return () => {}
    },
  }
  return { ctx, hooks, routes, tool: () => tool, effects }
}

/** 极简 req / res(与 test/routes.test.mjs 同款)。 */
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

/** 调一条路由,返回解开的 `value`。 */
async function callRoute(routes, path, { method = 'POST', body } = {}) {
  const res = fakeRes()
  const url = method === 'GET' && body !== undefined ? `${path}?${body}` : path
  await routes.get(path)(fakeReq(method, url, method === 'GET' ? undefined : JSON.stringify(body ?? {})), res)
  const envelope = JSON.parse(res.body)
  if (envelope.ok !== true) throw Object.assign(new Error(envelope.error), { code: envelope.code })
  return envelope.value
}

const FRONT = '---\ndsh-note-id: n_jia\n---\n\n# 甲\n\n'
const V1 = `${FRONT}一\n`
const V2 = `${FRONT}二\n`

async function setup(config = {}) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-index-'))
  const root = join(base, 'ws')
  await mkdir(join(root, 'notes'), { recursive: true })
  const file = join(root, 'notes', '甲.md')
  await writeFile(file, V1, 'utf8')
  const { ctx, hooks, routes, tool, effects } = fakeCtx()
  const context = realContext(root)
  ctx.sessions = context.sessions
  ctx.sandboxPolicy = context.sandboxPolicy
  ctx.fs = context.fs
  apply(ctx, {
    notesDir: 'notes',
    assetsDir: '.dsh-assets',
    storeDir: join(base, 'store'),
    storeScope: 'workspace',
    scanTtlMs: 8000,
    unfiledDepth: 3,
    unfiledMax: 200,
    autosaveMs: 800,
    pasteImage: 'copy',
    watch: false,
    history: true,
    historyMaxPerNote: 50,
    ...config,
  })
  return { base, root, file, hooks, routes, tool, effects, fs: context.fs }
}

async function cleanup(base, effects) {
  for (const dispose of effects) {
    try {
      if (typeof dispose === 'function') dispose()
    } catch {
      /* 收尾忽略 */
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 200))
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

test('装配:注册了 tools/execute 钩子与 knowledge 工具,钩子必须放行 next()', async () => {
  const { base, hooks, tool, effects } = await setup()
  try {
    assert.equal(hooks.length, 1, '必须注册一个 tools/execute 监听者')
    assert.notEqual(tool(), null, 'knowledge 工具也要照常注册')
    assert.equal(tool().name, 'knowledge')

    // 非目标工具:直接放行,不读盘
    let calls = 0
    const sentinel = { isError: false, value: { ok: true }, content: [] }
    const result = await hooks[0]({ name: 'read', arguments: { file_path: 'x.md' }, agent: { id: 'session-1' } }, async () => {
      calls += 1
      return sentinel
    })
    assert.equal(calls, 1, 'next() 必须被调用一次')
    assert.equal(result, sentinel, 'next() 的结果必须原样透出(不能包装/替换)')
  } finally {
    await cleanup(base, effects)
  }
})

test('写前钩子 + 路由:agent 改笔记前后各留一份,撤销能精确回到改之前', async () => {
  const { base, file, hooks, routes, tool, effects } = await setup()
  try {
    // ① 通过 knowledge 工具纳入(顺带建立基线)
    const registered = await tool().execute({ op: 'register', paths: [file], sessionId: 'session-1' }, {})
    assert.equal(registered.registered.length, 1)
    const noteId = registered.registered[0].noteId

    // ② 模拟 agent 的 write:钩子先跑(读改前),再真正落盘
    let calls = 0
    const next = async () => {
      calls += 1
      return { isError: false, value: null, content: [] }
    }
    await hooks[0]({ name: 'write', arguments: { file_path: file }, agent: { id: 'session-1' } }, next)
    await writeFile(file, V2, 'utf8')

    assert.equal(calls, 1, '快照跑完必须放行 next()')
    const listed = await callRoute(routes, '/dsh-notes/history', {
      method: 'GET',
      body: new URLSearchParams({ sessionId: 'session-1', noteId }).toString(),
    })
    // 写前钩子读到的是 V1,而登记基线也是 V1 —— 内容 hash 去重,所以只有**一条**基线。
    // 这正是"不要生成重复条目"的意思:内容相同就不该再记一份。
    assert.deepEqual(listed.entries.map((item) => item.origin), ['baseline'])
    const before = await callRoute(routes, '/dsh-notes/history/read', {
      method: 'GET',
      body: new URLSearchParams({ sessionId: 'session-1', noteId, file: listed.entries[0].file }).toString(),
    })
    assert.equal(before.text, V1, '这条基线就是"改动之前"的那一份内容')

    // ③ 一键撤销:磁盘是 V2 → 回到 V1
    const undone = await callRoute(routes, '/dsh-notes/history/undo-external', {
      body: { sessionId: 'session-1', noteId },
    })
    assert.equal(undone.text, V1)
    assert.equal(await readFile(file, 'utf8'), V1, '磁盘要真的回到改之前')

    // ④ 恢复本身也留了一条(恢复前的 V2),所以还能再退回去
    const after = await callRoute(routes, '/dsh-notes/history', {
      method: 'GET',
      body: new URLSearchParams({ sessionId: 'session-1', noteId }).toString(),
    })
    assert.equal(after.entries[0].origin, 'restore')
  } finally {
    await cleanup(base, effects)
  }
})

test('钩子读盘失败也必须放行 next()(绝不能打断 agent 的写入)', async () => {
  const { base, file, hooks, tool, fs, effects } = await setup()
  try {
    // 先正常登记(登记本身要读盘建基线)
    await tool().execute({ op: 'register', paths: [file], sessionId: 'session-1' }, {})
    // 再让 provider 在读正文时炸掉:钩子必须自己吃掉异常
    fs.readText = async () => {
      throw new Error('provider 挂了')
    }
    let calls = 0
    const result = await hooks[0]({ name: 'write', arguments: { file_path: file }, agent: { id: 'session-1' } }, async () => {
      calls += 1
      return { isError: false, value: { written: true }, content: [] }
    })
    assert.equal(calls, 1, '快照读失败也必须放行 next()')
    assert.deepEqual(result.value, { written: true }, '工具结果不能被改写')
  } finally {
    await cleanup(base, effects)
  }
})

test('history:false 时钩子一次盘都不碰(逃生开关)', async () => {
  const { base, hooks, routes, tool, effects } = await setup({ history: false })
  try {
    const registered = await tool().execute(
      { op: 'register', paths: [join(base, 'ws', 'notes', '甲.md')], sessionId: 'session-1' },
      {},
    )
    const noteId = registered.registered[0].noteId
    let calls = 0
    await hooks[0](
      { name: 'write', arguments: { file_path: join(base, 'ws', 'notes', '甲.md') }, agent: { id: 'session-1' } },
      async () => {
        calls += 1
        return { isError: false, value: null, content: [] }
      },
    )
    assert.equal(calls, 1, '关掉历史也要放行')
    const listed = await callRoute(routes, '/dsh-notes/history', {
      method: 'GET',
      body: new URLSearchParams({ sessionId: 'session-1', noteId }).toString(),
    })
    assert.equal(listed.entries.length, 0, '关掉历史就不该有任何条目(连基线都不记)')
  } finally {
    await cleanup(base, effects)
  }
})
