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
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  applyEol,
  assetFileName,
  baseName,
  detectEol,
  dirOf,
  EOL_SAMPLE_BYTES,
  isAbsolutePath,
  looksLikeMarkdown,
  mintNoteId,
  mintFrontmatter,
  mtimeOfVersion,
  normalizeEol,
  normalizePath,
  readNoteId,
  relativeToWorkspace,
  relativePath,
  sanitizeFileName,
  SKIP_DIRS,
  titleOf,
  workspaceKeyOf,
} from './notes.js'
import { NoteRegistry, emptyState, stateFromJSON } from './registry.js'
import {
  entriesOf as historyEntriesOf,
  isValidEntryFile,
  nextEntryFile,
  normalizeHistory,
  predecessorOf,
  upsertEntry,
} from './history.js'
import {
  STORE_GITIGNORE,
  adoptWorkspaceKey,
  isEmptySlice,
  cacheFileFor,
  emptyRoots,
  historyIndexFileFor as historyIndexFileOf,
  historyRootFor as historyRootOf,
  homeStoreFile as homeStoreFileOf,
  homeStoreRoot,
  mergeSlice,
  normalizeRoots,
  pluckWorkspace,
  relativizeState,
  resolveStoreScope,
  rootsFile,
  rootsFromLegacy,
  sliceFor,
  storeFileFor as storeFileOf,
  trashIndexFileFor as trashIndexFileOf,
  trashRootFor as trashRootOf,
  upsertRoot,
} from './store.js'

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
/**
 * 一次版本探针(`statNotes`)最多接受多少条路径。
 *
 * 客户端每 1.5s 拿**本布局所有打开标签**来问一次(分屏最多 2×8 = 16 条),
 * 这里留足余量再封顶 —— 探针只 stat、不读正文,所以真正的成本就在条数上。
 */
const STAT_PATHS_MAX = 64
/** 还没有任何扫描结果时返回的空分类(并发期间被问到就给它这个)。 */
const EMPTY_SCAN = { files: [], truncated: false, unfiled: [], report: null }
/**
 * 单条历史快照的体积上限(字节)。
 *
 * 超过就**不记**(读都不读):历史是兜底,不是归档;一篇 5MB 的笔记每改一次存一份,
 * 很快就能把工作区撑爆。上限之内的正常笔记(实测那篇 123KB)完全够用。
 */
const HISTORY_MAX_ENTRY_BYTES = 2 * 1024 * 1024
/** 一次扫描最多补记多少条历史(首次为存量笔记建基线时防止一口气写几百个文件)。 */
const HISTORY_CAPTURE_PER_SCAN_MAX = 50

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
    /**
     * 每个工作区一份 registry(键 = 当前 root 派生的 workspaceKey)。
     *
     * 语义数据跟着工作区走之后,"索引"不再是全局单例 —— 但 `home` 形态(逃生开关)
     * 仍然是全局一份,那时 `registries` 里所有键都指向同一个实例(见 {@link NoteService#registryFor})。
     */
    this.registries = new Map()
    /** 正在装载的工作区键 → Promise(并发调用不再重复读盘)。 */
    this.registryLoading = new Map()
    /** 机器本地的"已知工作区根"(`workspaces.json`)与它的落盘去重文本。 */
    this.rootsState = null
    this.rootsLoading = null
    this.lastRootsText = null
    /** 已经在**本进程**里写过 `.dsh-notes/.gitignore` 的目录(避免反复 stat)。 */
    this.gitignoreDirs = new Set()
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
    /**
     * 会话 → 它当前选中的工作区键。
     *
     * 只用来判断"是不是换了工作区"(见 {@link NoteService#touchWorkspace}):
     * 换了才更新 `lastUsedAt`,否则 4s 轮询会把索引内容搞得每 8s 变一次。
     */
    this.sessionWorkspace = new Map()
    this.persistChain = Promise.resolve()
    /**
     * 每个工作区**上一次真正写进磁盘**的内容(内容去重)。
     *
     * 为什么要去重:对账每 8s 后台跑一次(TTL),以前它无条件落盘 → 本机实测
     * registry.json 每 ~8s 整份重写一次(tmp 文件 + rename),零变化也写。
     * `home` 形态用固定的 `'*'` 键(全局一份)。
     */
    this.lastPersisted = new Map()
    /** workspaceKey → { at, result }:扫描结果的短缓存(冷却期内直接复用)。 */
    this.scans = new Map()
    /** 绝对路径 → watcher disposer。 */
    this.watchers = new Map()
    this.abort = new AbortController()
    this.dirty = new Set()
    this.flushTimer = null
    /** 变更通知(客户端 SSE / 轮询用)。 */
    this.onChanged = null
    /**
     * 历史索引的**串行链**。
     *
     * 索引是"读 → 追加 → 写"的整份读写,而捕获点可能同时来:agent 连写两下
     * (两个 tools/execute 钩子)、扫描与钩子撞在一起 —— 不串行化就会丢更新
     * (后写的把先写的覆盖掉)。与既有 `persistChain` 同一套路。
     */
    this.historyChain = Promise.resolve()
    /** 历史落盘失败只报一次(只读工作区/权限问题不该刷屏)。 */
    this.historyWarned = false
  }

  /* ------------------------------------------------------------------ */
  /* 存储位置:每个工作区一份索引(默认)                                  */
  /* ------------------------------------------------------------------ */

  /**
   * 存储形态。
   *
   * - `workspace`(默认):语义数据(分类树 / 归属 / 忽略 / 置顶 / 回收站)放在
   *   `<工作区>/.dsh-notes/` —— **跟着工作区走**,备份或搬到别的机器,装上插件就能原样读出来。
   * - `home`:旧版行为(全部塞进 `$DSH_HOME/knowledge/registry.json`),用于只读/共享仓库或应急回退。
   */
  storeScope() {
    return resolveStoreScope(this.config)
  }

  /** 机器本地的 knowledge 根(扫描缓存 + 已知工作区根 + 旧整体索引)。 */
  homeRoot() {
    return homeStoreRoot(this.config, process.env, homedir())
  }

  /** **旧的整体索引**文件:home 形态在用;workspace 形态只当迁移来源与备份。 */
  homeStoreFile() {
    return homeStoreFileOf(this.config, process.env, homedir())
  }

  /** 机器本地的"已知工作区根"文件(`workspaces.json`)。 */
  rootsPath() {
    return rootsFile(this.config, process.env, homedir())
  }

  /** 某个工作区根对应的薄索引文件。 */
  storeFileFor(root) {
    return storeFileOf(this.storeScope(), this.config, root, process.env, homedir())
  }

  /** 某个工作区根对应的回收站目录。 */
  trashRootFor(root) {
    return trashRootOf(this.storeScope(), this.config, root, process.env, homedir())
  }

  /** 某个工作区根对应的回收站索引文件。 */
  trashIndexFileFor(root) {
    return trashIndexFileOf(this.storeScope(), this.config, root, process.env, homedir())
  }

  /**
   * 装载机器本地的"已知工作区根"。
   *
   * 只放**路由信息**(哪个键对应哪个目录 + 最近使用时间),不放语义数据 ——
   * 所以它丢了不会丢分类树,只是"切换工作区"的列表要重新累积(打开工作区时按会话 cwd 自动登记)。
   * 升级路径:文件不存在时,从**旧的整体索引**里把根路径捞出来,于是列表不会空掉。
   */
  async loadRoots() {
    if (this.rootsState !== null) return this.rootsState
    if (this.rootsLoading !== null) return this.rootsLoading
    this.rootsLoading = (async () => {
      const file = this.rootsPath()
      try {
        const text = await readFile(file, 'utf8')
        this.rootsState = normalizeRoots(JSON.parse(text))
        this.lastRootsText = `${JSON.stringify(this.rootsState, null, 2)}\n`
        return this.rootsState
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          this.logger?.warn?.('[dsh-notes] 已知工作区表读不动(改从旧索引重建):%s', error?.message ?? error)
        }
      }
      let roots = emptyRoots()
      try {
        roots = rootsFromLegacy(stateFromJSON(await readFile(this.homeStoreFile(), 'utf8')))
      } catch {
        /* 全新用户:空表起步 */
      }
      this.rootsState = roots
      await this.persistRoots().catch(() => {})
      return roots
    })()
    return this.rootsLoading
  }

  /** 登记/更新一个已知工作区根(并落盘那一份小文件)。 */
  async registerRoot(key, patch) {
    const roots = await this.loadRoots()
    this.rootsState = upsertRoot(roots, key, patch)
    await this.persistRoots().catch((error) => {
      this.logger?.warn?.('[dsh-notes] 已知工作区表落盘失败:%s', error?.message ?? error)
    })
    return this.rootsState.workspaces[key]
  }

  /** 落盘机器本地的已知工作区表(内容去重 + 不毒化后续,与工作区索引同一套路)。 */
  persistRoots() {
    const payload = `${JSON.stringify(this.rootsState ?? emptyRoots(), null, 2)}\n`
    if (payload === this.lastRootsText) return this.persistChain
    this.persistChain = this.persistChain
      .catch((error) => {
        this.logger?.warn?.('[dsh-notes] 上一次落盘失败(已忽略,继续排队):%s', error?.message ?? error)
      })
      .then(async () => {
        if (payload === this.lastRootsText) return
        const file = this.rootsPath()
        await mkdir(dirOfNative(file), { recursive: true })
        const tmp = `${file}.tmp-${process.pid}`
        await writeFile(tmp, payload, 'utf8')
        await rename(tmp, file)
        this.lastRootsText = payload
      })
    return this.persistChain
  }

  /**
   * 取某个工作区的 registry(按需装载 + 缓存)。
   *
   * **为什么按工作区**:语义数据跟着工作区走之后,每个工作区有自己的一份文件;
   * 装载时会把文件里记录的键**改成当前 root 派生的键**(见 `adoptWorkspaceKey`)——
   * 于是"把工作区挪到别的目录/别的机器"不会因为键变了而读不出来。
   *
   * 文件缺失时会尝试从**旧的整体索引**迁移这个工作区的切片(升级路径,幂等);
   * 迁移成功了才落盘,单纯"打开看一眼"不会在工作区里留下空目录。
   * @param key - 工作区键。
   * @param init - `{ root, name, notesRoot }`(缺的字段不覆盖已有节点)。
   * @returns `NoteRegistry` 实例。
   */
  async registryFor(key, init = {}) {
    if (this.storeScope() === 'home') return this.legacyRegistryFor(key, init)
    const cached = this.registries.get(key)
    if (cached !== undefined) return cached
    const inflight = this.registryLoading.get(key)
    if (inflight !== undefined) return inflight
    const loading = (async () => {
      const known = this.rootsState?.workspaces?.[key]
      const root = String(init.root ?? known?.root ?? '').trim()
      // 没有根路径就没法定位工作区文件 —— 宁可报"未登记",也不能拿相对路径去写盘
      if (root === '') throw new NotesError(`未登记的工作区:${key}`, 'WORKSPACE_UNKNOWN')
      const file = this.storeFileFor(root)
      let registry = null
      let text = null
      let migrated = false
      try {
        text = await readFile(file, 'utf8')
        registry = new NoteRegistry(adoptWorkspaceKey(stateFromJSON(text), key, root))
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          const backup = `${file}.bad-${Date.now()}`
          try {
            await rename(file, backup)
          } catch {
            /* 备份失败也要能启动 */
          }
          this.logger?.warn?.('[dsh-notes] 工作区索引损坏,已备份到 %s:%s', backup, error?.message ?? error)
        }
        const slice = await this.readLegacySlice(key)
        registry = new NoteRegistry(adoptWorkspaceKey(slice === null ? emptyState() : slice, key, root))
        migrated = slice !== null
      }
      registry.workspace(key, { root, name: init.name, notesRoot: init.notesRoot })
      this.registries.set(key, registry)
      this.registryLoading.delete(key)
      // 磁盘原文记下来:内容没变时 persist() 直接跳过
      this.lastPersisted.set(key, text)
      if (migrated) {
        await this.persist(key)
        await this.registerRoot(key, { root, migratedAt: Date.now() })
        this.logger?.info?.('[dsh-notes] 已把工作区 %s 的索引迁进 %s', key, file)
      }
      return registry
    })()
    this.registryLoading.set(key, loading)
    return loading
  }

  /**
   * `home` 形态:全局一份 registry(旧行为,逃生开关)。
   * @param key - 工作区键。
   * @param init - `{ root, name, notesRoot }`。
   */
  async legacyRegistryFor(key, init = {}) {
    if (this.legacyRegistry === null || this.legacyRegistry === undefined) {
      if (this.registryLoading.get('*') !== undefined) await this.registryLoading.get('*')
      if (this.legacyRegistry === null || this.legacyRegistry === undefined) {
        const loading = (async () => {
          const file = this.storeFileFor(init.root ?? '')
          try {
            const text = await readFile(file, 'utf8')
            this.legacyRegistry = new NoteRegistry(stateFromJSON(text))
            this.lastPersisted.set('*', text)
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
            this.legacyRegistry = new NoteRegistry()
            this.lastPersisted.set('*', null)
          }
          this.registryLoading.delete('*')
          return this.legacyRegistry
        })()
        this.registryLoading.set('*', loading)
        await loading
      }
    }
    const registry = this.legacyRegistry
    registry.workspace(key, { root: init.root, name: init.name, notesRoot: init.notesRoot })
    this.registries.set(key, registry)
    return registry
  }

  /**
   * 按笔记 id 找到它所属的工作区。
   *
   * 索引按工作区拆开之后,`noteId` 不再有"全局表"可查:先看已装载的,再按机器本地的
   * 已知根表挨个装载(命中即停)。找不到就返回 `null` —— 调用方负责报 NOT_FOUND。
   * @param noteId - 笔记 id。
   * @returns `{ key, registry, note }` 或 `null`。
   */
  async locateNote(noteId) {
    const id = String(noteId ?? '').trim()
    if (id === '') return null
    for (const [key, registry] of this.registries) {
      const note = registry.noteById(id)
      if (note !== undefined) return { key, registry, note }
    }
    const roots = await this.loadRoots()
    for (const [key, known] of Object.entries(roots.workspaces)) {
      if (this.registries.has(key)) continue
      let registry
      try {
        registry = await this.registryFor(key, { root: known.root, name: known.name })
      } catch {
        continue
      }
      const note = registry.noteById(id)
      if (note !== undefined) return { key, registry, note }
    }
    return null
  }

  /**
   * 取"拥有这篇笔记"的 registry:显式给了 `workspaceKey` 就只认那一个(与路由语义一致),
   * 否则按 id 反查。所有"只给 noteId"的旧调用(以及 knowledge 工具)都靠它保持行为不变。
   * @param noteId - 笔记 id。
   * @param workspaceKey - 可选:显式工作区键。
   * @returns `{ key, registry, note }` 或 `null`。
   */
  async registryOwningNote(noteId, workspaceKey = null) {
    const explicit = String(workspaceKey ?? '').trim()
    if (explicit === '') return this.locateNote(noteId)
    const known = (await this.loadRoots()).workspaces[explicit]
    if (known === undefined) throw new NotesError(`未登记的工作区:${explicit}`, 'WORKSPACE_UNKNOWN')
    const registry = await this.registryFor(explicit, { root: known.root, name: known.name })
    return { key: explicit, registry, note: registry.noteById(noteId) }
  }

  /**
   * 从**旧的整体索引**里取这个工作区的切片(升级用)。
   * @returns 切片 state;旧文件不存在或该工作区不在里面时 `null`。
   */
  async readLegacySlice(key) {
    try {
      const legacy = stateFromJSON(await readFile(this.homeStoreFile(), 'utf8'))
      const slice = sliceFor(legacy, key)
      if (Object.keys(slice.notes).length === 0 && Object.keys(slice.workspaces).length === 0) return null
      return slice
    } catch {
      return null
    }
  }

  /**
   * 串行落盘(临时文件 + rename 原子替换)。
   *
   * 三条硬要求,都是踩过坑才补的:
   *   1. **按工作区切片**:`workspace` 形态只写这一个工作区的笔记与节点(整体状态属于旧形态);
   *   2. **内容没变就不写**:对账每 8s 后台跑一次(TTL),以前它无条件落盘 → 实测每 ~8s
   *      整份重写一次(tmp + rename),零变化也写;
   *   3. **一次失败不能毒化后续**:`this.persistChain.then(...)` 一旦 reject,后面每次
   *      `.then` 都被跳过 —— 索引从此只活在内存里,重启即丢(而且没有任何提示)。
   *      所以先 `catch` 再挂新任务,失败只记日志。
   * @param key - 工作区键(`home` 形态忽略,写整份)。
   * @returns 本次(或最近一次)落盘链。
   */
  persist(key) {
    const registry = this.registries.get(key)
    if (registry === undefined) return this.persistChain
    const home = this.storeScope() === 'home'
    const root = String(registry.workspaceOf(key)?.root ?? '')
    // 工作区形态:除了按工作区切片,还把**环境相关的绝对路径换成工作区相对路径** ——
    // 这个文件就躺在工作区里,记绝对路径只会在工作区搬家后变成一堆死路径
    // (见 store.js 的 relativizeState)。`home` 形态是机器本地一份整体索引,
    // 里面装着多个工作区、还有跨工作区映射,只有绝对路径才说得清,所以保持原样。
    const payload = home
      ? `${JSON.stringify(registry.toJSON(), null, 2)}\n`
      : `${JSON.stringify(relativizeState(sliceFor(registry.toJSON(), key), key, root), null, 2)}\n`
    const dedupeKey = home ? '*' : key
    if (payload === this.lastPersisted.get(dedupeKey)) return this.persistChain
    // 只看一眼的工作区不配拥有一个点目录:磁盘上还没有文件、切片又空 → 不写
    // (一旦写过(比如登记过笔记),即使后来被清空也要如实写出去,所以只在 null 时跳)
    if (!home && this.lastPersisted.get(dedupeKey) === null && isEmptySlice(sliceFor(registry.toJSON(), key))) {
      return this.persistChain
    }
    this.persistChain = this.persistChain
      .catch((error) => {
        this.logger?.warn?.('[dsh-notes] 上一次索引落盘失败(已忽略,继续排队):%s', error?.message ?? error)
      })
      .then(async () => {
        // 排队期间可能已经有人写过同样的内容:再查一次,避免重复写
        if (payload === this.lastPersisted.get(dedupeKey)) return
        const file = this.storeFileFor(root)
        const dir = dirOfNative(file)
        await mkdir(dir, { recursive: true })
        await this.ensureStoreGitignore(dir)
        const tmp = `${file}.tmp-${process.pid}`
        await writeFile(tmp, payload, 'utf8')
        await rename(tmp, file)
        this.lastPersisted.set(dedupeKey, payload)
      })
    return this.persistChain
  }

  /**
   * 「读路径」上的落盘:失败只记日志,不往上抛。
   *
   * 为什么区分:对账/扫描是**读**动作,不该因为索引写不进去(只读挂载、共享仓库)就把
   * `tree()` 也搞失败 —— 界面还能用内存里的索引正常显示。而用户**显式写操作**
   * (登记/改名/删除/归类)仍然走 {@link NoteService#persist},写不进去就如实报错。
   * @param key - 工作区键。
   */
  async persistSafe(key) {
    try {
      await this.persist(key)
    } catch (error) {
      if (this.persistWarned !== true) {
        this.persistWarned = true
        this.logger?.warn?.('[dsh-notes] 索引写不进工作区(只读挂载?),本次只留在内存里:%s', error?.message ?? error)
      }
    }
  }

  /**
   * 工作区形态下,顺手在 `.dsh-notes/` 里放一个 `.gitignore`(`*`)。
   *
   * 目的只有一个:插件数据**不进用户的 `git status`**。用户不需要知道这件事,
   * 但少了它,每个工作区的 git 状态都会多一坨未跟踪文件。
   */
  async ensureStoreGitignore(dir) {
    if (this.storeScope() === 'home') return
    if (this.gitignoreDirs.has(dir)) return
    const file = normalizePath(join(dir, '.gitignore'))
    try {
      await readFile(file, 'utf8')
    } catch {
      try {
        await writeFile(file, STORE_GITIGNORE, 'utf8')
      } catch {
        /* 只读工作区:忽略即可,不影响索引 */
      }
    }
    this.gitignoreDirs.add(dir)
  }

  /**
   * 显式在两个存储形态之间搬一个工作区(`knowledge` 工具的 `migrate` op)。
   *
   * 自动迁移(home → workspace)是**懒**的:打开工作区时若工作区文件不存在,就从旧的整体索引
   * 拷一份过去、**旧文件原样保留**(备份)。而这个 op 是**移动**语义,用来处理
   * "我就是要换一种存法,不想两边各留一半"的情况。
   * - `toWorkspace`:旧索引里的这个工作区 → 写进 `<root>/.dsh-notes/index.json`,并从旧文件里摘掉;
   * - `toHome`:把工作区文件合并回旧的整体索引,原工作区文件**改名**留档(`.moved-<ts>`,不删)。
   * @param options - `sessionId`;`direction`;`workspaceKey`。
   * @returns `{ direction, workspaceKey, file, scope, moved? }`。
   */
  async migrateStore({ sessionId, direction, workspaceKey = null }) {
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const key = workspace.key
    const target = this.storeFileFor(workspace.root)
    const legacyFile = this.homeStoreFile()
    const readLegacy = async () => {
      try {
        return stateFromJSON(await readFile(legacyFile, 'utf8'))
      } catch {
        return null
      }
    }
    if (direction === 'toWorkspace') {
      if (this.storeScope() === 'home') throw new NotesError('当前是 home 形态(storeScope=home),工作区文件不是权威,无需搬运', 'INVALID')
      const legacy = await readLegacy()
      const slice = legacy === null ? null : sliceFor(legacy, key)
      if (slice === null) throw new NotesError('旧索引里没有这个工作区的数据', 'NOT_FOUND')
      await mkdir(dirOfNative(target), { recursive: true })
      await this.ensureStoreGitignore(dirOfNative(target))
      const tmp = `${target}.tmp-${process.pid}`
      await writeFile(tmp, `${JSON.stringify(slice, null, 2)}\n`, 'utf8')
      await rename(tmp, target)
      // **移动**语义:旧文件里摘掉这个工作区,免得两边各有一半、以后打架
      const tmpLegacy = `${legacyFile}.tmp-${process.pid}`
      await writeFile(tmpLegacy, `${JSON.stringify(pluckWorkspace(legacy, key), null, 2)}\n`, 'utf8')
      await rename(tmpLegacy, legacyFile)
      this.forgetWorkspace(key)
      return { direction, workspaceKey: key, file: target, scope: 'workspace' }
    }
    if (direction === 'toHome') {
      const registry = await this.registryFor(key, { root: workspace.root, name: workspace.name })
      const merged = mergeSlice((await readLegacy()) ?? emptyState(), sliceFor(registry.toJSON(), key), key)
      await mkdir(dirOfNative(legacyFile), { recursive: true })
      const tmp = `${legacyFile}.tmp-${process.pid}`
      await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
      await rename(tmp, legacyFile)
      // 工作区文件挪走留档(改名而不是删除:搬错了还能搬回来)
      const moved = `${target}.moved-${Date.now()}`
      try {
        await rename(target, moved)
      } catch {
        /* 本来就没有工作区文件 */
      }
      this.forgetWorkspace(key)
      return { direction, workspaceKey: key, file: legacyFile, moved, scope: 'home' }
    }
    throw new NotesError(`不认识的迁移方向:${direction}`, 'INVALID')
  }

  /** 丢掉某个工作区的内存态(搬运之后强制下一次重读)。 */
  forgetWorkspace(key) {
    this.registries.delete(key)
    this.lastPersisted.delete(key)
    this.invalidateScans(key)
  }

  /**
   * 按 id 取一篇笔记的条目(自动反查它属于哪个工作区)。
   *
   * 索引按工作区拆开之后,不存在"全局 `service.registry`"了;这个只读访问器给
   * 测试、诊断与工具用(写入路径仍然各自持有自己那份 registry)。
   * @param noteId - 笔记 id。
   * @param workspaceKey - 可选:限定工作区。
   * @returns 笔记条目;不存在时 `undefined`。
   */
  async noteById(noteId, workspaceKey = null) {
    const found = await this.registryOwningNote(noteId, workspaceKey)
    return found?.note ?? undefined
  }

  /**
   * 取某个工作区的索引节点(只读,给测试与诊断用)。
   * @param workspaceKey - 工作区键。
   * @returns 工作区节点;未登记时 `undefined`。
   */
  async workspaceNodeOf(workspaceKey) {
    const registry = await this.registryFor(workspaceKey)
    return registry.workspaceOf(workspaceKey)
  }

  /* ------------------------------------------------------------------ */
  /* 工作区                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * 解析会话的工作区(根 = 会话 cwd)。
   *
   * **必须给 sessionId**:给不出会话就不知道笔记属于哪个工作区,宁可报错。
   * 早期版本在解析不出 cwd 时退回进程 cwd,结果是**把笔记写到了进程家目录下的 `~/notes`**
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
    const roots = await this.loadRoots()
    // 显式给了 workspaceKey 就用它(**只认已登记的**,不能凭 sessionId 越界造工作区):
    // 笔记区域可以切换到别的已登记工作区,内容路由都带这个参数。
    const explicit = workspaceKey === null || workspaceKey === undefined ? '' : String(workspaceKey).trim()
    if (explicit !== '') {
      const known = roots.workspaces[explicit]
      if (known === undefined) throw new NotesError(`未登记的工作区:${explicit}`, 'WORKSPACE_UNKNOWN')
      const registry = await this.registryFor(explicit, { root: known.root, name: known.name })
      const node = registry.workspaceOf(explicit)
      if (node === undefined) throw new NotesError(`未登记的工作区:${explicit}`, 'WORKSPACE_UNKNOWN')
      await this.touchWorkspace(sessionId, explicit, node.root)
      const overridden = applyNotesRootOverride(node)
      return { key: explicit, root: node.root, name: node.name, notesRoot: overridden, node }
    }
    const info = this.resolveWorkspace(sessionId)
    const registry = await this.registryFor(info.key, info)
    const node = registry.workspace(info.key, { root: info.root, name: info.name, notesRoot: info.notesRoot })
    await this.touchWorkspace(sessionId, info.key, info.root)
    return { ...info, notesRoot: applyNotesRootOverride(node), node }
  }

  /**
   * 记一次「这个会话在用哪个工作区」。
   *
   * **只在会话换工作区时**更新 `lastUsedAt`。以前每次读都刷(4s 轮询的 `/tree`、每条路由),
   * 后果有两个:① 这个字段变成"最后轮询时间"而不是"最近选择";② 索引内容每 8s 就变一次,
   * 于是每次对账都要**整份重写**。
   *
   * 落点也换了:这个时间是"**这台机器**什么时候用过它",所以写在机器本地的已知根表里,
   * 不再写进工作区文件 —— 否则搬走的备份里会带着另一台机器的使用时间,而且每次切工作区
   * 都要往用户的仓库里写一次。
   * @param sessionId - 会话 id(可能为空:无会话的路由)。
   * @param key - 工作区键。
   * @param root - 工作区根(绝对路径,登记进已知根表)。
   */
  async touchWorkspace(sessionId, key, root) {
    const session = String(sessionId ?? '').trim()
    if (session !== '' && this.sessionWorkspace.get(session) === key) return
    if (session !== '') this.sessionWorkspace.set(session, key)
    await this.registerRoot(key, { root, lastUsedAt: Date.now() })
  }

  /**
   * 设置本工作区的笔记根(工作区内已存在的目录)。
   *
   * 为什么允许按工作区覆盖:不同仓库习惯不同(有的都放 `docs/`)。空态卡片上就能改。
   * @param options - `sessionId`;`workspaceKey`;`path` 工作区相对或绝对。
   * @returns `{ workspaceKey, notesRoot }`。
   */
  async setNotesRoot({ sessionId, workspaceKey = null, path }) {
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const fs = this.ctx.fs
    const absolute = await this.resolveInWorkspace(workspace, path)
    if (!isInsidePath(workspace.root, absolute)) throw new NotesError('笔记根必须在工作区之内', 'INVALID')
    const info = await fs.stat(await fs.resolve(absolute, {}), this.abort.signal)
    if (info === undefined || info.type !== 'directory') throw new NotesError(`目录不存在:${absolute}`, 'NOT_FOUND')
    const node = workspace.node
    node.notesRootOverride = absolute
    node.notesRoot = absolute
    node.scanRoots = []
    this.invalidateScans(workspace.key)
    await this.persist(workspace.key)
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
    await this.persist(workspace.key)
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
    await this.loadRoots()
    let current = null
    try {
      const info = this.resolveWorkspace(sessionId)
      current = info.key
      await this.registerRoot(info.key, { root: info.root, name: info.name })
    } catch {
      current = null
    }
    const fs = this.ctx.fs
    const rows = []
    // 列表来自**机器本地的已知根表**:语义数据在各个工作区自己的文件里,
    // 但"这台机器见过哪些工作区"是机器状态 —— 不能因为某个工作区的备份里带了
    // 别的机器的历史就把它显示出来。
    for (const [key, known] of Object.entries(this.rootsState.workspaces)) {
      const loaded = this.registries.get(key)
      const node = loaded?.workspaceOf(key)
      const root = node?.root ?? known.root
      const notesRoot = node !== undefined ? applyNotesRootOverride(node) : normalizePath(join(root, this.config.notesDir))
      const name = node !== undefined && node.name !== '' ? node.name : known.name
      let exists = true
      try {
        const info = await fs.stat(await fs.resolve(notesRoot, {}), this.abort.signal)
        exists = info !== undefined && info.type === 'directory'
      } catch {
        exists = false
      }
      rows.push({
        key,
        root,
        name: name === '' ? baseName(root) : name,
        notesRoot,
        notes: await this.countNotesOf(key, root),
        lastUsedAt: Number(known.lastUsedAt ?? 0),
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
   * 某个工作区当前的笔记条数。
   *
   * 装载过的直接数内存;没装载过的**只读它那一个小 JSON**(工作区文件里就只有这个工作区,
   * 所以数一下 `notes` 即可)。读不到(文件还没有 / 不是工作区形态)就是 0 —— 切换器上
   * 显示 0 比显示错数字要好。
   * @param key - 工作区键。
   * @param root - 工作区根。
   */
  async countNotesOf(key, root) {
    const loaded = this.registries.get(key)
    if (loaded !== undefined) return Object.keys(loaded.state.notes).length
    try {
      const state = adoptWorkspaceKey(stateFromJSON(await readFile(this.storeFileFor(root), 'utf8')), key, root)
      return Object.keys(state.notes ?? {}).length
    } catch {
      return 0
    }
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
    const key = workspaceKeyOf(absolute)
    const name = baseName(absolute)
    const notesRoot = normalizePath(join(absolute, this.config.notesDir))
    const registry = await this.registryFor(key, { root: absolute, name, notesRoot })
    const node = registry.workspace(key, { root: absolute, name, notesRoot })
    await this.registerRoot(key, { root: absolute, name, lastUsedAt: Date.now() })
    await this.persist(key)
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
        files.push({
          path,
          title: titleOf(path),
          id: text === '' ? null : readNoteId(text),
          // 历史快照要用:`version` 判"变了没有"(稳态零读取),`size` 判"是不是太大"。
          // 两个都是小字符串/数字,不会把扫描缓存撑大(正文不在这里留着)。
          version: String(entry.version ?? ''),
          size: Number(entry.size ?? 0),
        })
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
    const registry = await this.registryFor(workspaceKey)
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
    const registry = await this.registryFor(workspaceKey, { root: workspace.root })
    const { files, truncated, incomplete, missingRoot } = await this.scanNotesRoot(workspace.notesRoot, this.config.unfiledDepth)
    // **扫描不完整时绝不做"文件消失"的对账** —— 目录不存在/读不了的时候,以前会把
    // 该工作区已登记的笔记全部删掉(用户实测:笔记自己没了、打开的标签被连带关掉)。
    const applied =
      incomplete === true
        ? { rebound: 0, dropped: 0, outside: [] }
        : registry.applyScan(workspaceKey, files, { scopeRoot: workspace.notesRoot })
    // 扫描范围之外的已登记笔记(用户/Agent 显式登记的工作区其它目录):不能因为
    // "这次没扫到"就丢 —— 逐个 stat 核实,确实没了才删条目。
    const vanished = await this.verifyOutside(workspaceKey, applied.outside ?? [])
    // 历史快照的**兜底捕获点**:扫描到的版本与历史里记的不一致(或笔记还没有历史)
    // 就补一条 —— 覆盖不经 `tools/execute` 的写入者(Obsidian / vim / bash / 别的窗口)。
    // 放在对账之后、`unfiled` 之前:此时 `registry` 已经是最新的一份。
    await this.captureScannedNotes(workspaceKey, workspace, files)
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
    await this.persistSafe(workspaceKey)
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
    const registry = this.registries.get(workspaceKey)
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
   * @param workspaceKey - 工作区键(索引按工作区拆开之后,必须说明查哪个工作区)。
   * @param ids - 待核实的笔记 id(有上限,避免大仓库里 stat 风暴)。
   * @returns 移除的条目数。
   */
  async verifyOutside(workspaceKey, ids) {
    if (ids.length === 0) return 0
    const registry = await this.registryFor(workspaceKey)
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
    const registry = await this.registryFor(workspace.key, { root: workspace.root, name: workspace.name })
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
    await this.persist(workspace.key)
    await this.armWatch(workspace.key)
    this.syncClassificationCache(workspace.key, {
      upsert: [{ path: absolute, title: titleOf(absolute), id }],
    })
    // **历史基线**:纳入这一刻的内容是用户自己认得的状态,值得留一条 —— 没有它,
    // 第一次**外部**改动(Obsidian/vim)就没得回退(agent 那条有写前钩子兜着)。
    // 只在"这篇还没有任何历史"时记,所以重复登记不会重复写。
    await this.captureBaseline({ workspace, noteId: id, absolute })
    this.logger?.info?.('[dsh-notes] 登记笔记 %s → %s', note.id, note.path)
    return note
  }

  /**
   * 给一篇**还没有历史**的笔记记一条基线(登记时用;失败只记日志)。
   * @param options - `workspace`、`noteId`、`absolute`(绝对路径)。
   */
  async captureBaseline({ workspace, noteId, absolute }) {
    if (this.config.history === false) return null
    try {
      const history = await this.readHistoryIndex(workspace.root)
      if (history.notes[noteId] !== undefined) return null
      const fs = this.ctx.fs
      const target = await fs.resolve(absolute, {})
      const info = await fs.stat(target, this.abort.signal)
      if (info === undefined || info.type !== 'file') return null
      if (Number(info.size ?? 0) > HISTORY_MAX_ENTRY_BYTES) return null
      const text = await fs.readText(target, this.abort.signal)
      return await this.captureHistory({
        workspace,
        noteId,
        rel: relativePath(workspace.root, absolute),
        text,
        version: String(info.version),
        origin: 'baseline',
      })
    } catch (error) {
      this.logger?.debug?.('[dsh-notes] 历史基线失败(不影响登记):%s', error?.message ?? error)
      return null
    }
  }

  /** 只删索引条目(永不删文件)。 */
  async unregister({ noteId, workspaceKey = null }) {
    const found = await this.registryOwningNote(noteId, workspaceKey)
    if (found === null || found.note === undefined) throw new NotesError('笔记不存在', 'NOT_FOUND')
    if (!found.registry.removeNote(noteId)) throw new NotesError('笔记不存在', 'NOT_FOUND')
    await this.persist(found.key)
    this.syncClassificationCache(found.key)
    return true
  }

  /** 改归属与同级位置(`index` 省略 = 追加到末尾)。 */
  async moveNote({ noteId, collectionId = null, index = null, workspaceKey = null }) {
    const found = await this.registryOwningNote(noteId, workspaceKey)
    if (found === null || found.note === undefined) throw new NotesError('笔记不存在', 'NOT_FOUND')
    const { key, registry } = found
    const target = collectionId ?? null
    if (target !== null) {
      const owner = registry.workspaceOf(key)
      if (owner?.collections?.[target] === undefined) throw new NotesError('目标分类不存在于该工作区', 'INVALID')
    }
    const at = index === null || index === undefined ? null : Number(index)
    if (!registry.placeNote(key, noteId, target, at)) throw new NotesError('移动失败', 'INVALID')
    await this.persist(key)
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
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const registry = await this.registryFor(workspace.key, { root: workspace.root, name: workspace.name })
    const note = registry.noteById(noteId)
    if (note === undefined) throw new NotesError('笔记不存在', 'NOT_FOUND')
    const directory = note.path.replace(/\/[^/]*$/, '')
    const target = normalizePath(join(directory, `${sanitizeFileName(wanted)}.md`))
    if (target !== note.path) {
      const occupied = await fs.stat(await fs.resolve(target, {}), this.abort.signal)
      if (occupied !== undefined) throw new NotesError('同名文件已存在', 'EXISTS')
      await rename(note.path, target)
      await this.armWatch(workspace.key)
    }
    registry.setNotePath(noteId, target, wanted)
    await this.persist(workspace.key)
    this.syncClassificationCache(workspace.key, { upsert: [{ path: target, title: wanted, id: noteId }] })
    return { id: noteId, path: target, title: wanted }
  }

  /* ------------------------------------------------------------------ */
  /* 回收站                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * 某个工作区的回收站目录。
   *
   * 现在默认放在**工作区里**(`<root>/.dsh-notes/.trash`):"删了还能捞回来"属于工作区的数据,
   * 应该跟着工作区走 —— 备份/搬到别的机器后,回收站里的东西还在。
   *
   * 为什么放在点目录里就安全:两个走目录的地方都 `entry.name.startsWith('.') → continue`,
   * 所以回收站里的 `.md` **永远不会**被当成候选笔记重新登记回树(以前靠"放在笔记根之外"实现,
   * 代价就是它跟着 `$DSH_HOME` 走、搬不走)。`home` 形态仍是旧位置。
   * @param root - 工作区根(绝对路径)。
   */
  trashRoot(root) {
    return trashRootOf(this.storeScope(), this.config, root, process.env, homedir())
  }

  /** 回收站清单文件。 */
  trashIndexFile(root) {
    return trashIndexFileOf(this.storeScope(), this.config, root, process.env, homedir())
  }

  /** 读回收站清单(缺失/损坏都当空)。 */
  async readTrashIndex(root) {
    try {
      const text = await readFile(this.trashIndexFile(root), 'utf8')
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /** 写回收站清单(临时文件 + 原子替换,与索引同款)。 */
  async writeTrashIndex(root, entries) {
    const dir = this.trashRoot(root)
    await mkdir(dir, { recursive: true })
    const file = this.trashIndexFile(root)
    const tmp = `${file}.tmp-${process.pid}`
    await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  }

  /**
   * 跨文件系统安全的移动:`rename` 在同一个设备上最快,但工作区在 `/mnt/<盘>`、
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
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const registry = await this.registryFor(workspace.key, { root: workspace.root, name: workspace.name })
    const note = registry.noteById(noteId)
    if (note === undefined) throw new NotesError('笔记不存在', 'NOT_FOUND')
    const id = `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const stored = normalizePath(join(this.trashRoot(workspace.root), `${id}-${baseName(note.path)}`))
    await mkdir(this.trashRoot(workspace.root), { recursive: true })
    await this.moveAcross(note.path, stored)
    const entries = await this.readTrashIndex(workspace.root)
    entries.unshift({
      id,
      noteId,
      title: note.title,
      originalPath: note.path,
      file: stored,
      workspaceKey: workspace.key,
      deletedAt: Date.now(),
    })
    await this.writeTrashIndex(workspace.root, entries)
    registry.removeNote(noteId)
    await this.persist(workspace.key)
    await this.armWatch(workspace.key)
    this.syncClassificationCache(workspace.key, { remove: [note.path] })
    this.logger?.info?.('[dsh-notes] 移入回收站 %s → %s', note.path, stored)
    return { id, title: note.title, path: note.path, file: stored }
  }

  /** 回收站清单(带"文件是否还在"的检查)。 */
  async listTrash({ sessionId, workspaceKey = null } = {}) {
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const entries = await this.readTrashIndex(workspace.root)
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
    return { root: this.trashRoot(workspace.root), entries: out }
  }

  /** 从回收站恢复:挪回原路径(**原位置被占用就拒绝**),并重新登记进树。 */
  async restoreTrash({ sessionId, id, workspaceKey = null }) {
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const entries = await this.readTrashIndex(workspace.root)
    const entry = entries.find((item) => item.id === id)
    if (entry === undefined) throw new NotesError('回收站里没有这一项', 'NOT_FOUND')
    const fs = this.ctx.fs
    const occupied = await fs.stat(await fs.resolve(entry.originalPath, {}), this.abort.signal)
    if (occupied !== undefined) throw new NotesError('原位置已有同名文件,先移开它再恢复', 'EXISTS')
    const exists = await stat(entry.file).then(() => true, () => false)
    if (!exists) throw new NotesError('回收站里的文件已经不见了', 'NOT_FOUND')
    await mkdir(dirOfNative(entry.originalPath), { recursive: true })
    await this.moveAcross(entry.file, entry.originalPath)
    await this.writeTrashIndex(workspace.root, entries.filter((item) => item.id !== id))
    const registered = await this.register({ sessionId, path: entry.originalPath, workspaceKey: workspace.key })
    this.logger?.info?.('[dsh-notes] 从回收站恢复 %s', entry.originalPath)
    return { path: entry.originalPath, note: registered }
  }

  /** 彻底删除(`all: true` = 清空)。 */
  async purgeTrash({ sessionId, id, all = false, workspaceKey = null }) {
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const entries = await this.readTrashIndex(workspace.root)
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
    await this.writeTrashIndex(workspace.root, keep)
    return { removed }
  }

  /** 置顶 / 取消置顶(每工作区一份 pins 列表)。 */
  async pin({ sessionId, noteId, pinned = true, workspaceKey = null }) {
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const registry = await this.registryFor(workspace.key, { root: workspace.root, name: workspace.name })
    const note = registry.noteById(noteId)
    if (note === undefined) throw new NotesError('笔记不存在', 'NOT_FOUND')
    registry.setPinned(noteId, pinned !== false)
    if (pinned === false) {
      // 取消置顶后**留在原处**:置顶项排在同层最前,所以把它钉在当前画面第一位,
      // 否则它会按旧的 order 跳回列表中间/末尾(用户明确不要这种跳动)。
      registry.placeNote(workspace.key, noteId, note.collectionId ?? null, 0)
    }
    await this.persist(workspace.key)
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

  /**
   * 只读「版本探针」:客户端每 1.5s 用它判断"我打开着的这几篇,磁盘变了没有"。
   *
   * 为什么单开一条而不复用别的:
   *   - `tree()` 只回列表,不带每篇的版本号;
   *   - `read` 会把整篇正文读出来,1.5s 一次太贵(那篇 123KB 的笔记就是反例)。
   * 所以这里**只 `stat`、不读正文**,逐条 try/catch:`null` 表示"文件不存在 / 不在本
   * 工作区 / 不是 markdown",客户端据此显示"已被移动或删除",而不是把它当冲突。
   * @param options - `sessionId`;`paths` 绝对或工作区相对路径(上限 {@link STAT_PATHS_MAX});
   *   `workspaceKey`(笔记区域可能切到了别的工作区)。
   * @returns `{ versions }`:`路径 → 版本号 | null`(键与入参的字符串一一对应)。
   */
  async statNotes({ sessionId, paths = [], workspaceKey = null }) {
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const fs = this.ctx.fs
    const versions = {}
    for (const path of paths.slice(0, STAT_PATHS_MAX)) {
      const key = String(path ?? '')
      if (key === '') continue
      try {
        const { target, absolute } = await this.resolveNotePath(key, workspace.root)
        // 边界:只回答**本工作区内**的文件(笔记区域可能切了工作区,但探针只认这一个根)
        if (!isInsidePath(workspace.root, absolute)) {
          versions[key] = null
          continue
        }
        const info = await fs.stat(target, this.abort.signal)
        versions[key] = info === undefined || info.type !== 'file' ? null : String(info.version)
      } catch {
        versions[key] = null
      }
    }
    return { versions }
  }

  /** 跨工作区映射:把别的工作区的笔记挂进本工作区树。 */
  async reference({ sessionId, noteId, collectionId = null, workspaceKey = null }) {
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const registry = await this.registryFor(workspace.key, { root: workspace.root, name: workspace.name })
    if (!registry.addReference(workspace.key, noteId, collectionId)) throw new NotesError('笔记不存在', 'NOT_FOUND')
    await this.persist(workspace.key)
    return true
  }

  /** 去掉跨工作区映射(不动笔记本身)。 */
  async unreference({ sessionId, noteId, workspaceKey = null }) {
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const registry = await this.registryFor(workspace.key, { root: workspace.root, name: workspace.name })
    if (!registry.removeReference(workspace.key, noteId)) throw new NotesError('映射不存在', 'NOT_FOUND')
    await this.persist(workspace.key)
    return true
  }

  /* ------------------------------------------------------------------ */
  /* 分类                                                                */
  /* ------------------------------------------------------------------ */

  /** 分类操作(create/rename/move/delete)。 */
  async collection({ sessionId, op, collectionId, name, parentId = null, mode, index = null, workspaceKey = null }) {
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const registry = await this.registryFor(workspace.key, { root: workspace.root, name: workspace.name })
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
    await this.persist(workspace.key)
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
   * 探出某个文件当前的行尾风格(只读开头 {@link EOL_SAMPLE_BYTES} 字节)。
   *
   * 读不到(新文件 / provider 拒绝 / 没有 `readByteRange`)时按 `'LF'` 处理 —— 也就是
   * "不做转换",与旧行为一致,绝不让一次探测失败挡住保存。
   * @param target - 已解析的文件 target。
   * @returns `'CRLF'` 或 `'LF'`。
   */
  async eolOf(target) {
    const fs = this.ctx.fs
    if (typeof fs.readByteRange !== 'function') return 'LF'
    try {
      const bytes = await fs.readByteRange(target, { offset: 0, length: EOL_SAMPLE_BYTES }, this.abort.signal)
      return detectEol(new TextDecoder().decode(bytes))
    } catch {
      return 'LF'
    }
  }

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
        // **归一成 LF 再交出去**:编辑器里的文本恒为 LF(CM6 用 /\r\n?|\n/ 切分重建),
        // 而 fs.readText 给的是磁盘原文。不归一的话,CRLF 笔记撞上"自己刚 beacon 写下去的内容"
        // 会因 \r 而比不相等 → 客户端那条自愈分支失效、误报"文件已被外部修改"。
        current = normalizeEol(await fs.readText(target, this.abort.signal))
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
    const registry = await this.registryFor(workspace.key, { root: workspace.root, name: workspace.name })
    const note = registry.noteByPath(absolute)
    let payload = text
    let restoredId = false
    if (note !== undefined && readNoteId(text) !== note.id) {
      payload = mintFrontmatter(text, note.id)
      restoredId = true
    }
    // **保住原文件的行尾**:编辑器给的恒为 LF,但 `fs.writeText` 是原样写(与官方
    // `editText` 不同 —— 后者会 restoreLineEndings)。不处理的话,打开一篇 CRLF 笔记
    // 随手保存一次,整份文件的行尾就被静默改写成 LF(实测:123KB 的笔记有 1244 个 CR)。
    const diskPayload = applyEol(payload, await this.eolOf(target))
    try {
      const outcome = await fs.writeText(
        target,
        diskPayload,
        { kind: 'replaceIfVersion', version: info.version },
        this.abort.signal,
        this.policyFor(sessionId, workspace.root),
      )
      // 标题 = 文件名(Obsidian 模型):正文里的 `# 标题` **不再**回写树上的名字。
      // (旧实现每次保存都用 H1 覆盖 title,导致"树上名字 ≠ 文件名";要改名请用重命名。)
      // 响应的 `text` 仍是 **LF** 形态:它是给编辑器用的(与编辑器里的文本同构),
      // 磁盘上那份才是 CRLF。
      return { version: String(outcome.version), path: absolute, restoredId, text: payload }
    } catch (error) {
      if (String(error?.code ?? '').includes('STALE')) {
        throw new NotesError('文件已被外部修改', 'FS_STALE_VERSION', { currentVersion: String(info.version) })
      }
      throw error
    }
  }

  /* ------------------------------------------------------------------ */
  /* 历史快照(agent 改坏了要能回到改之前)                                */
  /* ------------------------------------------------------------------ */

  /**
   * 这套东西存在的唯一理由:agent 用通用文件工具(`write`/`edit`)改笔记,插件**拦不住**
   * 写入 —— 于是唯一能兜住"改坏了回到改之前"的办法就是**改动前后各留一份内容快照**。
   *
   * 捕获点只有两个(外加"恢复"这一个用户动作):
   *   1. `tools/execute` 写前钩子({@link NoteService#captureBeforeToolWrite})——
   *      agent 每次 `write`/`edit` **落盘之前**把当前内容留一份,所以 V1→V2→V3→V4
   *      连写也不会丢中间状态;
   *   2. 扫描观察({@link NoteService#captureScannedNotes})—— 兜住**不经工具**的改动
   *      (Obsidian / Typora / vim / bash / 另一个窗口 / 插件自己的保存)。
   * 内容 `hash` 去重,所以同一次改动被两个点看到也只留一条。
   */

  /** 某个工作区的历史目录。 */
  historyRoot(root) {
    return historyRootOf(this.storeScope(), this.config, root, process.env, homedir())
  }

  /** 某个工作区的历史索引文件。 */
  historyIndexFile(root) {
    return historyIndexFileOf(this.storeScope(), this.config, root, process.env, homedir())
  }

  /** 历史条数上限(配置读不出来时按 50)。 */
  historyMax() {
    const value = Number(this.config.historyMaxPerNote)
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 50
  }

  /** 读历史索引(缺失/损坏都当空,**绝不抛** —— 它躺在用户工作区里,可能被手改过)。 */
  async readHistoryIndex(root) {
    try {
      return normalizeHistory(JSON.parse(await readFile(this.historyIndexFile(root), 'utf8')))
    } catch {
      return normalizeHistory(null)
    }
  }

  /** 写历史索引(临时文件 + 原子替换,与薄索引/回收站同款)。 */
  async writeHistoryIndex(root, value) {
    const dir = this.historyRoot(root)
    await mkdir(dir, { recursive: true })
    const file = this.historyIndexFile(root)
    const tmp = `${file}.tmp-${process.pid}`
    await writeFile(tmp, `${JSON.stringify(value)}\n`, 'utf8')
    await rename(tmp, file)
  }

  /**
   * 记一条历史快照(**唯一的写入入口**)。
   *
   * 四条保证:
   *   - **串行**:`historyChain` 把"读索引 → 追加 → 写索引"串起来,两个快速写不会互相覆盖;
   *   - **去重**:与最新一条同 `hash` 就不追加(见 `lib/history.js` 的 `upsertEntry`);
   *   - **有界**:超条数从最旧裁,被裁的文件当场删掉;
   *   - **绝不抛**:历史是兜底功能,写不进去(只读工作区/权限/磁盘满)只 warn 一次,
   *     绝不能让一次快照失败连累笔记读写。
   * @param options - `workspace`(工作区信息)、`noteId`、`rel`、`text`(内容)、
   *   `version`(**这份内容对应的 provider 版本**,一键撤销靠它)、`origin`。
   * @returns `{ file, at, hash, size, version, origin }` 或 `null`(没记/去重跳过)。
   */
  async captureHistory({ workspace, noteId, rel = '', text, version = '', origin = 'external' }) {
    if (this.config.history === false) return null
    if (typeof noteId !== 'string' || noteId === '') return null
    if (workspace === null || workspace === undefined || typeof workspace.root !== 'string') return null
    const payload = normalizeEol(String(text ?? ''))
    const size = Buffer.byteLength(payload, 'utf8')
    if (size > HISTORY_MAX_ENTRY_BYTES) {
      this.logger?.debug?.('[dsh-notes] 笔记过大(%d 字节),跳过历史快照:%s', size, rel)
      return null
    }
    const hash = createHash('sha1').update(payload).digest('hex').slice(0, 16)
    const root = workspace.root
    const run = this.historyChain.then(async () => {
      const history = await this.readHistoryIndex(root)
      const note = history.notes[noteId]
      const existing = new Set((note?.entries ?? []).map((item) => item.file))
      const at = Date.now()
      const file = nextEntryFile(noteId, at, existing)
      const result = upsertEntry(history, noteId, {
        rel,
        version,
        entry: { file, at, hash, size, version, origin },
        maxEntries: this.historyMax(),
      })
      if (result.added) {
        const absolute = normalizePath(join(this.historyRoot(root), file))
        await mkdir(dirOfNative(absolute), { recursive: true })
        await writeFile(absolute, payload, 'utf8')
      }
      for (const dropped of result.dropped) {
        try {
          await unlink(normalizePath(join(this.historyRoot(root), dropped)))
        } catch {
          /* 已经被手删过就算了 */
        }
      }
      await this.writeHistoryIndex(root, result.history)
      return result.added ? { file, at, hash, size, version, origin } : null
    })
    const guarded = run.catch((error) => {
      if (this.historyWarned !== true) {
        this.historyWarned = true
        this.logger?.warn?.('[dsh-notes] 历史快照写盘失败(不影响笔记读写):%s', error?.message ?? error)
      }
      return null
    })
    // 链子**永远不 reject**(guarded 已经吃掉):一次失败不能让后续快照排队失败
    this.historyChain = guarded.then(() => undefined)
    return guarded
  }

  /**
   * 某篇笔记的历史条目(从新到旧)。
   * @returns `{ noteId, rel, version, entries }`。
   */
  async listHistory({ sessionId, noteId, workspaceKey = null }) {
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const history = await this.readHistoryIndex(workspace.root)
    const node = history.notes[noteId]
    if (node === undefined) return { noteId, rel: '', version: '', entries: [] }
    return { noteId, rel: node.rel, version: node.version, entries: historyEntriesOf(history, noteId) }
  }

  /**
   * 读一条历史条目的正文(预览用)。
   *
   * 文件名来自客户端,所以**先校验形状**({@link isValidEntryFile}:必须是
   * `<noteId>/<时间戳>[-序号].md`)—— `..`、绝对路径、别的笔记的目录一律不合法。
   */
  async readHistoryEntry({ sessionId, noteId, file, workspaceKey = null }) {
    if (!isValidEntryFile(noteId, file)) throw new NotesError('历史条目名不合法', 'INVALID')
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const absolute = normalizePath(join(this.historyRoot(workspace.root), file))
    try {
      return { file, text: normalizeEol(await readFile(absolute, 'utf8')) }
    } catch {
      throw new NotesError('这条历史快照已经不在了', 'NOT_FOUND')
    }
  }

  /**
   * 恢复一个历史版本(**守卫式写入**:磁盘版本对不上就报冲突,绝不覆盖别人的改动)。
   *
   * 恢复前先把**当前内容**记一条(`origin: 'restore'`)—— 于是"恢复"本身也能再撤销,
   * 用户不会因为点错一下就把当前版本弄丢(内容相同的话会被 hash 去重,不会多出重复条目)。
   * @returns `{ version, text, file, absolutePath }`(`text` 是 **LF** 形态,给编辑器用)。
   */
  async restoreHistory({ sessionId, noteId, file, workspaceKey = null }) {
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const registry = await this.registryFor(workspace.key, { root: workspace.root, name: workspace.name })
    const note = registry.noteById(noteId)
    if (note === undefined) throw new NotesError('笔记不存在', 'NOT_FOUND')
    const entry = await this.readHistoryEntry({ sessionId, noteId, file, workspaceKey })
    const fs = this.ctx.fs
    const { target, absolute } = await this.resolveNotePath(note.path, workspace.root)
    const info = await fs.stat(target, this.abort.signal)
    if (info === undefined || info.type !== 'file') throw new NotesError(`文件不存在:${absolute}`, 'NOT_FOUND')
    const currentVersion = String(info.version)
    try {
      const currentText = normalizeEol(await fs.readText(target, this.abort.signal))
      await this.captureHistory({
        workspace,
        noteId,
        rel: relativePath(workspace.root, absolute),
        text: currentText,
        version: currentVersion,
        origin: 'restore',
      })
    } catch (error) {
      this.logger?.debug?.('[dsh-notes] 恢复前的快照失败(不影响恢复):%s', error?.message ?? error)
    }
    const payload = applyEol(entry.text, await this.eolOf(target))
    try {
      const outcome = await fs.writeText(
        target,
        payload,
        { kind: 'replaceIfVersion', version: info.version },
        this.abort.signal,
        this.policyFor(sessionId, workspace.root),
      )
      this.logger?.info?.('[dsh-notes] 恢复历史版本 %s ← %s', note.path, file)
      return { version: String(outcome.version), text: entry.text, file, absolutePath: absolute }
    } catch (error) {
      if (String(error?.code ?? '').includes('STALE')) {
        throw new NotesError('文件已被外部修改', 'FS_STALE_VERSION', { currentVersion })
      }
      throw error
    }
  }

  /**
   * 「撤销最近一次外部改动」:回到**当前磁盘内容之前**那一次观察到的状态。
   *
   * 语义由 {@link predecessorOf} 决定(按 `version` 找,不按位置):agent 写前钩子记的
   * 那条带的正是**写之前的版本**,所以命中的就是"这次 agent 修改之前"。
   * 实现上只是"解析出条目 → 走同一条恢复路径",不是第二套机制。
   */
  async undoExternal({ sessionId, noteId, workspaceKey = null }) {
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const registry = await this.registryFor(workspace.key, { root: workspace.root, name: workspace.name })
    const note = registry.noteById(noteId)
    if (note === undefined) throw new NotesError('笔记不存在', 'NOT_FOUND')
    const fs = this.ctx.fs
    const { target } = await this.resolveNotePath(note.path, workspace.root)
    const info = await fs.stat(target, this.abort.signal)
    if (info === undefined || info.type !== 'file') throw new NotesError('文件不存在', 'NOT_FOUND')
    const history = await this.readHistoryIndex(workspace.root)
    const previous = predecessorOf(history, noteId, String(info.version))
    if (previous === null) throw new NotesError('没有可回退的历史版本', 'NOT_FOUND')
    return this.restoreHistory({ sessionId, noteId, file: previous.file, workspaceKey })
  }

  /**
   * `tools/execute` 写前钩子(agent 的 `write`/`edit`)。
   *
   * 时序由 DSH 保证:`tools/execute` 是**环绕分发**的 waterfall
   * (`ctx.waterfall(carrier, 'tools/execute', exec, () => dispatchToolBody(exec))`),
   * 我们在 `next()` **之前**跑,所以读到的就是"即将被覆盖掉的那一份内容"。
   *
   * 这条路径上**只读、不写笔记**:唯一的写入是 `.dsh-notes/.history/` 里的快照。
   * 逐层收窄,让"agent 改别的文件"这件事零成本:
   *   ① 工具名不是 `write`/`edit` → 直接返回(不碰 fs);
   *   ② `file_path` 不是 markdown → 直接返回;
   *   ③ 解析出的绝对路径不在任何已登记工作区内 / 不是**已登记笔记** → 直接返回;
   *   ④ 文件不存在(新建)或超过 {@link HISTORY_MAX_ENTRY_BYTES} → 直接返回。
   * 剩下的才 stat + 读正文 + 记快照。
   *
   * **不跳过嵌套调用**(`exec.parent` 存在也是真实写入,例如 Code Mode 的子分发),
   * 重复调用靠内容 hash 去重兜住。
   *
   * 这个方法**永不抛**:任何异常(provider 挂了/路径怪/registry 读不出来)都只是
   * "这次没记",绝不能让快照连累 agent 的写入。
   * @param exec - `tools/execute` 的 `ToolDispatchExecution`。
   * @returns 快照信息或 `null`。
   */
  async captureBeforeToolWrite(exec) {
    if (this.config.history === false) return null
    const name = String(exec?.name ?? '')
    if (name !== 'write' && name !== 'edit') return null
    const args = exec?.arguments
    const raw = args !== null && typeof args === 'object' ? args.file_path : undefined
    const filePath = typeof raw === 'string' ? raw.trim() : ''
    if (filePath === '' || !looksLikeMarkdown(filePath)) return null
    const sessionId = exec?.agent?.id
    if (sessionId === undefined || sessionId === null) return null
    try {
      const fs = this.ctx.fs
      const cwd = this.sessionCwd(sessionId)
      const absolute = normalizePath(fs.processPath(await fs.resolve(filePath, cwd === '' ? {} : { cwd })))
      if (!looksLikeMarkdown(absolute)) return null
      for (const workspace of await this.candidateWorkspaces(sessionId)) {
        if (!isInsidePath(workspace.root, absolute)) continue
        const registry = await this.registryFor(workspace.key, { root: workspace.root, name: workspace.name })
        const note = registry.noteByPath(absolute)
        if (note === undefined) continue
        const { target } = await this.resolveNotePath(absolute, workspace.root)
        const info = await fs.stat(target, this.abort.signal)
        if (info === undefined || info.type !== 'file') return null
        if (Number(info.size ?? 0) > HISTORY_MAX_ENTRY_BYTES) return null
        const text = await fs.readText(target, this.abort.signal)
        return await this.captureHistory({
          workspace,
          noteId: note.id,
          rel: relativePath(workspace.root, absolute),
          text,
          version: String(info.version),
          origin: 'agent',
        })
      }
      return null
    } catch (error) {
      this.logger?.debug?.('[dsh-notes] 写前快照读取失败(不影响写入):%s', error?.message ?? error)
      return null
    }
  }

  /** 会话的工作区根(= 工具的相对路径基准)。取不到就空串(调用方回落成 provider 默认)。 */
  sessionCwd(sessionId) {
    try {
      return String(this.ctx.sessions?.get?.(sessionId)?.header?.cwd ?? '')
    } catch {
      return ''
    }
  }

  /**
   * 写前钩子要检查哪些工作区:会话自己的工作区 + **已经装载过**的工作区
   * (笔记区域可以切到别的已登记工作区,那时 agent 可能正在改那边的笔记)。
   */
  async candidateWorkspaces(sessionId) {
    const out = []
    const seen = new Set()
    try {
      const own = this.resolveWorkspace(sessionId)
      out.push(own)
      seen.add(own.key)
    } catch {
      /* 会话解析不出 cwd:只靠已装载的那些 */
    }
    for (const [key, registry] of this.registries) {
      if (seen.has(key)) continue
      const node = registry.workspaceOf(key)
      if (node === undefined) continue
      seen.add(key)
      out.push({ key, root: node.root, name: node.name, notesRoot: applyNotesRootOverride(node) })
    }
    return out
  }

  /**
   * 扫描观察到的变化 → 历史快照(**兜底捕获点**)。
   *
   * 覆盖 agent 写前钩子看不到的写入者:Obsidian / Typora / vim / `bash` 重定向 /
   * 另一个窗口 / 插件自己的保存。判据是**扫描到的版本**与历史里记的版本不一致
   * (所以稳态下这里**一次正文都不用读**);笔记还没有任何历史时记一条 `baseline`。
   *
   * 只处理**已登记**的笔记,且一次扫描最多补 {@link HISTORY_CAPTURE_PER_SCAN_MAX} 条
   * (首次为存量笔记建基线时不至于一口气写几百个文件)。
   * @param workspaceKey - 工作区键。
   * @param workspace - 工作区信息。
   * @param files - `scanNotesRoot` 的结果(带 `version` / `size`)。
   */
  async captureScannedNotes(workspaceKey, workspace, files) {
    if (this.config.history === false) return
    const registry = this.registries.get(workspaceKey)
    if (registry === undefined) return
    const history = await this.readHistoryIndex(workspace.root)
    const known = new Map()
    for (const [id, node] of Object.entries(history.notes)) known.set(id, { version: node.version, count: node.entries.length })
    const fs = this.ctx.fs
    let budget = HISTORY_CAPTURE_PER_SCAN_MAX
    for (const file of files) {
      if (budget <= 0) break
      const absolute = normalizePath(file.path)
      const note = registry.noteByPath(absolute)
      if (note === undefined) continue
      const version = String(file.version ?? '')
      const before = known.get(note.id)
      if (before !== undefined && version !== '' && before.version === version) continue
      if (Number(file.size ?? 0) > HISTORY_MAX_ENTRY_BYTES) continue
      budget -= 1
      let text = ''
      try {
        const target = await fs.resolve(absolute, {})
        text = normalizeEol(await fs.readText(target, this.abort.signal))
      } catch (error) {
        this.logger?.debug?.('[dsh-notes] 读不到这篇笔记,跳过历史快照 %s:%s', absolute, error?.message ?? error)
        continue
      }
      if (text === '') continue
      await this.captureHistory({
        workspace,
        noteId: note.id,
        rel: relativePath(workspace.root, absolute),
        text,
        version,
        origin: before === undefined || before.count === 0 ? 'baseline' : 'external',
      })
      known.set(note.id, { version, count: (before?.count ?? 0) + 1 })
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
    const registry = await this.registryFor(workspace.key, { root: workspace.root, name: workspace.name })
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

  /**
   * 扫描缓存的根目录。
   *
   * 这份数据是**派生的**(relPath → 版本/大小/id,删了只是下次要重扫),而且每次对账都会变;
   * 所以它留在**机器本地**,不跟着工作区走 —— 否则每次都往用户的仓库里写一个几十 KB 的文件。
   */
  storeRoot() {
    return this.homeRoot()
  }

  /** 某个工作区的扫描索引文件(只存 relPath → {v,s,id},不塞进 registry)。 */
  indexFile(workspaceKey) {
    return cacheFileFor(this.config, workspaceKey, process.env, homedir())
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
   * 把用户给的一个「扫描根」规范化成工作区相对路径。
   *
   * 三条规则:
   *   - 空串 / `'.'` / `'./'` → `''`(整个工作区);
   *   - **绝对路径**(目录选择器给的形态)→ 必须在工作区内,换算成相对路径;越界直接报错;
   *   - 相对路径 → 原样归一(去掉 `./` 前缀与结尾斜杠),允许暂时不存在
   *     (扫描时会如实报 missingRoot,不在这里拦)。
   * @param root - 工作区根(绝对路径)。
   * @param value - 用户给的根。
   * @returns 工作区相对路径(`''` = 工作区根)。
   * @throws {NotesError} `INVALID` 当绝对路径不在本工作区内。
   */
  scanRootOf(root, value) {
    const raw = String(value ?? '').trim().replace(/\\/g, '/')
    if (raw === '' || raw === '.' || raw === './') return ''
    if (isAbsolutePath(raw)) {
      const mapped = relativeToWorkspace(root, raw)
      if (!mapped.ok) throw new NotesError('只能选择本工作区内的目录', 'INVALID')
      return mapped.rel
    }
    return raw.replace(/^\.?\/+/, '').replace(/\/+$/, '')
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
   * **实测**:本机(WSL + /mnt/<盘> drvfs + 沙箱 provider)一次 `listDir` 约 **330ms**
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
        const absolute = normalizePath(rel === '' ? workspace.root : join(workspace.root, rel))
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
    const registry = await this.registryFor(workspaceKey)
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
        // 修改时间:从 provider 的版本号里取(官方接口面不暴露 mtime —— 见 notes.js
        // 的 mtimeOfVersion 注释)。认不出来时是 0,界面回落成按路径排序。
        at: mtimeOfVersion(entry.version),
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
    await this.persistSafe(workspaceKey)
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
    const registry = await this.registryFor(workspaceKey)
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
      await this.persistSafe(workspaceKey)
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
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const registry = await this.registryFor(workspace.key, { root: workspace.root, name: workspace.name })
    const result = registry.setIgnored(workspace.key, { paths, globs }, { on })
    // 取消忽略后这些文件要重新能被看见:清掉缓存里的"这一次扫描"结果即可
    this.workspaceScans.delete(workspace.key)
    await this.persist(workspace.key)
    return { ...result, workspaceKey: workspace.key }
  }

  /**
   * 设置「扫描范围」(工作区相对目录;空数组 = 回到 notesDir)。
   *
   * 默认只扫 notesDir:本机实测一次 listDir 约 330ms,扫整个工作区要按分钟算,
   * 所以"要多看哪里"必须由用户/Agent 说出来(面板上就是"扫描范围"那一行)。
   *
   * **绝对路径也接受**(目录选择器给的就是绝对路径):换算成工作区相对路径;
   * 落在工作区**外面**的直接拒绝 —— 扫描范围的根必须是工作区内的目录,
   * 否则"看别的目录"就变成了越界读用户主目录。
   * @param options - `sessionId`;`roots` 目录列表(`''`/`.` = 工作区根;允许绝对路径)。
   * @returns 规范化后的根列表。
   * @throws {NotesError} `INVALID` —— 有根不在本工作区内。
   */
  async setScanRoots({ sessionId, roots = [], workspaceKey = null }) {
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const list = Array.isArray(roots) ? roots : []
    const node = workspace.node
    node.scanRoots = list.map((root) => this.scanRootOf(workspace.root, root))
    this.workspaceScans.delete(workspace.key)
    this.walkStates.delete(workspace.key)
    await this.persist(workspace.key)
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
    const workspace = await this.workspaceOf(sessionId, workspaceKey)
    const registry = await this.registryFor(workspace.key, { root: workspace.root, name: workspace.name })
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
    // 跨工作区映射:目标笔记在**它自己工作区的文件**里(索引按工作区拆开了),
    // 所以按 id 反查;目标不在本机(工作区没跟过来)就跳过这一条,不报错、不删映射。
    const refs = []
    for (const [noteId, ref] of Object.entries(ws.refs ?? {})) {
      const found = await this.locateNote(noteId)
      if (found === null) continue
      const owner = found.registry.workspaceOf(found.key)
      refs.push({
        noteId,
        title: found.note.title,
        path: found.note.path,
        relPath: owner === undefined ? found.note.path : relativePath(owner.root, found.note.path),
        workspaceKey: found.key,
        workspaceName: owner?.name ?? found.key,
        collectionId: ref.collectionId ?? null,
      })
    }
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
    const registry = await this.registryFor(workspaceKey)
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
