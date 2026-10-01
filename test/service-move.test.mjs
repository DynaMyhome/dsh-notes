import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NoteService } from '../lib/service.js'

/**
 * 造一个只够 `moveNote`/`collection(move)` 用的假 ctx。
 *
 * 这层测试专门用来兜住「路由/服务层引用了不存在的变量」这类错误:
 * 曾经 `moveNote` 的形参漏了 `index`、函数体却用了它 —— 拖动直接报
 * 「index is not defined」(用户截图里的红字),而纯 registry 单测完全测不到。
 */
function fakeContext(storeDir) {
  const session = { header: { cwd: '/ws' } }
  return {
    storeDir,
    ctx: {
      sessions: { get: (id) => (String(id) === 'session-1' ? session : undefined) },
      sandboxPolicy: { resolve: () => undefined },
      fs: {
        resolve: async (path) => ({ path }),
        stat: async () => undefined,
        readText: async () => '',
        writeText: async () => ({ version: 'v1' }),
        listDir: async () => [],
        watch: async () => async () => {},
      },
      logger: undefined,
      inject: () => () => {},
    },
  }
}

/** 建服务 + 一个工作区与三篇笔记。 */
async function setup() {
  const storeDir = await mkdtemp(join(tmpdir(), 'dsh-notes-test-'))
  const { ctx } = fakeContext(storeDir)
  const service = new NoteService(ctx, {
    notesDir: 'notes',
    assetsDir: '.dsh-assets',
    storeDir,
    storeScope: 'home',
    unfiledDepth: 3,
    scanTtlMs: 8000,
    unfiledMax: 200,
    autosaveMs: 800,
    pasteImage: 'copy',
    watch: false,
  })
  const workspace = await service.workspaceOf('session-1')
  const registry = await service.registryFor(workspace.key, { root: workspace.root, name: workspace.name })
  const mk = (title) => ({
    id: `n_${title}`,
    path: `/ws/notes/${title}.md`,
    workspaceKey: workspace.key,
    collectionId: null,
    title,
  })
  for (const title of ['A', 'B', 'D']) registry.addNote(mk(title))
  const collection = registry.createCollection(workspace.key, { name: 'C', parentId: null })
  const collectionId = collection?.id ?? Object.keys(registry.toJSON().workspaces[workspace.key].collections)[0]
  await service.persist(workspace.key)
  return { service, registry, workspace, collectionId, storeDir }
}

test('moveNote: 带 index 的同级排序可用(回归:形参漏了 index 会 ReferenceError)', async () => {
  const { service, registry, workspace, storeDir } = await setup()
  try {
    const titles = () => registry.siblingsOfNotes(workspace.key, null).map((note) => note.title)
    assert.deepEqual(titles(), ['A', 'B', 'D'])

    // 拖到最前
    await service.moveNote({ sessionId: 'session-1', noteId: 'n_D', collectionId: null, index: 0 })
    assert.deepEqual(titles(), ['D', 'A', 'B'])

    // 拖到 A 后面(下标按当前画面)
    await service.moveNote({ sessionId: 'session-1', noteId: 'n_D', collectionId: null, index: 2 })
    assert.deepEqual(titles(), ['A', 'D', 'B'])

    // 省略 index = 追加末尾
    await service.moveNote({ sessionId: 'session-1', noteId: 'n_A', collectionId: null })
    assert.deepEqual(titles(), ['D', 'B', 'A'])
  } finally {
    await rm(storeDir, { recursive: true, force: true })
  }
})

test('moveNote: 放进分类并排位;未知分类被拒', async () => {
  const { service, registry, workspace, collectionId, storeDir } = await setup()
  try {
    await service.moveNote({ sessionId: 'session-1', noteId: 'n_B', collectionId, index: 0 })
    assert.deepEqual(registry.siblingsOfNotes(workspace.key, collectionId).map((n) => n.title), ['B'])
    assert.deepEqual(registry.siblingsOfNotes(workspace.key, null).map((n) => n.title), ['A', 'D'])

    await assert.rejects(
      () => service.moveNote({ sessionId: 'session-1', noteId: 'n_A', collectionId: 'c_nope', index: 0 }),
      /目标分类不存在/,
    )
  } finally {
    await rm(storeDir, { recursive: true, force: true })
  }
})

test('collection(move): 带 index 的同级排序与嵌套', async () => {
  const { service, registry, workspace, storeDir } = await setup()
  try {
    await service.collection({ sessionId: 'session-1', op: 'create', name: 'C2' })
    await service.collection({ sessionId: 'session-1', op: 'create', name: 'C3' })
    const names = (parentId = null) =>
      registry.siblingsOfCollections(workspace.key, parentId).map((node) => node.name)
    assert.deepEqual(names(), ['C', 'C2', 'C3'])

    // C3 排到最前
    const c3 = registry.siblingsOfCollections(workspace.key, null).find((n) => n.name === 'C3')
    await service.collection({ sessionId: 'session-1', op: 'move', collectionId: c3.id, parentId: null, index: 0 })
    assert.deepEqual(names(), ['C3', 'C', 'C2'])
  } finally {
    await rm(storeDir, { recursive: true, force: true })
  }
})
