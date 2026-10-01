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
      'candidates',
      'include',
      'ignore',
      'unignore',
      'ignored',
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
      'migrate',
    ],
    description:
      '操作。tree=分类树摘要;list=笔记清单;unfiled=未归类的 md(整理用);register=把已存在的 md 纳入笔记树;unregister=只移除映射(不删文件);move=改归属;collection.*=分类树增删改;reference/unreference=跨工作区映射;rescan=按 dsh-note-id 重建映射;migrate=在「工作区内(.dsh-notes)」与「机器本地(registry.json)」两种存储之间**显式搬运**某个工作区(平时不需要)。',
  },
  paths: {
    type: 'array',
    items: { type: 'string' },
    description:
      'register / include / ignore / unignore 用:md 文件路径(绝对或相对工作区根)。' +
      'ignore 也接受**目录路径**(目录下所有 md 一起标为杂项);文件必须先由文件工具写好。',
  },
  globs: {
    type: 'array',
    items: { type: 'string' },
    description:
      'ignore 用:glob 模式(如 `docs/legacy/**`、`**/*.draft.md`)。命中的目录会在扫描时整棵剪掉,' +
      '属于"批量杂项";unignore 传同样的 glob 即撤销。',
  },
  folder: {
    type: 'string',
    description: 'candidates 用:只看某个目录前缀(工作区相对)。',
  },
  sort: {
    type: 'string',
    enum: ['recent', 'path'],
    description: 'candidates 用:按最近改动(默认)或路径排序。',
  },
  query: {
    type: 'string',
    description: 'candidates 用:路径/文件名子串过滤。',
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
  direction: {
    type: 'string',
    enum: ['toWorkspace', 'toHome'],
    description:
      'migrate 用:toWorkspace=把旧整体索引里的这个工作区搬进 `<工作区>/.dsh-notes/`(默认形态);' +
      'toHome=反过来,把工作区文件合并回 `$DSH_HOME/knowledge/registry.json`(工作区文件改名留档,不删)。',
  },
}

const DESCRIPTION = [
  '组织「笔记工作区」的索引:哪些 .md 属于笔记树、放在哪个分类、跨工作区映射。',
  '笔记就是普通 Markdown 文件;本工具只维护映射,不读写内容 —— 新建一篇笔记 = 先用 write 写到 tree 返回的 notesRoot 下,再 register/include。',
  '工作区里的 md 分三类:笔记(已纳入)/ 候选(未纳入、还没标记,op=candidates)/ 杂项(未纳入、已标记忽略,op=ignored)。',
  '地图要先摸清:op=candidates 看有哪些还没纳入的 md(可按 folder/sort/query 过滤),再决定 op=include 纳入还是 op=ignore(可带 globs)标为杂项;ignore 可被 op=unignore 撤销。',
  '文件级删除/移动/改名仍然归通用文件工具:本工具只动映射(unregister = 只移出笔记,不删文件;trash 由 UI 与文件工具负责)。',
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
    case 'candidates': {
      const tree = await service.tree({ sessionId })
      const found = await service.classify(tree.workspace.key, {
        query: args.query ?? '',
        sort: args.sort === 'path' ? 'path' : 'recent',
        folder: args.folder ?? '',
        limit,
      })
      return {
        workspace: found.workspace,
        notesRoot: tree.workspace.notesRoot,
        stats: found.stats,
        truncated: found.truncated,
        candidates: found.candidates.map((file) => ({
          path: file.path,
          relPath: file.relPath,
          title: file.title,
          hasNoteId: file.id !== null,
          bytes: file.bytes,
        })),
        hint: 'op=include paths=[…] 纳入;op=ignore paths=[…] 或 globs=[…] 标为杂项。',
      }
    }
    case 'include': {
      const paths = Array.isArray(args.paths) ? args.paths.slice(0, limit) : []
      if (paths.length === 0) throw new Error('include 需要 paths')
      const collectionId = emptyToNull(args.collectionId) ?? null
      const result = await service.includePaths({ sessionId, paths, collectionId })
      return {
        included: result.included.map((note) => ({ noteId: note.id, path: note.path, title: note.title })),
        failed: result.failed,
      }
    }
    case 'ignore':
    case 'unignore': {
      const paths = Array.isArray(args.paths) ? args.paths.slice(0, limit) : []
      const globs = Array.isArray(args.globs) ? args.globs.slice(0, limit) : []
      if (paths.length === 0 && globs.length === 0) throw new Error(`${args.op} 需要 paths 或 globs`)
      const on = args.op === 'ignore'
      const result = await service.ignorePaths({ sessionId, paths, globs, on })
      // 已经纳入的笔记被"忽略" = 移出笔记树(不动文件),否则它还会挂在树上
      if (on) {
        const tree = await service.tree({ sessionId })
        const wanted = new Set(paths.map((path) => String(path)))
        for (const note of tree.notes) {
          if (!wanted.has(note.path) && !wanted.has(note.relPath)) continue
          await service.unregister({ noteId: note.id })
        }
      }
      return { op: args.op, ignored: result.ignored, ignoredGlobs: result.ignoredGlobs, note: '只动映射,不删文件。' }
    }
    case 'ignored': {
      const tree = await service.tree({ sessionId })
      const found = await service.classify(tree.workspace.key, { limit })
      return {
        total: found.stats.ignored,
        globs: found.ignoredGlobs,
        files: found.ignored.map((file) => ({ path: file.path, relPath: file.relPath, title: file.title })),
        hint: 'op=unignore paths=[…] / globs=[…] 放回候选。',
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
      const found = await service.classify(tree.workspace.key, { force: true, limit })
      return {
        workspace: tree.workspace,
        stats: { ...tree.stats, workspaceFiles: found.stats.total },
        scanReport: tree.scanReport,
        candidates: found.stats.candidates,
        ignored: found.stats.ignored,
        truncated: found.truncated,
      }
    }
    case 'migrate': {
      const direction = String(args.direction ?? '').trim()
      if (direction !== 'toWorkspace' && direction !== 'toHome') {
        throw new Error('migrate 需要 direction:toWorkspace | toHome')
      }
      return service.migrateStore({ sessionId, direction, workspaceKey: args.workspaceKey })
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
