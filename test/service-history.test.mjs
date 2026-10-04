import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NoteService } from '../lib/service.js'

/**
 * 历史快照的**服务层**靶子(真临时目录 + 真 listDir)。
 *
 * 核心场景(用户原话):agent 在一次扫描周期里连写 `V1→V2→V3→V4` —— 只靠扫描只能
 * 看到首尾,中间状态会丢。写前钩子(`tools/execute` → `captureBeforeToolWrite`)
 * 在每次落盘**之前**读走"即将被覆盖的内容",所以:
 *   - 历史里有 V1/V2/V3 三份(一个中间状态都不丢);
 *   - 「撤销最近一次外部改动」精确回到 V3(靠 entry 的 `version`,不是"倒数第二条");
 *   - 扫描仍然兜住**不经工具**的写入(Obsidian / vim / bash),但稳态下零额外读取。
 */

/** 内容哈希当版本号:内容不变则版本不变(与真 provider 的守卫语义一致,且不受时钟影响)。 */
function versionOf(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 12)
}

/** ctx:sessionId → 工作区 cwd,fs 落到真目录(listDir/版本都按**内容**算)。 */
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

const FRONT = '---\ndsh-note-id: n_jia\n---\n\n# 甲\n\n'
const V1 = `${FRONT}一\n`
const V2 = `${FRONT}二\n`
const V3 = `${FRONT}三\n`
const V4 = `${FRONT}四\n`

async function cleanup(base, service) {
  service.dispose()
  await new Promise((resolve) => setTimeout(resolve, 200))
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

async function setup(initial = V1) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-history-'))
  const root = join(base, 'ws')
  await mkdir(join(root, 'notes'), { recursive: true })
  const file = join(root, 'notes', '甲.md')
  await writeFile(file, initial, 'utf8')
  const service = new NoteService(realContext(root), {
    notesDir: 'notes',
    assetsDir: '.dsh-assets',
    storeDir: join(base, 'store'),
    scanTtlMs: 8000,
    unfiledMax: 200,
    autosaveMs: 800,
    pasteImage: 'copy',
    watch: false,
    history: true,
    historyMaxPerNote: 50,
  })
  await service.register({ sessionId: 'session-1', path: file })
  return { base, root, file, service }
}

/** 读历史条目的正文(从新到旧)。 */
async function historyTexts(service, noteId = 'n_jia') {
  const listed = await service.listHistory({ sessionId: 'session-1', noteId })
  const out = []
  for (const entry of listed.entries) {
    const read = await service.readHistoryEntry({ sessionId: 'session-1', noteId, file: entry.file })
    out.push({ text: read.text, origin: entry.origin, version: entry.version })
  }
  return out
}

test('agent 连写 V1→V2→V3→V4:中间状态一个都不丢,撤销精确回到"这次修改之前"', async () => {
  const { base, file, service } = await setup(V1)
  try {
    // 模拟 agent 的三次 write:每次都先跑钩子(读改前),再真正落盘
    for (const text of [V2, V3, V4]) {
      await service.captureBeforeToolWrite({ name: 'write', arguments: { file_path: file }, agent: { id: 'session-1' } })
      await writeFile(file, text, 'utf8')
    }
    const entries = await historyTexts(service)
    assert.deepEqual(
      entries.map((item) => item.text),
      [V3, V2, V1],
      '从新到旧:V3 / V2 / V1(写前快照 + 登记基线;V4 是当前磁盘内容,不需要进历史)',
    )
    assert.deepEqual(entries.map((item) => item.origin), ['agent', 'agent', 'baseline'])

    // 一键撤销:磁盘是 V4 → 必须回到 V3(不是"倒数第二条"这种位置规则)
    const undone = await service.undoExternal({ sessionId: 'session-1', noteId: 'n_jia' })
    assert.equal(undone.text, V3)
    assert.equal(await readFile(file, 'utf8'), V3, '磁盘也要真的回到 V3')

    // 恢复本身也留了一条(恢复前的 V4) → 点错了还能再退回去
    const after = await historyTexts(service)
    assert.equal(after[0].origin, 'restore')
    assert.equal(after[0].text, V4)
  } finally {
    await cleanup(base, service)
  }
})

test('写前钩子:同一份内容反复看到只留一条(去重,不生成重复条目)', async () => {
  const { base, file, service } = await setup(V1)
  try {
    await service.captureBeforeToolWrite({ name: 'write', arguments: { file_path: file }, agent: { id: 'session-1' } })
    await service.captureBeforeToolWrite({ name: 'write', arguments: { file_path: file }, agent: { id: 'session-1' } })
    await service.captureBeforeToolWrite({ name: 'edit', arguments: { file_path: file }, agent: { id: 'session-1' } })
    const entries = await historyTexts(service)
    assert.equal(entries.length, 1, '内容没变(还是基线那份 V1)就不该再记')
    assert.equal(entries[0].origin, 'baseline')
  } finally {
    await cleanup(base, service)
  }
})

test('写前钩子:非目标一律直接返回,读盘异常也只当"这次没记"', async () => {
  const { base, root, file, service } = await setup(V1)
  try {
    const outside = join(base, 'outside.md')
    await writeFile(outside, '# 外面\n', 'utf8')
    const unregistered = join(root, 'notes', '没登记.md')
    await writeFile(unregistered, '# 没登记\n', 'utf8')
    const notMarkdown = join(root, 'notes', '说明.txt')
    await writeFile(notMarkdown, 'x', 'utf8')
    const hook = (exec) => service.captureBeforeToolWrite(exec)
    const agent = { id: 'session-1' }

    assert.equal(await hook({ name: 'read', arguments: { file_path: file }, agent }), null, 'read 不拦')
    assert.equal(await hook({ name: 'bash', arguments: { command: 'echo x > 甲.md' }, agent }), null, 'bash 不拦(交给扫描兜底)')
    assert.equal(await hook({ name: 'write', arguments: { file_path: notMarkdown }, agent }), null, '非 markdown 不拦')
    assert.equal(await hook({ name: 'write', arguments: { file_path: outside }, agent }), null, '工作区外不拦')
    assert.equal(await hook({ name: 'write', arguments: { file_path: unregistered }, agent }), null, '未登记的笔记不进历史')
    assert.equal(await hook({ name: 'write', arguments: { file_path: join(root, 'notes', '不存在.md') }, agent }), null, '新建文件没有"改前"')
    assert.equal(await hook({ name: 'edit', arguments: {}, agent }), null, '没有 file_path')
    assert.equal(await hook({ name: 'write', arguments: { file_path: file } }), null, '没有 agent(拿不到会话)')
    assert.equal(await hook({ name: 'write', arguments: { file_path: file }, agent: { id: 'nope' } }), null, '会话解析不出工作区')

    // provider 挂了:钩子必须自己吃掉异常(绝不能把 agent 的写入带崩)
    const broken = service.ctx.fs.readText
    service.ctx.fs.readText = async () => {
      throw new Error('provider 挂了')
    }
    assert.equal(await hook({ name: 'write', arguments: { file_path: file }, agent }), null)
    service.ctx.fs.readText = broken
  } finally {
    await cleanup(base, service)
  }
})

test('扫描兜底:不经工具的改动(Obsidian / vim / bash)也会被记下来,且稳态零重复', async () => {
  const { base, file, service } = await setup(V1)
  try {
    await writeFile(file, V2, 'utf8') // 没有钩子:外部编辑器直接改
    await service.tree({ sessionId: 'session-1', force: true })
    const entries = await historyTexts(service)
    assert.deepEqual(entries.map((item) => item.text), [V2, V1], '当前状态被扫描观察到,基线还在')
    assert.equal(entries[0].origin, 'external')

    // 再扫一次:版本没变 → 一条都不该多
    await service.tree({ sessionId: 'session-1', force: true })
    assert.equal((await historyTexts(service)).length, 2, '稳态下扫描不该产生重复条目')

    // 这次也能回退:当前 V2 → 基线 V1
    const undone = await service.undoExternal({ sessionId: 'session-1', noteId: 'n_jia' })
    assert.equal(undone.text, V1)
    assert.equal(await readFile(file, 'utf8'), V1)
  } finally {
    await cleanup(base, service)
  }
})

test('恢复:文件名必须合法(防目录穿越);写盘撞上外部改动 → FS_STALE_VERSION', async () => {
  const { base, file, service } = await setup(V1)
  try {
    await assert.rejects(
      () => service.readHistoryEntry({ sessionId: 'session-1', noteId: 'n_jia', file: '../../secret.md' }),
      (error) => error.code === 'INVALID',
    )
    await assert.rejects(
      () => service.readHistoryEntry({ sessionId: 'session-1', noteId: 'n_jia', file: 'n_other/1.md' }),
      (error) => error.code === 'INVALID',
    )
    const listed = await service.listHistory({ sessionId: 'session-1', noteId: 'n_jia' })
    assert.equal(listed.entries.length, 1, '登记基线')

    // 写盘时磁盘已被别人改过(provider 报 STALE)→ 必须如实报冲突,不覆盖
    const write = service.ctx.fs.writeText
    service.ctx.fs.writeText = async () => {
      const error = new Error('文件已被外部修改')
      error.code = 'FS_STALE_VERSION'
      throw error
    }
    await assert.rejects(
      () => service.restoreHistory({ sessionId: 'session-1', noteId: 'n_jia', file: listed.entries[0].file }),
      (error) => error.code === 'FS_STALE_VERSION',
    )
    service.ctx.fs.writeText = write
    assert.equal(await readFile(file, 'utf8'), V1, '冲突时磁盘一个字都不许动')
  } finally {
    await cleanup(base, service)
  }
})

test('超大笔记不进历史(上限之内才记)', async () => {
  const { base, root, service } = await setup(V1)
  try {
    const big = join(root, 'notes', '大文件.md')
    const body = `---\ndsh-note-id: n_big\n---\n\n# 大\n\n${'x'.repeat(2 * 1024 * 1024 + 1024)}\n`
    await writeFile(big, body, 'utf8')
    await service.register({ sessionId: 'session-1', path: big })
    assert.equal(
      (await service.listHistory({ sessionId: 'session-1', noteId: 'n_big' })).entries.length,
      0,
      '超过单条上限的笔记不记(读都不读)',
    )
    assert.equal(
      await service.captureBeforeToolWrite({ name: 'write', arguments: { file_path: big }, agent: { id: 'session-1' } }),
      null,
    )
  } finally {
    await cleanup(base, service)
  }
})
