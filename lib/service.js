/**
 * NoteService:索引 + 磁盘之间的那一层(ctx 绑定)。
 *
 * 职责:
 *   - 把 `sessionId` 解析成工作区根,并给每个工作区一棵分类树(索引按工作区键隔离);
 *   - 受限扫描笔记根,做「按 dsh-note-id 重绑 / 丢条目」对账;
 *   - 提供 register / unregister / move / reference / collection.* / createNote / save / tree;
 *   - 守卫式写入(带 expectedVersion)+ 文件监视。
 *
 * 硬规则(见 AGENTS.md):**只做三种写入** —— 保存笔记内容、新建笔记文件、写资产文件。
 * 永不删除、永不移动用户的 .md;`unregister` 只删索引条目。
 *
 * 用户文件一律走 `ctx.fs`(尊重文件策略与版本号);索引与二进制资产走 node:fs
 * —— 组合 fs 没有 `mkdir`,也没有写字节的接口,这两处是刻意的例外。
 *
 * @module dsh-notes/service
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  assetFileName,
  baseName,
  dirOf,
  looksLikeMarkdown,
  mintNoteId,
  mintFrontmatter,
  normalizePath,
  readNoteId,
  relativePath,
  sanitizeFileName,
  SKIP_DIRS,
  titleOf,
  workspaceKeyOf,
} from './notes.js'
import { NoteRegistry, stateFromJSON } from './registry.js'

/** 失败时带明确 code 的插件错误(路由据此定 HTTP 状态)。 */
export class NotesError extends Error {
  /**
   * @param message - 面向用户的说明。
   * @param code - 机器可读代码。
   * @param details - 追加字段(如冲突时的 currentVersion)。
   */
  constructor(message, code = 'NOTES_ERROR', details = {}) {
    super(message)
    this.name = 'NotesError'
    this.code = code
    Object.assign(this, details)
  }
}

/** 扫描一个目录树时的文件数硬上限(防止把大库拖死)。 */
const SCAN_FILE_CAP = 400
/** 单个文件参与 id 解析的最大字节数(超出只当未归类候选)。 */
const ID_SCAN_MAX_BYTES = 1024 * 1024
/** 同一工作区两次自动扫描之间的冷却(毫秒)。 */
const SCAN_COOLDOWN_MS = 3000
/** 监视去抖(毫秒)。 */
const WATCH_DEBOUNCE_MS = 400

/** 笔记服务。 */
export class NoteService {
  /**
   * @param ctx - 插件上下文(需要 fs)。
   * @param config - 插件配置。
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-notes') : undefined
    this.registry = null
    this.loading = null
    this.persistChain = Promise.resolve()
    /** workspaceKey → { at, result }:扫描结果的短缓存(冷却期内直接复用)。 */
    this.scans = new Map()
    /** 绝对路径 → watcher disposer。 */
    this.watchers = new Map()
    this.abort = new AbortController()
    this.dirty = new Set()
    this.flushTimer = null
    /** 变更通知(客户端 SSE / 轮询用)。 */
    this.onChanged = null
  }

  /* ------------------------------------------------------------------ */
  /* 索引文件                                                            */
  /* ------------------------------------------------------------------ */

  /** 索引文件路径。 */
  storeFile() {
    const configured = String(this.config.storeDir ?? '').trim()
    const base = configured !== '' ? configured : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'knowledge')
    return join(base, 'registry.json')
  }

  /** 装载(损坏则备份后空启动)。 */
  async ensureLoaded() {
    if (this.registry !== null) return this.registry
    if (this.loading !== null) return this.loading
    this.loading = (async () => {
      const file = this.storeFile()
      try {
        const text = await readFile(file, 'utf8')
        this.registry = new NoteRegistry(stateFromJSON(text))
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          const backup = `${file}.bad-${Date.now()}`
          try {
            await rename(file, backup)
          } catch {
            /* 备份失败也要能启动 */
          }
          this.logger?.warn?.('[dsh-notes] 索引损坏,已备份到 %s:%s', backup, error?.message ?? error)
        }
        this.registry = new NoteRegistry()
      }
      return this.registry
    })()
    return this.loading
  }

  /** 串行落盘(临时文件 + rename 原子替换)。 */
  persist() {
    this.persistChain = this.persistChain.then(async () => {
      const file = this.storeFile()
      await mkdir(dirOfNative(file), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}`
      await writeFile(tmp, `${JSON.stringify(this.registry.toJSON(), null, 2)}\n`, 'utf8')
      await rename(tmp, file)
    })
    return this.persistChain
  }

  /* ------------------------------------------------------------------ */
  /* 工作区                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * 解析会话的工作区(根 = 会话 cwd)。
   *
   * **必须给 sessionId**:给不出会话就不知道笔记属于哪个工作区,宁可报错。
   * 早期版本在解析不出 cwd 时退回进程 cwd,结果是**把笔记写到了 `/home/phyd/notes`**
   * —— 静默失败里最糟的一种。现在两种缺法(没给 / 给了但 cwd 缺失)都直接报错。
   * @param sessionId - 会话 id(必填)。
   * @returns `{ key, root, name, notesRoot }`。
   */
  resolveWorkspace(sessionId) {
    const id = sessionId === undefined || sessionId === null ? '' : String(sessionId).trim()
    if (id === '') throw new NotesError('缺少 sessionId:无法确定笔记属于哪个工作区', 'WORKSPACE_UNAVAILABLE')
    let cwd
    try {
      const live = this.ctx.sessions?.get?.(id)
      cwd = live?.header?.cwd
    } catch {
      cwd = undefined
    }
    if (typeof cwd !== 'string' || cwd === '') {
      throw new NotesError(`无法解析会话 ${id} 的工作区(cwd 缺失)`, 'WORKSPACE_UNAVAILABLE')
    }
    const root = normalizePath(cwd)
    const notesRoot = normalizePath(join(root, this.config.notesDir))
    return { key: workspaceKeyOf(root), root, name: baseName(root) || root, notesRoot }
  }

  /** @returns 工作区信息 + 索引节点。 */
  async workspaceOf(sessionId) {
    const registry = await this.ensureLoaded()
    const info = this.resolveWorkspace(sessionId)
    const node = registry.workspace(info.key, { root: info.root, name: info.name, notesRoot: info.notesRoot })
    return { ...info, node }
  }

  /* ------------------------------------------------------------------ */
  /* 扫描与对账                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 受限扫描笔记根:收集 markdown 文件与其 `dsh-note-id`。
   * @param notesRoot - 笔记根(绝对)。
   * @param depth - 最大深度。
   * @returns `{ files, truncated }`,`files` 为 `{ path, title, id }`。
   */
  async scanNotesRoot(notesRoot, depth) {
    const fs = this.ctx.fs
    const files = []
    let truncated = false
    let root
    try {
      root = await fs.resolve(notesRoot, {})
    } catch {
      return { files, truncated }
    }
    const queue = [{ target: root, level: 0 }]
    while (queue.length > 0) {
      const current = queue.shift()
      let entries
      try {
        entries = await fs.listDir(current.target, this.abort.signal)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.type === 'directory') {
          if (current.level + 1 > depth) continue
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
          queue.push({ target: entry.target, level: current.level + 1 })
          continue
        }
        if (entry.type !== 'file' || !looksLikeMarkdown(entry.name)) continue
        if (files.length >= SCAN_FILE_CAP) {
          truncated = true
          continue
        }
        const path = normalizePath(fs.processPath(entry.target))
        let text = ''
        if ((entry.size ?? 0) <= ID_SCAN_MAX_BYTES) {
          try {
            text = await fs.readText(entry.target, this.abort.signal)
          } catch {
            text = ''
          }
        }
        files.push({ path, title: titleOf(path, text), id: text === '' ? null : readNoteId(text) })
      }
    }
    return { files, truncated }
  }

  /**
   * 对账一个工作区(节流):按 id 重绑移动/改名、丢弃消失的条目、算出未归类。
   * @param workspaceKey - 工作区键。
   * @param options - `force` 忽略冷却。
   * @returns `{ files, truncated, unfiled }`。
   */
  async reconcile(workspaceKey, { force = false } = {}) {
    const registry = await this.ensureLoaded()
    const workspace = registry.workspaceOf(workspaceKey)
    if (workspace === undefined) throw new NotesError('工作区未登记', 'WORKSPACE_UNKNOWN')
    const cached = this.scans.get(workspaceKey)
    if (!force && cached !== undefined && Date.now() - cached.at < SCAN_COOLDOWN_MS) return cached.result
    const { files, truncated } = await this.scanNotesRoot(workspace.notesRoot, this.config.unfiledDepth)
    registry.applyScan(workspaceKey, files)
    const state = registry.toJSON()
    const known = new Set(
      Object.values(state.notes)
        .filter((note) => note.workspaceKey === workspaceKey)
        .map((note) => normalizePath(note.path)),
    )
    const unfiled = files.filter((file) => !known.has(normalizePath(file.path))).slice(0, this.config.unfiledMax)
    const result = { files, truncated, unfiled }
    this.scans.set(workspaceKey, { at: Date.now(), result })
    await this.persist()
    return result
  }

  /* ------------------------------------------------------------------ */
  /* 路径与 IO                                                           */
  /* ------------------------------------------------------------------ */

  /** 解析用户路径 → `{ target, absolute }`(绝对路径已规范化)。 */
  async resolveNotePath(path, root) {
    const fs = this.ctx.fs
    const target = await fs.resolve(String(path ?? ''), { cwd: root })
    const absolute = normalizePath(fs.processPath(target))
    if (!looksLikeMarkdown(absolute)) throw new NotesError('只处理 markdown 文件', 'NOT_MARKDOWN')
    return { target, absolute }
  }

  /** 保证目录存在(组合 fs 没有 mkdir —— 唯一的目录创建点)。 */
  async ensureDir(absoluteDir) {
    await mkdir(absoluteDir, { recursive: true })
  }

  /**
   * 用户动作的写入策略:用**会话自己的**沙箱模式(会话 cwd 即边界)。
   *
   * `ctx.fs.writeText` 不传策略时会按部署默认边界拒绝(实测 workspace-write 下
   * 连 `<workspace>/notes/x.md` 都是 `FS_SANDBOX_DENIED`)。
   * 传会话策略也意味着**不改用户设置**:read-only 会话的写入照旧被拒(错误照实上抛)。
   * @param sessionId - 会话 id。
   * @returns 执行策略,或 undefined(退化为 fs 默认)。
   */
  policyOf(sessionId) {
    try {
      const session = this.ctx.sessions?.get?.(sessionId)
      if (session === undefined) return undefined
      return this.ctx.sandboxPolicy?.resolve?.({ session })
    } catch (error) {
      this.logger?.debug?.('[dsh-notes] 沙箱策略解析失败:%s', error?.message ?? error)
      return undefined
    }
  }

  /* ------------------------------------------------------------------ */
  /* 笔记:登记 / 注销 / 归属 / 映射                                     */
  /* ------------------------------------------------------------------ */

  /**
   * 登记一篇已存在的 md(必要时注入 `dsh-note-id`)。
   * @returns 笔记条目。
   */
  async register({ sessionId, path, collectionId = null }) {
    if (String(path ?? '').trim() === '') throw new NotesError('register 需要 path', 'INVALID')
    const fs = this.ctx.fs
    const workspace = await this.workspaceOf(sessionId)
    const registry = await this.ensureLoaded()
    const { target, absolute } = await this.resolveNotePath(path, workspace.root)
    const info = await fs.stat(target, this.abort.signal)
    if (info === undefined || info.type !== 'file') throw new NotesError(`文件不存在:${absolute}`, 'NOT_FOUND')

    let text = await fs.readText(target, this.abort.signal)
    let id = readNoteId(text)
    if (id === null) {
      id = mintNoteId()
      const next = mintFrontmatter(text, id)
      await fs.writeText(
        target,
        next,
        { kind: 'replaceIfVersion', version: info.version },
        this.abort.signal,
        this.policyOf(sessionId),
      )
      text = next
    }
    const existing = registry.noteById(id)
    const note = registry.addNote({
      id,
      path: absolute,
      workspaceKey: workspace.key,
      collectionId: collectionId ?? existing?.collectionId ?? null,
      title: titleOf(absolute, text),
    })
    await this.persist()
    await this.armWatch(workspace.key)
    this.logger?.info?.('[dsh-notes] 登记笔记 %s → %s', note.id, note.path)
    return note
  }

  /** 只删索引条目(永不删文件)。 */
  async unregister({ noteId }) {
    const registry = await this.ensureLoaded()
    if (!registry.removeNote(noteId)) throw new NotesError('笔记不存在', 'NOT_FOUND')
    await this.persist()
    return true
  }

  /** 改归属(null = 未归类)。 */
  async moveNote({ noteId, collectionId = null }) {
    const registry = await this.ensureLoaded()
    const note = registry.noteById(noteId)
    if (note === undefined) throw new NotesError('笔记不存在', 'NOT_FOUND')
    const target = collectionId ?? null
    if (target !== null) {
      const owner = registry.workspaceOf(note.workspaceKey)
      if (owner?.collections?.[target] === undefined) throw new NotesError('目标分类不存在于该工作区', 'INVALID')
    }
    const at = index === null || index === undefined ? null : Number(index)
    if (!registry.placeNote(note.workspaceKey, noteId, target, at)) throw new NotesError('移动失败', 'INVALID')
    await this.persist()
    return true
  }

  /**
   * 读一篇笔记的正文 + 版本(编辑器打开时用)。
   *
   * 官方的只读 Remote(`ctx.remote.workspaceFiles`)在插件页里要先注入资源模型;
   * 编辑器只需要「一次读全 + 拿到版本号」,所以给一条同源自建读接口 ——
   * 版本号与 `save` 同源(`fs.stat().version`),冲突判定才对得上。
   * @returns `{ text, version, absolutePath }`。
   */
  async readNote({ sessionId, path }) {
    if (String(path ?? '').trim() === '') throw new NotesError('read 需要 path', 'INVALID')
    const fs = this.ctx.fs
    const workspace = await this.workspaceOf(sessionId)
    const { target, absolute } = await this.resolveNotePath(path, workspace.root)
    const info = await fs.stat(target, this.abort.signal)
    if (info === undefined || info.type !== 'file') throw new NotesError(`文件不存在:${absolute}`, 'NOT_FOUND')
    const text = await fs.readText(target, this.abort.signal)
    return { text, version: String(info.version), absolutePath: absolute }
  }

  /** 跨工作区映射:把别的工作区的笔记挂进本工作区树。 */
  async reference({ sessionId, noteId, collectionId = null }) {
    const registry = await this.ensureLoaded()
    const workspace = await this.workspaceOf(sessionId)
    if (!registry.addReference(workspace.key, noteId, collectionId)) throw new NotesError('笔记不存在', 'NOT_FOUND')
    await this.persist()
    return true
  }

  /** 去掉跨工作区映射(不动笔记本身)。 */
  async unreference({ sessionId, noteId }) {
    const registry = await this.ensureLoaded()
    const workspace = await this.workspaceOf(sessionId)
    if (!registry.removeReference(workspace.key, noteId)) throw new NotesError('映射不存在', 'NOT_FOUND')
    await this.persist()
    return true
  }

  /* ------------------------------------------------------------------ */
  /* 分类                                                                */
  /* ------------------------------------------------------------------ */

  /** 分类操作(create/rename/move/delete)。 */
  async collection({ sessionId, op, collectionId, name, parentId = null, mode, index = null }) {
    const registry = await this.ensureLoaded()
    const workspace = await this.workspaceOf(sessionId)
    let result = null
    if (op === 'create') result = registry.createCollection(workspace.key, { name, parentId })
    else if (op === 'rename') {
      if (!registry.renameCollection(workspace.key, collectionId, name)) throw new NotesError('分类不存在', 'NOT_FOUND')
      result = registry.collection(workspace.key, collectionId)
    } else if (op === 'move') {
      const at = index === null || index === undefined ? null : Number(index)
      if (!registry.moveCollection(workspace.key, collectionId, parentId, at)) {
        throw new NotesError('分类移动失败(不存在或成环)', 'INVALID')
      }
      result = registry.collection(workspace.key, collectionId)
    } else if (op === 'delete') {
      if (!registry.deleteCollection(workspace.key, collectionId, mode ?? 'move-to-parent')) throw new NotesError('分类不存在', 'NOT_FOUND')
    } else {
      throw new NotesError(`不认识的分类操作:${op}`, 'INVALID')
    }
    await this.persist()
    return result
  }

  /* ------------------------------------------------------------------ */
  /* 新建笔记                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 在笔记根下新建一篇笔记并登记(文件名由标题推导,重名自动加序号)。
   * @returns 笔记条目。
   */
  async createNote({ sessionId, title, collectionId = null }) {
    const wanted = String(title ?? '').trim()
    if (wanted === '') throw new NotesError('新建笔记需要非空 title', 'INVALID')
    const fs = this.ctx.fs
    const workspace = await this.workspaceOf(sessionId)
    this.logger?.info?.('[dsh-notes] create title=%j workspace=%s', wanted, workspace.key)
    await this.ensureDir(workspace.notesRoot)
    const stem = sanitizeFileName(wanted)
    let absolute = normalizePath(join(workspace.notesRoot, `${stem}.md`))
    let target
    for (let index = 1; index <= 50; index += 1) {
      const candidate = await fs.resolve(absolute, {})
      const info = await fs.stat(candidate, this.abort.signal)
      if (info === undefined) {
        target = candidate
        break
      }
      absolute = normalizePath(join(workspace.notesRoot, `${stem} ${index}.md`))
    }
    if (target === undefined) throw new NotesError('同名文件过多,换个标题', 'INVALID')
    const id = mintNoteId()
    const body = mintFrontmatter(`# ${wanted}\n\n`, id)
    await fs.writeText(target, body, { kind: 'createIfAbsent' }, this.abort.signal, this.policyOf(sessionId))
    return this.register({ sessionId, path: absolute, collectionId })
  }

  /* ------------------------------------------------------------------ */
  /* 内容保存(编辑器用)                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 守卫式保存:版本不符 → `FS_STALE_VERSION`(带上当前版本与当前内容)。
   * @returns `{ version, path }`。
   */
  async save({ sessionId, path, text, expectedVersion }) {
    if (String(path ?? '').trim() === '') throw new NotesError('save 需要 path', 'INVALID')
    if (typeof text !== 'string') throw new NotesError('save 需要 text', 'INVALID')
    const fs = this.ctx.fs
    const workspace = await this.workspaceOf(sessionId)
    const { target, absolute } = await this.resolveNotePath(path, workspace.root)
    const info = await fs.stat(target, this.abort.signal)
    if (info === undefined || info.type !== 'file') throw new NotesError(`文件不存在:${absolute}`, 'NOT_FOUND')
    if (expectedVersion !== undefined && expectedVersion !== null && String(info.version) !== String(expectedVersion)) {
      let current = ''
      try {
        current = await fs.readText(target, this.abort.signal)
      } catch {
        current = ''
      }
      throw new NotesError('文件已被外部修改', 'FS_STALE_VERSION', {
        currentVersion: String(info.version),
        currentText: current,
      })
    }
    try {
      const outcome = await fs.writeText(
        target,
        text,
        { kind: 'replaceIfVersion', version: info.version },
        this.abort.signal,
        this.policyOf(sessionId),
      )
      return { version: String(outcome.version), path: absolute }
    } catch (error) {
      if (String(error?.code ?? '').includes('STALE')) {
        throw new NotesError('文件已被外部修改', 'FS_STALE_VERSION', { currentVersion: String(info.version) })
      }
      throw error
    }
  }

  /* ------------------------------------------------------------------ */
  /* 资产(粘贴/拖入的图片)                                             */
  /* ------------------------------------------------------------------ */

  /**
   * 保存一张图片到托管目录,返回可写进 markdown 的**相对链接**。
   *
   * 二进制写入必须走 node:fs:组合 fs 只提供 `writeText`。
   * @returns `{ absolutePath, relative, markdown }`。
   */
  async saveAsset({ sessionId, noteId, bytes, extension }) {
    if (this.config.pasteImage !== 'copy') throw new NotesError('配置为 link 模式,不复制资产', 'INVALID')
    const fs = this.ctx.fs
    const workspace = await this.workspaceOf(sessionId)
    const registry = await this.ensureLoaded()
    const note = noteId === undefined || noteId === null ? undefined : registry.noteById(noteId)
    const bucket = note?.id ?? 'shared'
    const dir = normalizePath(join(workspace.root, this.config.assetsDir, bucket))
    await this.ensureDir(dir)
    const absolute = normalizePath(join(dir, assetFileName(extension)))
    const target = await fs.resolve(absolute, {})
    const existing = await fs.stat(target, this.abort.signal)
    if (existing !== undefined) throw new NotesError('资产重名,请重试', 'EXISTS')
    await writeFile(absolute, Buffer.from(bytes))
    const relative = note === undefined ? absolute : relativePath(dirOf(note.path), absolute)
    return { absolutePath: absolute, relative, markdown: `![](${relative})` }
  }

  /* ------------------------------------------------------------------ */
  /* 树(UI / 工具共用)                                                  */
  /* ------------------------------------------------------------------ */

  /** 组装一棵树(分类计数 + 本工作区笔记 + 跨工作区映射 + 未归类)。 */
  async tree({ sessionId, force = false } = {}) {
    const registry = await this.ensureLoaded()
    const workspace = await this.workspaceOf(sessionId)
    const scan = await this.reconcile(workspace.key, { force })
    void this.armWatch(workspace.key)
    const state = registry.toJSON()
    const ws = state.workspaces[workspace.key]
    const counts = new Map()
    for (const note of Object.values(state.notes)) {
      if (note.workspaceKey !== workspace.key) continue
      const key = note.collectionId ?? ''
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const collections = Object.values(ws.collections)
      .map((node) => ({
        id: node.id,
        name: node.name,
        parentId: node.parentId ?? null,
        order: node.order ?? 0,
        count: counts.get(node.id) ?? 0,
      }))
      .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name, 'zh-Hans-CN'))
    const home = Object.values(state.notes)
      .filter((note) => note.workspaceKey === workspace.key)
      .map((note) => ({
        id: note.id,
        title: note.title,
        path: note.path,
        relPath: relativePath(workspace.root, note.path),
        collectionId: note.collectionId ?? null,
        order: Number.isFinite(note.order) ? note.order : Number.MAX_SAFE_INTEGER,
        pinned: ws.pins.includes(note.id),
      }))
      .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title, 'zh-Hans-CN'))
    const refs = Object.entries(ws.refs ?? {})
      .map(([noteId, ref]) => {
        const note = state.notes[noteId]
        if (note === undefined) return null
        const owner = state.workspaces[note.workspaceKey]
        return {
          noteId,
          title: note.title,
          path: note.path,
          relPath: owner === undefined ? note.path : relativePath(owner.root, note.path),
          workspaceKey: note.workspaceKey,
          workspaceName: owner?.name ?? note.workspaceKey,
          collectionId: ref.collectionId ?? null,
        }
      })
      .filter((entry) => entry !== null)
    const unfiled = (scan.unfiled ?? []).map((file) => ({
      path: file.path,
      relPath: relativePath(workspace.root, file.path),
      title: file.title,
      id: file.id ?? null,
    }))
    return {
      workspace: {
        key: workspace.key,
        root: workspace.root,
        name: workspace.name,
        notesRoot: workspace.notesRoot,
        notesDir: this.config.notesDir,
      },
      collections,
      notes: home,
      refs,
      unfiled,
      unfiledTruncated: scan.truncated === true,
      pinned: ws.pins,
      recent: ws.recent ?? [],
      stats: {
        notes: home.length,
        collections: collections.length,
        refs: refs.length,
        unfiled: unfiled.length,
      },
    }
  }

  /* ------------------------------------------------------------------ */
  /* 监视                                                                */
  /* ------------------------------------------------------------------ */

  /** 对某个工作区挂监视(笔记根 + 每篇已登记文件)。幂等;失败只记日志。 */
  async armWatch(workspaceKey) {
    if (!this.config.watch) return
    const registry = await this.ensureLoaded()
    const workspace = registry.workspaceOf(workspaceKey)
    if (workspace === undefined) return
    const fs = this.ctx.fs
    const paths = [workspace.notesRoot]
    for (const note of Object.values(registry.state.notes)) {
      if (note.workspaceKey === workspaceKey) paths.push(note.path)
    }
    for (const path of paths) {
      if (this.watchers.has(path)) continue
      try {
        const target = await fs.resolve(path, {})
        const dispose = await fs.watch(target, () => this.markDirty(workspaceKey), this.abort.signal)
        this.watchers.set(path, dispose)
      } catch (error) {
        this.logger?.debug?.('[dsh-notes] 监视失败 %s:%s', path, error?.message ?? error)
      }
    }
  }

  /** 记脏 + 去抖批量重扫(目录抖动时只跑一次)。 */
  markDirty(workspaceKey) {
    this.dirty.add(workspaceKey)
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const keys = [...this.dirty]
      this.dirty.clear()
      for (const key of keys) {
        this.reconcile(key, { force: true })
          .then(() => this.onChanged?.())
          .catch((error) => this.logger?.warn?.('[dsh-notes] 对账失败:%s', error?.message ?? error))
      }
    }, WATCH_DEBOUNCE_MS)
    this.flushTimer.unref?.()
  }

  /** 释放监视与定时器。 */
  dispose() {
    this.abort.abort()
    if (this.flushTimer !== null) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.watchers.clear()
    this.scans.clear()
  }
}

/** 原生路径的目录部分(node:path 语义,给索引文件用)。 */
function dirOfNative(file) {
  const index = file.lastIndexOf('/')
  const alt = file.lastIndexOf('\\')
  const cut = Math.max(index, alt)
  return cut <= 0 ? '.' : file.slice(0, cut)
}
