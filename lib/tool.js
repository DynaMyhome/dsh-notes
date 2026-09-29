/**
 * `knowledge` 工具:Agent 唯一的「笔记组织」入口。
 *
 * 边界(硬规则,写进描述里避免模型走错路):
 *   - 内容(读/写/改/搜)继续用既有文件工具;**本工具不碰内容**;
 *   - 文件级删除/移动/改名也归文件工具;本工具只改**映射**;
 *   - 输出有界,并在截断时显式说明。
 *
 * @module dsh-notes/tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

/** 一次返回的最大条目数(超出截断并标记)。 */
const PAGE_LIMIT = 50

/** 工具参数。 */
const PARAMETERS = {
  op: {
    type: 'string',
    required: true,
    enum: [
      'tree',
      'list',
      'unfiled',
      'register',
      'unregister',
      'move',
      'collection.create',
      'collection.rename',
      'collection.move',
      'collection.delete',
      'reference',
      'unreference',
      'rescan',
    ],
    description:
      '操作。tree=分类树摘要;list=笔记清单;unfiled=未归类的 md(整理用);register=把已存在的 md 纳入笔记树;unregister=只移除映射(不删文件);move=改归属;collection.*=分类树增删改;reference/unreference=跨工作区映射;rescan=按 dsh-note-id 重建映射。',
  },
  paths: {
    type: 'array',
    items: { type: 'string' },
    description: 'register 用:md 文件路径(绝对或相对工作区根)。文件必须先由文件工具写好。',
  },
  noteIds: {
    type: 'array',
    items: { type: 'string' },
    description: 'unregister / move / reference / unreference 用:笔记 id(来自 tree 或 list)。',
  },
  collectionId: {
    type: 'string',
    description: '目标分类 id;省略或传空串 = 未归类(树根)。',
  },
  collectionName: {
    type: 'string',
    description: 'collection.create / collection.rename 用:分类名。',
  },
  parentId: {
    type: 'string',
    description: 'collection.create / collection.move 用:父分类 id;省略 = 顶层。',
  },
  mode: {
    type: 'string',
    enum: ['move-to-parent', 'unfile'],
    description: 'collection.delete 用:子分类与笔记上提到父分类(默认),或把笔记留为未归类。',
  },
  limit: {
    type: 'number',
    description: `list / unfiled 用:返回条数上限(默认/最大 ${PAGE_LIMIT})。`,
  },
  sessionId: {
    type: 'string',
    description: '目标会话(决定工作区);省略 = 调用者所在会话。',
  },
}

const DESCRIPTION = [
  '组织「笔记工作区」的索引:哪些 .md 属于左栏笔记树、放在哪个分类、跨工作区映射。',
  '笔记就是普通 Markdown 文件;本工具只维护映射,不读写内容 —— 新建一篇笔记 = 先用 write 写到 tree 返回的 notesRoot 下,再 register。',
  '映射里没有的文件不会自动消失:它们出现在 unfiled(未归类)里,等一次整理。',
].join('')

/** 结构化输出的渲染:一行 JSON(字段即契约)。 */
const OUTPUT = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

/**
 * 注册工具。
 * @param ctx - Host 插件上下文(需要 tools)。
 * @param service - 笔记服务。
 */
export function installTool(ctx, service) {
  ctx.tools.register(
    defineTool({
      name: 'knowledge',
      description: DESCRIPTION,
      parameters: PARAMETERS,
      output: OUTPUT,
      async execute(args, exec) {
        const sessionId = args.sessionId ?? exec?.agent?.session?.id
        return run(service, args, sessionId)
      },
      presentCall: (args) => ({ card: 'generic', title: `笔记:${args.op}`, kind: 'read' }),
    }),
  )
}

/** 执行一个 op。 */
async function run(service, args, sessionId) {
  const limit = Math.max(1, Math.min(PAGE_LIMIT, Number(args.limit ?? PAGE_LIMIT) || PAGE_LIMIT))
  switch (args.op) {
    case 'tree': {
      const tree = await service.tree({ sessionId })
      return {
        workspace: tree.workspace,
        notesRoot: tree.workspace.notesRoot,
        collections: tree.collections,
        stats: tree.stats,
        refs: tree.refs.map((ref) => ({ noteId: ref.noteId, title: ref.title, from: ref.workspaceName })),
        hint: '新笔记写到 notesRoot 下,再用 op=register 纳入笔记树。',
      }
    }
    case 'list': {
      const tree = await service.tree({ sessionId })
      const collectionId = emptyToNull(args.collectionId)
      const rows = tree.notes.filter((note) => (collectionId === undefined ? true : note.collectionId === collectionId))
      return {
        total: rows.length,
        notes: rows.slice(0, limit).map((note) => ({
          noteId: note.id,
          title: note.title,
          path: note.path,
          collectionId: note.collectionId,
        })),
        truncated: rows.length > limit,
      }
    }
    case 'unfiled': {
      const tree = await service.tree({ sessionId })
      return {
        total: tree.unfiled.length,
        truncatedScan: tree.unfiledTruncated,
        notesRoot: tree.workspace.notesRoot,
        files: tree.unfiled.slice(0, limit).map((file) => ({
          path: file.path,
          relPath: file.relPath,
          title: file.title,
          hasNoteId: file.id !== null,
        })),
      }
    }
    case 'register': {
      const paths = Array.isArray(args.paths) ? args.paths.slice(0, limit) : []
      if (paths.length === 0) throw new Error('register 需要 paths')
      const collectionId = emptyToNull(args.collectionId) ?? null
      const registered = []
      const failed = []
      for (const path of paths) {
        try {
          const note = await service.register({ sessionId, path, collectionId })
          registered.push({ noteId: note.id, path: note.path, title: note.title })
        } catch (error) {
          failed.push({ path, error: error?.message ?? String(error) })
        }
      }
      return { registered, failed }
    }
    case 'unregister': {
      const noteIds = Array.isArray(args.noteIds) ? args.noteIds.slice(0, limit) : []
      if (noteIds.length === 0) throw new Error('unregister 需要 noteIds')
      const removed = []
      const failed = []
      for (const noteId of noteIds) {
        try {
          await service.unregister({ noteId })
          removed.push(noteId)
        } catch (error) {
          failed.push({ noteId, error: error?.message ?? String(error) })
        }
      }
      return { removed, failed, note: '只移除了映射,文件仍在磁盘上。' }
    }
    case 'move': {
      const noteIds = Array.isArray(args.noteIds) ? args.noteIds.slice(0, limit) : []
      if (noteIds.length === 0) throw new Error('move 需要 noteIds')
      const collectionId = emptyToNull(args.collectionId) ?? null
      const moved = []
      const failed = []
      for (const noteId of noteIds) {
        try {
          await service.moveNote({ noteId, collectionId })
          moved.push(noteId)
        } catch (error) {
          failed.push({ noteId, error: error?.message ?? String(error) })
        }
      }
      return { moved, collectionId, failed }
    }
    case 'collection.create':
    case 'collection.rename':
    case 'collection.move':
    case 'collection.delete': {
      const op = args.op.slice('collection.'.length)
      const result = await service.collection({
        sessionId,
        op,
        collectionId: emptyToNull(args.collectionId),
        name: args.collectionName,
        parentId: emptyToNull(args.parentId) ?? null,
        mode: args.mode,
      })
      const tree = await service.tree({ sessionId, force: true })
      return { op: `collection.${op}`, collection: result ?? null, collections: tree.collections }
    }
    case 'reference': {
      const noteIds = Array.isArray(args.noteIds) ? args.noteIds.slice(0, limit) : []
      if (noteIds.length === 0) throw new Error('reference 需要 noteIds(别的工作区里的笔记 id)')
      const collectionId = emptyToNull(args.collectionId) ?? null
      for (const noteId of noteIds) await service.reference({ sessionId, noteId, collectionId })
      return { referenced: noteIds }
    }
    case 'unreference': {
      const noteIds = Array.isArray(args.noteIds) ? args.noteIds.slice(0, limit) : []
      if (noteIds.length === 0) throw new Error('unreference 需要 noteIds')
      for (const noteId of noteIds) await service.unreference({ sessionId, noteId })
      return { unreferenced: noteIds }
    }
    case 'rescan': {
      const tree = await service.tree({ sessionId, force: true })
      return { workspace: tree.workspace, stats: tree.stats }
    }
    default:
      throw new Error(`不认识的 op:${args.op}`)
  }
}

/** 空串/缺省 → undefined(表示「未归类」时另有 `?? null` 兜底)。 */
function emptyToNull(value) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  return text === '' ? undefined : text
}
