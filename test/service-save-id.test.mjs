import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NoteService } from '../lib/service.js'
import { frontmatterRange } from '../lib/notes.js'

/**
 * 保存时的**身份自愈**:预览模式里 frontmatter 是收起来的,用户可能整段删掉/改错。
 * 只要索引里有 id,保存就按索引写回 —— 否则笔记失去身份,改名/移动后就认不出来了。
 */

function realContext(root) {
  const session = { header: { cwd: root } }
  return {
    sessions: { get: (id) => (String(id) === 'session-1' ? session : undefined) },
    sandboxPolicy: { resolve: () => undefined },
    fs: {
      resolve: async (path) => ({ path }),
      processPath: (target) => String(target?.path ?? target),
      stat: async (target) => {
        try {
          const value = await stat(target.path)
          return { type: value.isDirectory() ? 'directory' : 'file', version: String(value.mtimeMs) }
        } catch {
          return undefined
        }
      },
      readText: async (target) => readFile(target.path, 'utf8'),
      writeText: async (target, text) => {
        await writeFile(target.path, text, 'utf8')
        return { version: String((await stat(target.path)).mtimeMs) }
      },
      listDir: async (target) => (await readdir(target.path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        target: { path: join(target.path, entry.name) },
      })),
      watch: async () => async () => {},
    },
    logger: undefined,
    inject: () => () => {},
  }
}

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-notes-saveid-'))
  const root = join(base, 'ws')
  await mkdir(join(root, 'notes'), { recursive: true })
  const file = join(root, 'notes', '甲.md')
  await writeFile(file, '---\ndsh-note-id: n_jia\n---\n\n# 甲\n', 'utf8')
  const service = new NoteService(realContext(root), {
    notesDir: 'notes',
    assetsDir: '.dsh-assets',
    storeDir: join(base, 'store'),
    scanTtlMs: 8000,
    unfiledMax: 200,
    autosaveMs: 800,
    pasteImage: 'copy',
    watch: false,
  })
  return { base, root, file, service }
}

test('保存自愈:frontmatter 被整段删掉 → 按索引写回 id,并告知界面', async () => {
  const { base, root, file, service } = await setup()
  try {
    const note = await service.register({ sessionId: 'session-1', path: file })
    assert.equal(note.id, 'n_jia')

    const info = await service.ctx.fs.stat({ path: file })
    const result = await service.save({
      sessionId: 'session-1',
      path: file,
      text: '# 甲\n\n用户把 frontmatter 删了\n',
      expectedVersion: info.version,
    })
    assert.equal(result.restoredId, true, '要告诉界面"我替你恢复了"')
    const onDisk = await readFile(file, 'utf8')
    assert.match(onDisk, /dsh-note-id: n_jia/, '磁盘上必须仍有原 id')
    assert.match(onDisk, /用户把 frontmatter 删了/)
    assert.equal(result.text, onDisk, '响应里带回最终写盘内容,界面据此同步')
  } finally {
    service.dispose()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('保存自愈:id 被改成别的值 → 改回索引里的 id;没被改则字节不变', async () => {
  const { base, file, service } = await setup()
  try {
    await service.register({ sessionId: 'session-1', path: file })

    let info = await service.ctx.fs.stat({ path: file })
    const changed = await service.save({
      sessionId: 'session-1',
      path: file,
      text: '---\ndsh-note-id: n_别人的id\n---\n\n正文\n',
      expectedVersion: info.version,
    })
    assert.equal(changed.restoredId, true)
    assert.match(await readFile(file, 'utf8'), /dsh-note-id: n_jia/)

    // id 完好 → 原样保存
    info = await service.ctx.fs.stat({ path: file })
    const text = '---\ndsh-note-id: n_jia\n---\n\n正文改一下\n'
    const clean = await service.save({ sessionId: 'session-1', path: file, text, expectedVersion: info.version })
    assert.equal(clean.restoredId, false)
    assert.equal(await readFile(file, 'utf8'), text)
  } finally {
    service.dispose()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('frontmatterRange:只认文件最开头那一段', () => {
  assert.deepEqual(frontmatterRange('---\na: 1\n---\n正文'), { from: 0, to: 12, body: 'a: 1' })
  assert.equal(frontmatterRange('正文\n---\na: 1\n---\n'), null, '不在开头就不算 frontmatter')
  assert.equal(frontmatterRange('# 标题\n'), null)
  assert.equal(frontmatterRange(''), null)
  // 收尾 `---` 之后不含换行 → 整块替换时把换行留给下一行
  assert.equal(frontmatterRange('---\nid: x\n---\nrest').to, 13)
})
