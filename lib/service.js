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

import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  assetFileName,
  baseName,
  dirOf,
  isAbsolutePath,
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
/** 扫描索引 schema 版本。 */
const SCAN_INDEX_VERSION = 1
/** 读 frontmatter 时最多读多少字节(readByteRange 的窗口)。 */
const FRONTMATTER_SCAN_BYTES = 4096
/** 单次 `fs.listDir` 的期限(毫秒):provider 卡住时不能让整个扫描永久挂住。 */
const LIST_DIR_TIMEOUT_MS = 5000
/** 一次工作区扫描的总预算(毫秒)与目录数上限:超出就当截断,先给用户能用的结果。 */
const WALK_BUDGET_MS = 10000
const WALK_MAX_DIRS = 3000
/** 还没有任何工作区扫描结果时的空值。 */
const EMPTY_WORKSPACE_SCAN = { at: 0, files: [], dirs: 0, truncated: false, changed: 0, rebound: 0, dropped: 0, outside: [] }
/** 一次对账里最多核实多少个"扫描范围之外"的已登记笔记(防 stat 风暴)。 */
const OUTSIDE_VERIFY_MAX = 200
/** 还没有任何扫描结果时返回的空分类(并发期间被问到就给它这个)。 */
const EMPTY_SCAN = { files: [], truncated: false, unfiled: [], report: null }

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
    /** 正在走目录的工作区(串行化,见 reconcile)。 */
    this.scanning = new Set()
    /** 正在走**整个工作区**目录的工作区(见 scanWorkspace)。 */
    this.scanningWorkspace = new Set()
    /** 工作区级扫描结果的缓存(工作区键 → { at, result })。 */
    this.workspaceScans = new Map()
    /** 正在扫的工作区 → 进度(面板显示用)。 */
    this.scanProgress = new Map()
    /** 一趟没走完时的队列前沿(工作区键 → 状态),下次接着走。 */
    this.walkStates = new Map()
    /** 已经自动创建过笔记根的工作区(避免反复尝试)。 */
    this.autoCreatedDirs = new Set()
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
  async workspaceOf(sessionId, workspaceKey = null) {
    const registry = await this.ensureLoaded()
    // 显式给了 workspaceKey 就用它(**只认已登记的**,不能凭 sessionId 越界造工作区):
    // 笔记区域可以切换到别的已登记工作区,内容路由都带这个参数。
    const explicit = workspaceKey === null || workspaceKey === undefined ? '' : String(workspaceKey).trim()
    if (explicit !== '') {
      const node = registry.workspaceOf(explicit)
      if (node === undefined) throw new NotesError(`未登记的工作区:${explicit}`, 'WORKSPACE_UNKNOWN')
      node.lastUsedAt = Date.now()
      const overridden = applyNotesRootOverride(node)
      return { key: explicit, root: node.root, name: node.name, notesRoot: overridden, node }
    }
    const info = this.resolveWorkspace(sessionId)
    const node = registry.workspace(info.key, { root: info.root, name: info.name, notesRoot: info.notesRoot })
    node.lastUsedAt = Date.now()
    return { ...info, notesRoot: applyNotesRootOverride(node), node }
  }

  /**
   * 设置本工作区的笔记根(工作区内已存在的目录)。
   *
   * 为什么允许按工作区覆盖:不同仓库习惯不同(有的都放 `docs/`)。空态卡片上就能改。
   * @param options - `sessionId`;`workspaceKey`;`path` 工作区相对或绝对。
   * @returns `{ workspaceKey, notesRoot }`。
   */
  async setNotesRoot({ sessionId, workspaceKey = null, path }) {
    const registry = await this.ensureLoaded()
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const fs = this.ctx.fs
    const absolute = await this.resolveInWorkspace(workspace, path)
    if (!isInsidePath(workspace.root, absolute)) throw new NotesError('笔记根必须在工作区之内', 'INVALID')
    const info = await fs.stat(await fs.resolve(absolute, {}), this.abort.signal)
    if (info === undefined || info.type !== 'directory') throw new NotesError(`目录不存在:${absolute}`, 'NOT_FOUND')
    const node = registry.workspace(workspace.key)
    node.notesRootOverride = absolute
    node.notesRoot = absolute
    node.scanRoots = []
    this.invalidateScans(workspace.key)
    await this.persist()
    this.logger?.info?.('[dsh-notes] 笔记根改为 %s', absolute)
    return { workspaceKey: workspace.key, notesRoot: absolute }
  }

  /**
   * 创建工作区内的一个目录(默认就是当前笔记根)。**只创建,永不删除/覆盖**。
   *
   * 组合 fs 没有 mkdir,这里走 node:fs(与资产/回收站同款);调用方已校验路径在工作区内。
   * @param options - `sessionId`;`workspaceKey`;`path` 省略 = 当前笔记根。
   * @returns `{ workspaceKey, notesRoot, created }`。
   */
  async createNotesDir({ sessionId, workspaceKey = null, path = null }) {
    const registry = await this.ensureLoaded()
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const fs = this.ctx.fs
    let absolute = workspace.notesRoot
    if (path !== null && String(path).trim() !== '') absolute = await this.resolveInWorkspace(workspace, path)
    if (!isInsidePath(workspace.root, absolute)) throw new NotesError('只能在当前工作区之内创建目录', 'INVALID')
    const info = await fs.stat(await fs.resolve(absolute, {}), this.abort.signal)
    let created = false
    if (info === undefined) {
      await mkdir(absolute, { recursive: true })
      created = true
      this.logger?.info?.('[dsh-notes] 创建目录 %s', absolute)
    } else if (info.type !== 'directory') {
      throw new NotesError(`同名文件已存在:${absolute}`, 'EXISTS')
    }
    // 新目录等于"笔记根刚出现":清掉缓存,下一次取树就会扫它
    this.invalidateScans(workspace.key)
    await this.persist()
    return { workspaceKey: workspace.key, notesRoot: workspace.notesRoot, path: absolute, created }
  }

  /**
   * 把"工作区相对/绝对"的用户输入解析成工作区内的绝对路径。
   *
   * 相对路径**由我们自己**拼到工作区根上:不依赖 provider 对 `{cwd}` 的处理,
   * 也让单测可以用最朴素的 fs 桩(实测踩到:桩忽略了 cwd,相对路径就变成了 'docs')。
   * @param workspace - 工作区信息。
   * @param path - 用户输入。
   * @returns 绝对路径(未做存在性检查)。
   */
  async resolveInWorkspace(workspace, path) {
    const text = String(path ?? '').trim()
    if (text === '') throw new NotesError('需要 path', 'INVALID')
    const input = isAbsolutePath(text) ? text : join(workspace.root, text)
    const target = await this.ctx.fs.resolve(input, {})
    return normalizePath(this.ctx.fs.processPath(target))
  }

  /** 某个工作区的扫描缓存全部作废(笔记根/范围变了、或刚创建了目录)。 */
  invalidateScans(workspaceKey) {
    this.scans.delete(workspaceKey)
    this.workspaceScans.delete(workspaceKey)
    this.walkStates.delete(workspaceKey)
    this.scanProgress.delete(workspaceKey)
  }

  /**
   * 列出已登记的工作区(笔记区域的"切换工作区"用)。
   * @param options - `sessionId`(用于标出会话自己的工作区)。
   * @returns `{ current, workspaces }`。
   */
  async listWorkspaces({ sessionId }) {
    const registry = await this.ensureLoaded()
    let current = null
    try {
      const info = this.resolveWorkspace(sessionId)
      registry.workspace(info.key, { root: info.root, name: info.name, notesRoot: info.notesRoot })
      current = info.key
    } catch {
      current = null
    }
    const fs = this.ctx.fs
    const rows = []
    for (const [key, node] of Object.entries(registry.state.workspaces)) {
      const notesRoot = applyNotesRootOverride(node)
      let exists = true
      try {
        const info = await fs.stat(await fs.resolve(notesRoot, {}), this.abort.signal)
        exists = info !== undefined && info.type === 'directory'
      } catch {
        exists = false
      }
      rows.push({
        key,
        root: node.root,
        name: node.name === '' ? baseName(node.root) : node.name,
        notesRoot,
        notes: Object.values(registry.state.notes).filter((note) => note.workspaceKey === key).length,
        lastUsedAt: Number(node.lastUsedAt ?? 0),
        isSession: key === current,
        /** 这个工作区还没有笔记根目录(切换器上给个角标)。 */
        notesDirMissing: exists === false,
      })
    }
    const workspaces = rows
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
    return { current, workspaces }
  }

  /**
   * 打开(登记)一个工作区根目录 —— 笔记区域可以看别的目录,不必先有那个目录的会话。
   * @param options - `sessionId`;`root` 绝对路径。
   * @returns 工作区信息。
   */
  async openWorkspace({ sessionId, root }) {
    const absolute = normalizePath(String(root ?? '').trim())
    if (absolute === '' || !isAbsolutePath(absolute)) throw new NotesError('需要一个绝对路径', 'INVALID')
    const fs = this.ctx.fs
    const info = await fs.stat(await fs.resolve(absolute, {}), this.abort.signal)
    if (info === undefined || info.type !== 'directory') throw new NotesError(`目录不存在:${absolute}`, 'NOT_FOUND')
    const registry = await this.ensureLoaded()
    const key = workspaceKeyOf(absolute)
    const node = registry.workspace(key, {
      root: absolute,
      name: baseName(absolute),
      notesRoot: normalizePath(join(absolute, this.config.notesDir)),
    })
    node.lastUsedAt = Date.now()
    await this.persist()
    return { key, root: node.root, name: node.name, notesRoot: node.notesRoot }
  }

  /**
   * 用户侧写入的执行策略:**模式**来自会话(read-only 会话依旧只读),
   * **边界根**换成目标工作区(笔记区域切到别的已登记工作区时,写的是那边的文件)。
   * @param sessionId - 会话 id(取模式)。
   * @param workspaceRoot - 目标工作区根。
   * @returns 执行策略。
   */
  policyFor(sessionId, workspaceRoot) {
    const base = this.policyOf(sessionId)
    if (base === undefined || workspaceRoot === undefined || workspaceRoot === null) return base
    if (normalizePath(base.workspaceRoot ?? '') === normalizePath(workspaceRoot)) return base
    return { ...base, workspaceRoot: normalizePath(workspaceRoot) }
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
    /** 有目录列不出来(根不存在,或某个子目录读不了)→ 这次扫描**不完整**。 */
    let incomplete = false
    /** 根目录本身列不出来 = 这个工作区还没有笔记根(与"笔记全被删了"是两回事)。 */
    let missingRoot = false
    let root
    try {
      root = await fs.resolve(notesRoot, {})
    } catch {
      return { files, truncated, incomplete: true, missingRoot: true }
    }
    const queue = [{ target: root, level: 0, isRoot: true }]
    while (queue.length > 0) {
      const current = queue.shift()
      let entries
      try {
        entries = await fs.listDir(current.target, this.abort.signal)
      } catch (error) {
        // 关键:**列不出来 ≠ 文件没了**。根挂了要如实上报(空态卡片要用),
        // 任何一层挂掉都算"这次扫描不完整",调用方据此跳过删除分支。
        incomplete = true
        if (current.isRoot === true) missingRoot = true
        this.logger?.debug?.('[dsh-notes] 列目录失败 %s:%s', current.target?.path ?? '?', error?.message ?? error)
        continue
      }
      for (const entry of entries) {
        if (entry.type === 'directory') {
          if (current.level + 1 > depth) continue
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
          queue.push({ target: entry.target, level: current.level + 1, isRoot: false })
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
        files.push({ path, title: titleOf(path), id: text === '' ? null : readNoteId(text) })
      }
    }
    return { files, truncated, incomplete, missingRoot }
  }

  /**
   * 对账一个工作区(扫描 → 重绑/丢弃 → 算未纳入)。
   *
   * **只有这里会走目录**(成本高):`tree()` 只读缓存,不再触发扫描。触发点是
   * ① 首次需要数据 ② 监视器报变化 ③ 显式「重新扫描」④(后续)纳入面板按 TTL 刷新。
   * 实测本工作区 1268 目录 / 11k 文件,全量 stat 走一遍要 6s,因此绝不能挂在每次取树上。
   * @param workspaceKey - 工作区键。
   * @param options - `force` 忽略冷却。
   * @returns `{ files, truncated, unfiled, report }`。
   */
  async reconcile(workspaceKey, { force = false } = {}) {
    const registry = await this.ensureLoaded()
    const workspace = registry.workspaceOf(workspaceKey)
    if (workspace === undefined) throw new NotesError('工作区未登记', 'WORKSPACE_UNKNOWN')
    const cached = this.scans.get(workspaceKey)
    if (!force && cached !== undefined && Date.now() - cached.at < SCAN_COOLDOWN_MS) return cached.result
    // 同工作区同一时刻只允许一次走目录:客户端轮询/TTL 兜底/监视器可能同时触发,
    // 让它们串行化,避免小机器上叠起来互相拖慢。
    if (this.scanning.has(workspaceKey)) return cached?.result ?? EMPTY_SCAN
    this.scanning.add(workspaceKey)
    try {
      return await this.runScan(workspaceKey, workspace)
    } finally {
      this.scanning.delete(workspaceKey)
    }
  }

  /**
   * 真正走一遍目录并落账(只由 {@link NoteService#reconcile} 调用)。
   * @param workspaceKey - 工作区键。
   * @param workspace - 工作区节点。
   * @returns 分类结果。
   */
  async runScan(workspaceKey, workspace) {
    const registry = this.registry
    const { files, truncated, incomplete, missingRoot } = await this.scanNotesRoot(workspace.notesRoot, this.config.unfiledDepth)
    // **扫描不完整时绝不做"文件消失"的对账** —— 目录不存在/读不了的时候,以前会把
    // 该工作区已登记的笔记全部删掉(用户实测:笔记自己没了、打开的标签被连带关掉)。
    const applied =
      incomplete === true
        ? { rebound: 0, dropped: 0, outside: [] }
        : registry.applyScan(workspaceKey, files, { scopeRoot: workspace.notesRoot })
    // 扫描范围之外的已登记笔记(用户/Agent 显式登记的工作区其它目录):不能因为
    // "这次没扫到"就丢 —— 逐个 stat 核实,确实没了才删条目。
    const vanished = await this.verifyOutside(applied.outside ?? [])
    const state = registry.toJSON()
    const known = new Set(
      Object.values(state.notes)
        .filter((note) => note.workspaceKey === workspaceKey)
        .map((note) => normalizePath(note.path)),
    )
    const unfiled = files.filter((file) => !known.has(normalizePath(file.path))).slice(0, this.config.unfiledMax)
    // 配置打开时(默认关)自动补建笔记根,再重扫一次
    if (missingRoot === true && this.config.createNotesDirOnOpen === true && this.autoCreatedDirs.has(workspaceKey) === false) {
      this.autoCreatedDirs.add(workspaceKey)
      try {
        await mkdir(workspace.notesRoot, { recursive: true })
        this.logger?.info?.('[dsh-notes] 自动创建笔记根 %s', workspace.notesRoot)
        return this.reconcile(workspaceKey, { force: true })
      } catch (error) {
        this.logger?.warn?.('[dsh-notes] 自动创建笔记根失败:%s', error?.message ?? error)
      }
    }
    const result = {
      files,
      truncated,
      incomplete: incomplete === true,
      missingRoot: missingRoot === true,
      unfiled,
      report: {
        at: Date.now(),
        scanned: files.length,
        rebound: applied.rebound,
        dropped: applied.dropped + vanished,
        unfiled: unfiled.length,
        truncated,
        incomplete: incomplete === true,
        missingRoot: missingRoot === true,
      },
    }
    this.scans.set(workspaceKey, { at: Date.now(), result })
    await this.persist()
    return result
  }

  /**
   * 登记/注销/删除之后:就地修正分类缓存(**不重新走目录**)。
   *
   * - `upsert`:新出现的 md(新建/导入/登记),补进缓存的文件清单;
   * - `remove`:已经不在原处的 md(移入回收站),从清单里摘掉;
   * - 然后按 registry 重算「未纳入」。
   *
   * 不这么做的话,刚纳入的文件还会在候选里挂一会儿、刚删掉的又会冒出来当候选,
   * 用户会以为操作没生效。
   * @param workspaceKey - 工作区键。
   * @param options - `upsert` / `remove`:受影响的路径。
   */
  syncClassificationCache(workspaceKey, { upsert = [], remove = [] } = {}) {
    const cached = this.scans.get(workspaceKey)
    const registry = this.registry
    if (cached === undefined || registry === undefined) return
    let files = cached.result.files ?? []
    if (remove.length > 0) {
      const drop = new Set(remove.map((path) => normalizePath(path)))
      files = files.filter((file) => !drop.has(normalizePath(file.path)))
    }
    if (upsert.length > 0) {
      const have = new Set(files.map((file) => normalizePath(file.path)))
      for (const item of upsert) {
        if (have.has(normalizePath(item.path))) continue
        have.add(normalizePath(item.path))
        files = files.concat([item])
      }
    }
    const known = new Set(
      Object.values(registry.state.notes)
        .filter((note) => note.workspaceKey === workspaceKey)
        .map((note) => normalizePath(note.path)),
    )
    const unfiled = files.filter((file) => !known.has(normalizePath(file.path))).slice(0, this.config.unfiledMax)
    cached.result = { ...cached.result, files, unfiled }
  }

  /**
   * 扫描范围之外的已登记笔记:逐个 stat,确认真的不存在才删条目。
   * @param ids - 待核实的笔记 id(有上限,避免大仓库里 stat 风暴)。
   * @returns 移除的条目数。
   */
  async verifyOutside(ids) {
    if (ids.length === 0) return 0
    const registry = await this.ensureLoaded()
    const fs = this.ctx.fs
    let removed = 0
    for (const id of ids.slice(0, OUTSIDE_VERIFY_MAX)) {
      const note = registry.noteById(id)
      if (note === undefined) continue
      let info
      try {
        const target = await fs.resolve(note.path, {})
        info = await fs.stat(target, this.abort.signal)
      } catch {
        info = undefined
      }
      if (info === undefined || info.type !== 'file') {
        registry.removeNote(id)
        removed += 1
      }
    }
    return removed
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
  async register({ sessionId, path, collectionId = null, workspaceKey = null }) {
    if (String(path ?? '').trim() === '') throw new NotesError('register 需要 path', 'INVALID')
    const fs = this.ctx.fs
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
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
        this.policyFor(sessionId, workspace.root),
      )
      text = next
    }
    const existing = registry.noteById(id)
    const note = registry.addNote({
      id,
      path: absolute,
      workspaceKey: workspace.key,
      collectionId: collectionId ?? existing?.collectionId ?? null,
      title: titleOf(absolute),
    })
    await this.persist()
    await this.armWatch(workspace.key)
    this.syncClassificationCache(workspace.key, {
      upsert: [{ path: absolute, title: titleOf(absolute), id }],
    })
    this.logger?.info?.('[dsh-notes] 登记笔记 %s → %s', note.id, note.path)
    return note
  }

  /** 只删索引条目(永不删文件)。 */
  async unregister({ noteId }) {
    const registry = await this.ensureLoaded()
    const note = registry.noteById(noteId)
    if (!registry.removeNote(noteId)) throw new NotesError('笔记不存在', 'NOT_FOUND')
    await this.persist()
    if (note !== undefined) this.syncClassificationCache(note.workspaceKey)
    return true
  }

  /** 改归属与同级位置(`index` 省略 = 追加到末尾)。 */
  async moveNote({ noteId, collectionId = null, index = null }) {
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
   * 把一份**外部内容**导入成笔记(从系统/别处拖进来的 `.md`)。
   *
   * 只新建文件,不改动来源;文件名沿用原名(重名自动加序号),必要时补 frontmatter。
   * 复用 `register` 完成"写 id → 登记"这一条既有路径,不另开写入分支。
   * @returns 笔记条目。
   */
  async importFile({ sessionId, name, text, collectionId = null, workspaceKey = null }) {
    if (typeof text !== 'string') throw new NotesError('importFile 需要 text', 'INVALID')
    const wanted = String(name ?? '').trim()
    if (wanted === '') throw new NotesError('importFile 需要 name', 'INVALID')
    const fs = this.ctx.fs
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    await this.ensureDir(workspace.notesRoot)
    const stem = sanitizeFileName(wanted.replace(/\.md$/i, '')) || '导入的笔记'
    let absolute = normalizePath(join(workspace.notesRoot, `${stem}.md`))
    let target
    for (let index = 1; index <= 50; index += 1) {
      const candidate = await fs.resolve(absolute, {})
      const info = await fs.stat(candidate, this.abort.signal)
      if (info === undefined) {
        target = candidate
        break
      }
      absolute = normalizePath(join(workspace.notesRoot, `${stem} ${index + 1}.md`))
    }
    if (target === undefined) throw new NotesError('同名文件太多,导入失败', 'EXISTS')
    await fs.writeText(target, text, { kind: 'createIfAbsent' }, this.abort.signal, this.policyFor(sessionId, workspace.root))
    this.logger?.info?.('[dsh-notes] 导入 %s → %s', wanted, absolute)
    return this.register({ sessionId, path: absolute, collectionId, workspaceKey })
  }

  /**
   * 重命名笔记(**显式用户动作**)。
   *
   * ⚠️ 这是 AGENTS.md「永不移动/改名用户的 .md」的**唯一例外**:
   *   - 只在用户在 UI 里明确改名时触发(新建后就地改名 / 右键重命名),绝不自动改;
   *   - 只在**同一目录**内 rename,目标已存在就拒绝(不覆盖任何文件);
   *   - 内容不动,改完按 id 重绑索引。
   * @returns `{ id, path, title }`。
   */
  async renameNote({ sessionId, noteId, title, workspaceKey = null }) {
    const wanted = String(title ?? '').trim()
    if (wanted === '') throw new NotesError('rename 需要非空 title', 'INVALID')
    const fs = this.ctx.fs
    const registry = await this.ensureLoaded()
    const note = registry.noteById(noteId)
    if (note === undefined) throw new NotesError('笔记不存在', 'NOT_FOUND')
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const directory = note.path.replace(/\/[^/]*$/, '')
    const target = normalizePath(join(directory, `${sanitizeFileName(wanted)}.md`))
    if (target !== note.path) {
      const occupied = await fs.stat(await fs.resolve(target, {}), this.abort.signal)
      if (occupied !== undefined) throw new NotesError('同名文件已存在', 'EXISTS')
      await rename(note.path, target)
      await this.armWatch(workspace.key)
    }
    registry.setNotePath(noteId, target, wanted)
    await this.persist()
    this.syncClassificationCache(workspace.key, { upsert: [{ path: target, title: wanted, id: noteId }] })
    return { id: noteId, path: target, title: wanted }
  }

  /* ------------------------------------------------------------------ */
  /* 回收站                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * 回收站目录。
   *
   * 放在**索引文件旁边**(`$DSH_HOME/knowledge/trash`)、而不是笔记根里:重扫只扫
   * 笔记根,放进去的文件永远不会被重新登记回树。
   */
  trashRoot() {
    const configured = String(this.config.storeDir ?? '').trim()
    const base = configured !== '' ? configured : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'knowledge')
    return join(base, 'trash')
  }

  /** 回收站清单文件。 */
  trashIndexFile() {
    return join(this.trashRoot(), 'index.json')
  }

  /** 读回收站清单(缺失/损坏都当空)。 */
  async readTrashIndex() {
    try {
      const text = await readFile(this.trashIndexFile(), 'utf8')
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /** 写回收站清单(临时文件 + 原子替换,与索引同款)。 */
  async writeTrashIndex(entries) {
    const dir = this.trashRoot()
    await mkdir(dir, { recursive: true })
    const file = this.trashIndexFile()
    const tmp = `${file}.tmp-${process.pid}`
    await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  }

  /**
   * 跨文件系统安全的移动:`rename` 在同一个设备上最快,但工作区在 `/mnt/d`、
   * 回收站在 WSL home 时是两个设备,`rename` 会 `EXDEV` —— 退回"复制 + 删源"。
   */
  async moveAcross(from, to) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error
    }
    await copyFile(from, to)
    await unlink(from)
  }

  /**
   * 删除笔记 → **移入回收站**(纯用户显式动作:右键「删除(移入回收站)」)。
   *
   * 与 `renameNote` 同类:这是 AGENTS.md「永不删除/移动用户的 .md」在**用户显式动作**
   * 下的例外,而且不是真删 —— 文件先挪进回收站(可恢复),只有"彻底删除"才 unlink。
   * @returns `{ id, title, path }`。
   */
  async trashNote({ sessionId, noteId, workspaceKey = null }) {
    const registry = await this.ensureLoaded()
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const note = registry.noteById(noteId)
    if (note === undefined) throw new NotesError('笔记不存在', 'NOT_FOUND')
    const id = `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const stored = join(this.trashRoot(), `${id}-${baseName(note.path)}`)
    await mkdir(this.trashRoot(), { recursive: true })
    await this.moveAcross(note.path, stored)
    const entries = await this.readTrashIndex()
    entries.unshift({
      id,
      noteId,
      title: note.title,
      originalPath: note.path,
      file: stored,
      workspaceKey: workspace.key,
      deletedAt: Date.now(),
    })
    await this.writeTrashIndex(entries)
    registry.removeNote(noteId)
    await this.persist()
    await this.armWatch(workspace.key)
    this.syncClassificationCache(workspace.key, { remove: [note.path] })
    this.logger?.info?.('[dsh-notes] 移入回收站 %s → %s', note.path, stored)
    return { id, title: note.title, path: note.path, file: stored }
  }

  /** 回收站清单(带"文件是否还在"的检查)。 */
  async listTrash() {
    const entries = await this.readTrashIndex()
    const out = []
    for (const entry of entries) {
      let exists = true
      try {
        await stat(entry.file)
      } catch {
        exists = false
      }
      out.push({ ...entry, exists })
    }
    return { root: this.trashRoot(), entries: out }
  }

  /** 从回收站恢复:挪回原路径(**原位置被占用就拒绝**),并重新登记进树。 */
  async restoreTrash({ sessionId, id, workspaceKey = null }) {
    const entries = await this.readTrashIndex()
    const entry = entries.find((item) => item.id === id)
    if (entry === undefined) throw new NotesError('回收站里没有这一项', 'NOT_FOUND')
    const fs = this.ctx.fs
    const occupied = await fs.stat(await fs.resolve(entry.originalPath, {}), this.abort.signal)
    if (occupied !== undefined) throw new NotesError('原位置已有同名文件,先移开它再恢复', 'EXISTS')
    const exists = await stat(entry.file).then(() => true, () => false)
    if (!exists) throw new NotesError('回收站里的文件已经不见了', 'NOT_FOUND')
    await mkdir(dirOfNative(entry.originalPath), { recursive: true })
    await this.moveAcross(entry.file, entry.originalPath)
    await this.writeTrashIndex(entries.filter((item) => item.id !== id))
    const registered = await this.register({ sessionId, path: entry.originalPath, workspaceKey })
    this.logger?.info?.('[dsh-notes] 从回收站恢复 %s', entry.originalPath)
    return { path: entry.originalPath, note: registered }
  }

  /** 彻底删除(`all: true` = 清空)。 */
  async purgeTrash({ id, all = false }) {
    const entries = await this.readTrashIndex()
    if (entries.length === 0) throw new NotesError('回收站是空的', 'NOT_FOUND')
    const keep = []
    let removed = 0
    for (const entry of entries) {
      if (all === true || entry.id === id) {
        try {
          await unlink(entry.file)
        } catch {
          /* 文件已经不在了:清掉记录即可 */
        }
        removed += 1
      } else {
        keep.push(entry)
      }
    }
    if (removed === 0) throw new NotesError('回收站里没有这一项', 'NOT_FOUND')
    await this.writeTrashIndex(keep)
    return { removed }
  }

  /** 置顶 / 取消置顶(每工作区一份 pins 列表)。 */
  async pin({ sessionId, noteId, pinned = true, workspaceKey = null }) {
    const registry = await this.ensureLoaded()
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const note = registry.noteById(noteId)
    if (note === undefined) throw new NotesError('笔记不存在', 'NOT_FOUND')
    registry.setPinned(noteId, pinned !== false)
    if (pinned === false) {
      // 取消置顶后**留在原处**:置顶项排在同层最前,所以把它钉在当前画面第一位,
      // 否则它会按旧的 order 跳回列表中间/末尾(用户明确不要这种跳动)。
      registry.placeNote(workspace.key, noteId, note.collectionId ?? null, 0)
    }
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
  async readNote({ sessionId, path, workspaceKey = null }) {
    if (String(path ?? '').trim() === '') throw new NotesError('read 需要 path', 'INVALID')
    const fs = this.ctx.fs
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const { target, absolute } = await this.resolveNotePath(path, workspace.root)
    const info = await fs.stat(target, this.abort.signal)
    if (info === undefined || info.type !== 'file') throw new NotesError(`文件不存在:${absolute}`, 'NOT_FOUND')
    const text = await fs.readText(target, this.abort.signal)
    return { text, version: String(info.version), absolutePath: absolute }
  }

  /** 跨工作区映射:把别的工作区的笔记挂进本工作区树。 */
  async reference({ sessionId, noteId, collectionId = null, workspaceKey = null }) {
    const registry = await this.ensureLoaded()
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    if (!registry.addReference(workspace.key, noteId, collectionId)) throw new NotesError('笔记不存在', 'NOT_FOUND')
    await this.persist()
    return true
  }

  /** 去掉跨工作区映射(不动笔记本身)。 */
  async unreference({ sessionId, noteId, workspaceKey = null }) {
    const registry = await this.ensureLoaded()
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    if (!registry.removeReference(workspace.key, noteId)) throw new NotesError('映射不存在', 'NOT_FOUND')
    await this.persist()
    return true
  }

  /* ------------------------------------------------------------------ */
  /* 分类                                                                */
  /* ------------------------------------------------------------------ */

  /** 分类操作(create/rename/move/delete)。 */
  async collection({ sessionId, op, collectionId, name, parentId = null, mode, index = null, workspaceKey = null }) {
    const registry = await this.ensureLoaded()
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
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
  async createNote({ sessionId, title, collectionId = null, workspaceKey = null }) {
    const wanted = String(title ?? '').trim()
    if (wanted === '') throw new NotesError('新建笔记需要非空 title', 'INVALID')
    const fs = this.ctx.fs
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
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
    await fs.writeText(target, body, { kind: 'createIfAbsent' }, this.abort.signal, this.policyFor(sessionId, workspace.root))
    return this.register({ sessionId, path: absolute, collectionId, workspaceKey })
  }

  /* ------------------------------------------------------------------ */
  /* 内容保存(编辑器用)                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 守卫式保存:版本不符 → `FS_STALE_VERSION`(带上当前版本与当前内容)。
   * @returns `{ version, path }`。
   */
  async save({ sessionId, path, text, expectedVersion, workspaceKey = null }) {
    if (String(path ?? '').trim() === '') throw new NotesError('save 需要 path', 'INVALID')
    if (typeof text !== 'string') throw new NotesError('save 需要 text', 'INVALID')
    const fs = this.ctx.fs
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
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
    // 身份标识自愈:预览模式把 frontmatter 收成一个 chip,用户可能整段删掉/改错。
    // 只要这篇笔记在索引里有 id,保存时就按索引里的 id 写回(并在响应里说明),
    // 否则"删掉 frontmatter"会让笔记失去身份(改名/移动后就认不出来了)。
    const registry = await this.ensureLoaded()
    const note = registry.noteByPath(absolute)
    let payload = text
    let restoredId = false
    if (note !== undefined && readNoteId(text) !== note.id) {
      payload = mintFrontmatter(text, note.id)
      restoredId = true
    }
    try {
      const outcome = await fs.writeText(
        target,
        payload,
        { kind: 'replaceIfVersion', version: info.version },
        this.abort.signal,
        this.policyFor(sessionId, workspace.root),
      )
      // 标题 = 文件名(Obsidian 模型):正文里的 `# 标题` **不再**回写树上的名字。
      // (旧实现每次保存都用 H1 覆盖 title,导致"树上名字 ≠ 文件名";要改名请用重命名。)
      return { version: String(outcome.version), path: absolute, restoredId, text: payload }
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
  async saveAsset({ sessionId, noteId, bytes, extension, workspaceKey = null }) {
    if (this.config.pasteImage !== 'copy') throw new NotesError('配置为 link 模式,不复制资产', 'INVALID')
    const fs = this.ctx.fs
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
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
  /* 工作区文件索引(三类分类的基础)                                     */
  /* ------------------------------------------------------------------ */

  /** 索引目录(与 registry.json 同级)。 */
  storeRoot() {
    return dirOfNative(this.storeFile())
  }

  /** 某个工作区的扫描索引文件(只存 relPath → {v,s,id},不塞进 registry)。 */
  indexFile(workspaceKey) {
    return join(this.storeRoot(), 'index', `${workspaceKey}.json`)
  }

  /** 读扫描索引(缺失/损坏都当空)。 */
  async readScanIndex(workspaceKey) {
    try {
      const text = await readFile(this.indexFile(workspaceKey), 'utf8')
      const parsed = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.files !== 'object') return { at: 0, files: {} }
      return { at: Number(parsed.at ?? 0), files: parsed.files ?? {} }
    } catch {
      return { at: 0, files: {} }
    }
  }

  /** 写扫描索引(临时文件 + 原子替换,与 registry 同款)。 */
  async writeScanIndex(workspaceKey, value) {
    const file = this.indexFile(workspaceKey)
    await mkdir(dirOfNative(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    await writeFile(tmp, `${JSON.stringify(value)}\n`, 'utf8')
    await rename(tmp, file)
  }

  /**
   * 只读文件开头一点点,解出 `dsh-note-id`。
   *
   * 用 `readByteRange`(harness 的窗口读,不会整文件缓冲);拿不到就退化成 readText。
   * 4KB 之外才有 frontmatter 的文件极少见;真遇到也只是"这次没读出 id",
   * 对账按**路径**判断存亡,不会因此丢条目。
   * @param target - 文件 target。
   * @param size - 文件字节数。
   * @returns 笔记 id 或 null。
   */
  async readNoteIdOf(target, size) {
    if ((size ?? 0) > ID_SCAN_MAX_BYTES) return null
    const fs = this.ctx.fs
    let text = ''
    if (typeof fs.readByteRange === 'function') {
      try {
        const bytes = await fs.readByteRange(target, { offset: 0, length: FRONTMATTER_SCAN_BYTES }, this.abort.signal)
        text = new TextDecoder().decode(bytes)
      } catch {
        text = ''
      }
    } else {
      try {
        text = await fs.readText(target, this.abort.signal)
      } catch {
        text = ''
      }
    }
    return text === '' ? null : readNoteId(text)
  }

  /**
   * 这个工作区这次要走的目录(工作区相对);空表示用 `notesDir`。
   * @param workspace - 工作区节点。
   * @returns 规范化去重后的根列表(空串 = 工作区根)。
   */
  scanRootsOf(workspace) {
    const configured = Array.isArray(workspace.scanRoots) ? workspace.scanRoots : []
    const roots = configured.length > 0 ? configured : [String(this.config.notesDir ?? 'notes')]
    const cleaned = roots
      .map((root) => String(root ?? '').replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, ''))
      .filter((root, index, list) => list.indexOf(root) === index)
    return cleaned.length > 0 ? cleaned : ['']
  }

  /**
   * 走一遍扫描范围内的目录(只有 listDir,不 stat、不读正文)。
   *
   * **实测**:本机(WSL + /mnt/d drvfs + 沙箱 provider)一次 `listDir` 约 **330ms**
   * (1268 个目录 = 7 分钟),所以这里有三个保险:
   *   ① 扫描范围默认只有 `notesDir`(小、快);要看别处由用户/Agent 显式加根;
   *   ② 单次 `listDir` 有期限(provider 卡住不会永久挂住整个扫描);
   *   ③ 一趟走不完就把**队列前沿**留在内存里(见 walkStates),下次调用接着走 ——
   *      否则每次都从根开始,永远只能看到最前面那几十个目录。
   * @param workspaceKey - 工作区键。
   * @param workspace - 工作区节点。
   * @param registry - 索引(读忽略规则)。
   * @param options - `budgetMs` 本次最多走多久。
   * @returns `{ files, dirs, truncated, error, done, resumed }`。
   */
  async walkWorkspace(workspaceKey, workspace, registry, { budgetMs = WALK_BUDGET_MS } = {}) {
    const fs = this.ctx.fs
    const depth = Number.isFinite(this.config.scanDepth) ? this.config.scanDepth : 8
    const maxFiles = Number.isFinite(this.config.scanMaxFiles) ? this.config.scanMaxFiles : 5000
    const maxDirs = Number.isFinite(this.config.scanMaxDirs) ? this.config.scanMaxDirs : WALK_MAX_DIRS
    let state = this.walkStates.get(workspaceKey)
    const resumed = state !== undefined && state.queue.length > 0
    if (!resumed) {
      state = { queue: [], files: [], dirs: 0, startedAt: Date.now(), error: null, missingRoots: [], roots: [] }
      for (const rel of this.scanRootsOf(workspace)) {
        const absolute = rel === '' ? workspace.root : join(workspace.root, rel)
        state.roots.push(rel)
        try {
          const target = await withTimeout(fs.resolve(absolute, {}), LIST_DIR_TIMEOUT_MS)
          state.queue.push({ target, level: 0, rel, isRoot: true })
        } catch (caught) {
          state.missingRoots.push(rel)
          if (state.error === null) state.error = `解析扫描根 ${rel || '.'} 失败:${caught?.message ?? caught}`
        }
      }
    }
    const started = Date.now()
    const progress = this.scanProgress.get(workspaceKey) ?? { phase: 'walk', dirs: 0, files: 0, startedAt: started, error: null }
    this.scanProgress.set(workspaceKey, progress)
    while (state.queue.length > 0) {
      if (Date.now() - started > budgetMs || state.dirs >= maxDirs || state.files.length >= maxFiles) {
        state.truncatedBy = state.files.length >= maxFiles ? 'files' : 'budget'
        break
      }
      const current = state.queue.shift()
      let entries
      try {
        entries = await withTimeout(fs.listDir(current.target, this.abort.signal), LIST_DIR_TIMEOUT_MS)
      } catch (caught) {
        // 扫描根本身列不出来 → 记成"这个工作区还没有笔记根"(界面用),不要当成错误吓人
        if (current.isRoot === true && !state.missingRoots.includes(current.rel)) state.missingRoots.push(current.rel)
        if (state.error === null) state.error = `${current.rel === '' ? '.' : current.rel}: ${caught?.message ?? caught}`
        continue
      }
      state.dirs += 1
      progress.dirs = state.dirs
      progress.files = state.files.length
      for (const entry of entries) {
        const rel = current.rel === '' ? entry.name : `${current.rel}/${entry.name}`
        if (entry.type === 'directory') {
          if (current.level + 1 > depth) continue
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
          if (registry.isGlobIgnored(workspaceKey, rel)) continue
          state.queue.push({ target: entry.target, level: current.level + 1, rel })
          continue
        }
        if (entry.type !== 'file' || !looksLikeMarkdown(entry.name)) continue
        // 只按 glob 剪枝:精确忽略的文件留在结果里(见 isGlobIgnored 的说明)
        if (registry.isGlobIgnored(workspaceKey, rel)) continue
        if (state.files.length >= maxFiles) break
        state.files.push({
          target: entry.target,
          path: normalizePath(fs.processPath(entry.target)),
          relPath: rel,
          version: String(entry.version ?? ''),
          size: entry.size ?? 0,
        })
      }
    }
    const done = state.queue.length === 0
    if (done) this.walkStates.delete(workspaceKey)
    else this.walkStates.set(workspaceKey, state)
    progress.files = state.files.length
    if (done) progress.phase = 'done'
    return {
      files: state.files,
      dirs: state.dirs,
      truncated: !done || state.truncatedBy === 'files',
      error: state.error,
      missingRoots: state.missingRoots ?? [],
      /** 所有扫描根都列不出来 = 这个工作区还没有笔记根。 */
      missingRoot: (state.roots?.length ?? 0) > 0 && (state.missingRoots?.length ?? 0) >= (state.roots?.length ?? 0),
      done,
      resumed,
    }
  }

  /**
   * 扫描扫描范围内的 md(带**增量索引** + **可分次续走**)。
   *
   * 调用时机:打开纳入面板 / 显式重扫 / 缓存过期。一趟没走完(done=false)时,
   * 下次调用**接着走**(队列前沿留在 walkStates),直到走完;走完之前不写缓存、
   * 也不做"文件消失"的对账(见 runWorkspaceScan)。
   * @param workspaceKey - 工作区键。
   * @param options - `force` 忽略 TTL。
   * @returns 扫描结果 `{ files, dirs, truncated, done, error, timing, changed, ... }`。
   */
  async scanWorkspace(workspaceKey, { force = false } = {}) {
    const registry = await this.ensureLoaded()
    const workspace = registry.workspaceOf(workspaceKey)
    if (workspace === undefined) throw new NotesError('工作区未登记', 'WORKSPACE_UNKNOWN')
    const cached = this.workspaceScans.get(workspaceKey)
    const ttl = Number.isFinite(this.config.workspaceScanTtlMs) ? this.config.workspaceScanTtlMs : 60000
    // 只有**上一趟走完**的结果才算缓存;没走完要继续走(分块收敛)
    if (!force && cached?.result?.done === true && Date.now() - cached.at < ttl) return cached.result
    if (this.scanningWorkspace.has(workspaceKey)) return cached?.result ?? EMPTY_WORKSPACE_SCAN
    this.scanningWorkspace.add(workspaceKey)
    try {
      return await this.runWorkspaceScan(workspaceKey, workspace, registry)
    } finally {
      this.scanningWorkspace.delete(workspaceKey)
      this.scanProgress.delete(workspaceKey)
    }
  }

  /**
   * 走一块 + 读新文件的 frontmatter + 落索引(只由 {@link NoteService#scanWorkspace} 调用)。
   * @param workspaceKey - 工作区键。
   * @param workspace - 工作区节点。
   * @param registry - 索引。
   * @returns 扫描结果。
   */
  async runWorkspaceScan(workspaceKey, workspace, registry) {
    const previous = await this.readScanIndex(workspaceKey)
    const budget = Number.isFinite(this.config.walkBudgetMs) ? this.config.walkBudgetMs : WALK_BUDGET_MS
    const walkStarted = Date.now()
    const walk = await this.walkWorkspace(workspaceKey, workspace, registry, { budgetMs: budget })
    const walkMs = Date.now() - walkStarted
    const progress = this.scanProgress.get(workspaceKey)
    if (progress !== undefined) progress.phase = 'read'
    const readStarted = Date.now()
    const files = { ...previous.files }
    let changed = 0
    for (const entry of walk.files) {
      const before = previous.files?.[entry.relPath]
      if (before !== undefined && before.v === entry.version && before.s === entry.size) {
        files[entry.relPath] = before
        continue
      }
      const id = entry.id !== undefined ? entry.id : await this.readNoteIdOf(entry.target, entry.size)
      entry.id = id
      files[entry.relPath] = { v: entry.version, s: entry.size, id }
      changed += 1
    }
    const readMs = Date.now() - readStarted
    await this.writeScanIndex(workspaceKey, { version: SCAN_INDEX_VERSION, at: Date.now(), files })
    // 对账:只有**整趟走完且没被截断**时,才允许把"没扫到"当"文件没了"
    const scanned = walk.files.map((entry) => ({
      path: entry.path,
      title: titleOf(entry.path),
      id: entry.id ?? null,
    }))
    const applied =
      walk.done && !walk.truncated
        ? registry.applyScan(workspaceKey, scanned, { scopeRoot: workspace.root })
        : { rebound: 0, dropped: 0, outside: [] }
    const result = {
      at: Date.now(),
      files: walk.files.map((entry) => ({
        path: entry.path,
        relPath: entry.relPath,
        id: entry.id ?? files[entry.relPath]?.id ?? null,
        size: entry.size,
        at: Number(entry.version) || 0,
      })),
      dirs: walk.dirs,
      truncated: walk.truncated,
      done: walk.done,
      resumed: walk.resumed,
      error: walk.error ?? null,
      missingRoot: walk.missingRoot === true,
      timing: { walkMs, readMs },
      changed,
      rebound: applied.rebound ?? 0,
      dropped: applied.dropped ?? 0,
      outside: applied.outside ?? [],
    }
    this.workspaceScans.set(workspaceKey, { at: Date.now(), result })
    await this.persist()
    return result
  }

  /**
   * 三类分类:已纳入(笔记)/ 未纳入未标记(候选)/ 未纳入且标为杂项(忽略)。
   *
   * 纯内存计算(走目录在 {@link NoteService#scanWorkspace} 里),过滤/排序/截断在这里做。
   * @param workspaceKey - 工作区键。
   * @param options - `force` 重扫;`query` 子串过滤;`sort` `recent|path`;`folder` 前缀;`limit`。
   * @returns 分类结果。
   */
  async classify(workspaceKey, { force = false, query = '', sort = 'recent', folder = '', limit = 500 } = {}) {
    const registry = await this.ensureLoaded()
    const workspace = registry.workspaceOf(workspaceKey)
    if (workspace === undefined) throw new NotesError('工作区未登记', 'WORKSPACE_UNKNOWN')
    const scan = await this.scanWorkspace(workspaceKey, { force })
    const state = registry.toJSON()
    const known = new Map()
    for (const note of Object.values(state.notes)) {
      if (note.workspaceKey !== workspaceKey) continue
      known.set(normalizePath(note.path), note)
    }
    const seen = new Set()
    const candidates = []
    const ignored = []
    for (const file of scan.files) {
      seen.add(file.relPath)
      if (known.has(normalizePath(file.path))) continue
      const entry = {
        path: file.path,
        relPath: file.relPath,
        title: titleOf(file.path),
        id: file.id ?? null,
        folder: dirOf(file.relPath) === '' ? '' : dirOf(file.relPath),
        bytes: file.size,
        at: file.at,
      }
      if (registry.isIgnored(workspaceKey, file.relPath)) ignored.push(entry)
      else candidates.push(entry)
    }
    // 精确忽略项里已经不存在的路径:顺手清掉(glob 规则留着)
    const exact = (state.workspaces[workspaceKey]?.ignored ?? []).filter((path) => seen.has(path))
    if (exact.length !== (state.workspaces[workspaceKey]?.ignored ?? []).length) {
      registry.setIgnored(workspaceKey, { paths: (state.workspaces[workspaceKey]?.ignored ?? []).filter((path) => !seen.has(path)) }, { on: false })
      await this.persist()
    }
    const match = (entry) => {
      if (folder !== '' && !entry.relPath.startsWith(folder.endsWith('/') ? folder : `${folder}/`) && entry.relPath !== folder) return false
      if (query !== '') {
        const needle = query.toLowerCase()
        if (!entry.relPath.toLowerCase().includes(needle) && !entry.title.toLowerCase().includes(needle)) return false
      }
      return true
    }
    const order = (list) =>
      list
        .filter(match)
        .sort((left, right) => (sort === 'path' ? left.relPath.localeCompare(right.relPath) : right.at - left.at || left.relPath.localeCompare(right.relPath)))
    const capped = Math.max(1, Math.min(2000, Number(limit) || 500))
    const candidateList = order(candidates)
    const ignoredList = order(ignored)
    const notes = [...known.values()]
      .map((note) => ({
        id: note.id,
        title: note.title,
        path: note.path,
        relPath: relativePath(workspace.root, note.path),
        collectionId: note.collectionId ?? null,
      }))
      .sort((left, right) => left.relPath.localeCompare(right.relPath))
    return {
      workspace: { key: workspaceKey, root: workspace.root, name: workspace.name, notesRoot: workspace.notesRoot },
      notes,
      candidates: candidateList.slice(0, capped),
      ignored: ignoredList.slice(0, capped),
      ignoredGlobs: state.workspaces[workspaceKey]?.ignoredGlobs ?? [],
      ignoredPaths: exact,
      stats: {
        notes: notes.length,
        candidates: candidateList.length,
        ignored: ignoredList.length,
        total: scan.files.length,
        changed: scan.changed,
        dirs: scan.dirs,
      },
      truncated: scan.truncated === true,
      indexAt: scan.at,
      /** 扫描时的首个错误(provider 拒绝/超时),界面要如实显示。 */
      scanError: scan.error ?? null,
      /** 扫描根不存在(界面显示空态卡片,不显示 provider 原文)。 */
      notesDirMissing: scan.missingRoot === true,
      /** 正在扫时的进度(面板显示"已看 N 个目录");不在扫时为 null。 */
      scanProgress: this.scanProgress.get(workspaceKey) ?? null,
      /** 还有目录没走完(前端应继续拉,直到 false)。 */
      scanning: scan.done === false,
      scanRoots: this.scanRootsOf(workspace),
    }
  }

  /**
   * 批量纳入(逐条走 {@link NoteService#register},所以已纳入的会被幂等跳过)。
   * @param options - `sessionId`;`paths` 工作区相对或绝对;`collectionId`。
   * @returns `{ included, failed }`。
   */
  async includePaths({ sessionId, paths = [], collectionId = null, workspaceKey = null }) {
    const included = []
    const failed = []
    for (const path of paths) {
      try {
        included.push(await this.register({ sessionId, path, collectionId }))
      } catch (error) {
        failed.push({ path: String(path), message: error?.message ?? String(error) })
      }
    }
    if (included.length > 0) {
      const workspace = await this.workspaceOf(sessionId, workspaceKey)
      this.workspaceScans.delete(workspace.key)
      this.scans.delete(workspace.key)
    }
    return { included, failed }
  }

  /**
   * 批量标为杂项 / 放回候选(不动文件)。
   * @param options - `sessionId`;`paths` / `globs`;`on: false` = 取消忽略。
   * @returns 变更后的忽略列表 + 分类。
   */
  async ignorePaths({ sessionId, paths = [], globs = [], on = true, workspaceKey = null }) {
    const registry = await this.ensureLoaded()
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const result = registry.setIgnored(workspace.key, { paths, globs }, { on })
    // 取消忽略后这些文件要重新能被看见:清掉缓存里的"这一次扫描"结果即可
    this.workspaceScans.delete(workspace.key)
    await this.persist()
    return { ...result, workspaceKey: workspace.key }
  }

  /**
   * 设置「扫描范围」(工作区相对目录;空数组 = 回到 notesDir)。
   *
   * 默认只扫 notesDir:本机实测一次 listDir 约 330ms,扫整个工作区要按分钟算,
   * 所以"要多看哪里"必须由用户/Agent 说出来(面板上就是"扫描范围"那一行)。
   * @param options - `sessionId`;`roots` 目录列表(`''`/`.` = 工作区根)。
   * @returns 规范化后的根列表。
   */
  async setScanRoots({ sessionId, roots = [], workspaceKey = null }) {
    const registry = await this.ensureLoaded()
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const list = Array.isArray(roots) ? roots : []
    const node = registry.workspace(workspace.key)
    node.scanRoots = list.map((root) => String(root ?? '').replace(/\\/g, '/'))
    this.workspaceScans.delete(workspace.key)
    this.walkStates.delete(workspace.key)
    await this.persist()
    return { scanRoots: this.scanRootsOf(node) }
  }

  /* ------------------------------------------------------------------ */
  /* 树(UI / 工具共用)                                                  */
  /* ------------------------------------------------------------------ */

  /** 组装一棵树(分类计数 + 本工作区笔记 + 跨工作区映射 + 未纳入)。
   *
   * **不阻塞式扫描**:只有本工作区还没有分类缓存时才同步扫一次;缓存过期(超过
   * `scanTtlMs`)时**在后台**重扫,先把当前缓存返回给界面 —— 大工作区里走一遍目录
   * 要几秒,不能卡住每次刷新。
   * @param options - `sessionId`;`force` 同步重扫(重扫按钮与工具走这条)。
   */
  async tree({ sessionId, workspaceKey = null, force = false } = {}) {
    const registry = await this.ensureLoaded()
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const cached = this.scans.get(workspace.key)
    let scan = cached?.result
    if (scan === undefined || force) {
      scan = await this.reconcile(workspace.key, { force: true })
    } else if (Date.now() - (cached.at ?? 0) > (Number.isFinite(this.config.scanTtlMs) ? this.config.scanTtlMs : 8000)) {
      // 后台刷新兜底:监视器在本机不一定可靠(WSL/drvfs 实测没触发),所以用 TTL 保证
      // 「外部改动最多 scanTtlMs + 客户端轮询间隔」之后一定会出现在界面上。
      void this.reconcile(workspace.key, { force: true }).catch((error) => {
        this.logger?.debug?.('[dsh-notes] 后台重扫失败:%s', error?.message ?? error)
      })
    }
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
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || left.order - right.order || left.title.localeCompare(right.title, 'zh-Hans-CN'))
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
      scanReport: scan.report ?? null,
      /** 这个工作区还没有笔记根目录(界面据此显示空态卡片,而不是报错)。 */
      notesDirMissing: scan.missingRoot === true,
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
    let failed = 0
    for (const path of paths) {
      if (this.watchers.has(path)) continue
      try {
        const target = await fs.resolve(path, {})
        const dispose = await fs.watch(target, () => this.markDirty(workspaceKey), this.abort.signal)
        this.watchers.set(path, dispose)
      } catch (error) {
        failed += 1
        this.logger?.debug?.('[dsh-notes] 监视失败 %s:%s', path, error?.message ?? error)
      }
    }
    if (failed > 0 && this.watchWarned !== true) {
      // 只报一次:本机(WSL/drvfs)实测监视器可能整个挂不上,那时靠 tree() 的 TTL 后台重扫兜底。
      this.watchWarned = true
      this.logger?.info?.('[dsh-notes] 有 %d 条文件监视挂不上,外部改动将退化为 TTL 轮询', failed)
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
    this.scanning.clear()
    this.scanningWorkspace.clear()
    this.workspaceScans.clear()
    this.scanProgress.clear()
    this.walkStates.clear()
    this.autoCreatedDirs.clear()
  }
}

/**
 * 给一个 promise 加期限(provider 卡住时用来兜底)。
 * @param promise - 原始 promise。
 * @param ms - 期限(毫秒)。
 * @returns 原结果,或超时错误。
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时(${ms}ms)`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** 把工作区的笔记根覆盖应用到节点上,并返回最终笔记根。 */
function applyNotesRootOverride(node) {
  const override = typeof node?.notesRootOverride === 'string' ? node.notesRootOverride.trim() : ''
  if (override !== '') node.notesRoot = normalizePath(override)
  return node?.notesRoot ?? ''
}

/** `path` 是否就是 `root` 或在其之内(规范化后按段比较)。 */
function isInsidePath(root, path) {
  const base = normalizePath(root)
  const target = normalizePath(path)
  return target === base || target.startsWith(`${base}/`)
}

/** 原生路径的目录部分(node:path 语义,给索引文件用)。 */
function dirOfNative(file) {
  const index = file.lastIndexOf('/')
  const alt = file.lastIndexOf('\\')
  const cut = Math.max(index, alt)
  return cut <= 0 ? '.' : file.slice(0, cut)
}
