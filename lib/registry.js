/**
 * 索引(薄映射)的内存态与变更。
 *
 * 只描述「哪些 .md 是笔记、属于哪个分类」,不碰磁盘、不认识 ctx —— 持久化与扫描
 * 由 service.js 负责,因此本模块可以整体单测。
 *
 * 结构(见 README/AGENTS):
 *   notes[id]      = { id, path, workspaceKey, collectionId, title, createdAt, updatedAt }
 *   workspaces[key]= { root, name, notesRoot, collections{}, refs{}, pins[], recent[], order }
 *
 * 硬规则:本模块**从不**删除或移动文件;`unregister` 只删条目。
 *
 * @module dsh-notes/registry
 */

import { globMatch, mintCollectionId, mintNoteId, normalizePath } from './notes.js'

/** 当前索引 schema 版本。 */
export const SCHEMA_VERSION = 1

/** 空索引。 */
export function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, notes: {}, workspaces: {} }
}

/** 深拷贝(索引很小,直接 JSON 往返;顺带保证写盘的是可序列化数据)。 */
function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * 从 JSON 文本恢复索引。
 * @param text - 文件内容。
 * @returns 索引状态。
 * @throws 当内容不是对象 / schemaVersion 不认识时。
 */
export function stateFromJSON(text) {
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('registry: 不是对象')
  if (parsed.schemaVersion !== SCHEMA_VERSION) throw new Error(`registry: 不认识的 schemaVersion ${parsed.schemaVersion}`)
  const state = emptyState()
  state.notes = parsed.notes !== null && typeof parsed.notes === 'object' ? parsed.notes : {}
  state.workspaces = parsed.workspaces !== null && typeof parsed.workspaces === 'object' ? parsed.workspaces : {}
  for (const workspace of Object.values(state.workspaces)) {
    workspace.collections = workspace.collections ?? {}
    workspace.refs = workspace.refs ?? {}
    workspace.pins = Array.isArray(workspace.pins) ? workspace.pins : []
    workspace.recent = Array.isArray(workspace.recent) ? workspace.recent : []
    // 三类模型里的「杂项」:精确路径 + glob(见 service.classify)
    workspace.ignored = Array.isArray(workspace.ignored) ? workspace.ignored : []
    workspace.ignoredGlobs = Array.isArray(workspace.ignoredGlobs) ? workspace.ignoredGlobs : []
  }
  return state
}

/** 索引(内存态)。 */
export class NoteRegistry {
  /** @param state - 初始状态(省略 = 空索引)。 */
  constructor(state) {
    this.state = state ?? emptyState()
  }

  /** @returns 可写盘的状态副本。 */
  toJSON() {
    return clone(this.state)
  }

  /** 取/建一个工作区节点。 */
  workspace(key, init = {}) {
    const workspaces = this.state.workspaces
    let workspace = workspaces[key]
    if (workspace === undefined) {
      workspace = {
        root: normalizePath(init.root ?? key),
        name: init.name ?? '',
        notesRoot: normalizePath(init.notesRoot ?? init.root ?? key),
        collections: {},
        refs: {},
        pins: [],
        recent: [],
        ignored: [],
        ignoredGlobs: [],
      }
      workspaces[key] = workspace
    } else {
      workspace.ignored = Array.isArray(workspace.ignored) ? workspace.ignored : []
      workspace.ignoredGlobs = Array.isArray(workspace.ignoredGlobs) ? workspace.ignoredGlobs : []
      if (init.root !== undefined) workspace.root = normalizePath(init.root)
      if (init.name !== undefined) workspace.name = init.name
      if (init.notesRoot !== undefined) workspace.notesRoot = normalizePath(init.notesRoot)
    }
    return workspace
  }

  /** 工作区节点(不存在则 undefined)。 */
  workspaceOf(key) {
    return this.state.workspaces[key]
  }

  /** 笔记条目。 */
  note(id) {
    return this.state.notes[id]
  }

  /** 按路径找笔记(规范化比较)。 */
  noteByPath(path) {
    const wanted = normalizePath(path)
    for (const note of Object.values(this.state.notes)) {
      if (normalizePath(note.path) === wanted) return note
    }
    return undefined
  }

  /** 按 id 找笔记。 */
  noteById(id) {
    return this.state.notes[id]
  }

  /**
   * 登记一篇笔记(已存在同路径则更新归属)。
   * @returns 笔记条目。
   */
  addNote({ id, path, workspaceKey, collectionId = null, title = '' }) {
    const now = Date.now()
    const existing = this.state.notes[id]
    const note = existing ?? { id, createdAt: now, workspaceKey }
    note.id = id
    note.path = normalizePath(path)
    note.workspaceKey = workspaceKey
    note.collectionId = collectionId
    note.title = title
    note.updatedAt = now
    this.state.notes[id] = note
    return note
  }

  /** 只删索引条目(永不删文件)。 */
  removeNote(id) {
    if (this.state.notes[id] === undefined) return false
    delete this.state.notes[id]
    for (const workspace of Object.values(this.state.workspaces)) {
      delete workspace.refs[id]
      workspace.pins = workspace.pins.filter((value) => value !== id)
      workspace.recent = workspace.recent.filter((value) => value !== id)
    }
    return true
  }

  /** 改归属(null = 未归类);不带位置 = 追加到同级末尾。 */
  moveNote(id, collectionId = null) {
    const note = this.state.notes[id]
    if (note === undefined) return false
    note.collectionId = collectionId
    note.updatedAt = Date.now()
    return true
  }

  /** 某个父下的笔记,按 (order, 标题) 排序。 */
  siblingsOfNotes(workspaceKey, collectionId) {
    const pins = this.state.workspaces[workspaceKey]?.pins ?? []
    return Object.values(this.state.notes)
      .filter((note) => note.workspaceKey === workspaceKey && (note.collectionId ?? null) === (collectionId ?? null))
      // 置顶的排在同层最前(与 service 的树 payload 同一口径,否则拖拽 index 会错位)
      .sort((left, right) => Number(pins.includes(right.id)) - Number(pins.includes(left.id)) || compareOrdered(left, right))
  }

  /** 某个父下的分类,按 (order, 名字) 排序。 */
  siblingsOfCollections(workspaceKey, parentId) {
    const workspace = this.state.workspaces[workspaceKey]
    if (workspace === undefined) return []
    return Object.values(workspace.collections)
      .filter((node) => (node.parentId ?? null) === (parentId ?? null))
      .sort(compareOrdered)
  }

  /**
   * 把一篇笔记放到某个分类的**指定位置**(拖动排序/换层级共用一条路径)。
   * @param workspaceKey - 笔记所属工作区。
   * @param id - 笔记 id。
   * @param collectionId - 目标分类(`null` = 顶层)。
   * @param index - 目标位置(0 起);`null` = 末尾。
   * @returns 是否成功。
   */
  placeNote(workspaceKey, id, collectionId = null, index = null) {
    const note = this.state.notes[id]
    if (note === undefined) return false
    const workspace = this.state.workspaces[workspaceKey]
    if (workspace === undefined) return false
    if (collectionId !== null && workspace.collections[collectionId] === undefined) return false
    note.collectionId = collectionId
    note.updatedAt = Date.now()
    const list = this.siblingsOfNotes(workspaceKey, collectionId)
    const currentIndex = list.findIndex((item) => item.id === id)
    const rest = list.filter((item) => item.id !== id)
    // `index === null` = 追加到末尾(与自己在哪无关);
    // 显式下标按"当前画面"理解:先在完整同级表里夹取,再扣掉自己摘除造成的前移
    let at = rest.length
    if (index !== null) {
      at = Math.max(0, Math.min(list.length, Number(index)))
      if (currentIndex !== -1 && currentIndex < at) at -= 1
      at = Math.max(0, Math.min(rest.length, at))
    }
    rest.splice(at, 0, note)
    rest.forEach((item, position) => {
      item.order = position + 1
    })
    return true
  }

  /** 只改路径/标题(改名、移动后按 id 重绑)。 */
  setNotePath(id, path, title) {
    const note = this.state.notes[id]
    if (note === undefined) return false
    note.path = normalizePath(path)
    if (title !== undefined) note.title = title
    note.updatedAt = Date.now()
    return true
  }

  /** 分类节点。 */
  collection(workspaceKey, id) {
    return this.state.workspaces[workspaceKey]?.collections[id]
  }

  /** 某工作区某分类下的笔记 id(按标题排序)。 */
  notesInCollection(workspaceKey, collectionId) {
    return Object.values(this.state.notes)
      .filter((note) => note.workspaceKey === workspaceKey && (note.collectionId ?? null) === (collectionId ?? null))
      .sort((left, right) => String(left.title).localeCompare(String(right.title), 'zh-Hans-CN'))
      .map((note) => note.id)
  }

  /** 建分类。 */
  createCollection(workspaceKey, { name, parentId = null, order }) {
    const workspace = this.state.workspaces[workspaceKey]
    if (workspace === undefined) throw new Error('registry: 工作区不存在')
    if (parentId !== null && workspace.collections[parentId] === undefined) throw new Error('registry: 父分类不存在')
    const id = mintCollectionId()
    workspace.collections[id] = {
      id,
      name: String(name ?? '').trim() || '未命名分类',
      parentId,
      order: order ?? Object.keys(workspace.collections).length + 1,
    }
    return workspace.collections[id]
  }

  /** 改分类名。 */
  renameCollection(workspaceKey, id, name) {
    const node = this.collection(workspaceKey, id)
    if (node === undefined) return false
    node.name = String(name ?? '').trim() || node.name
    return true
  }

  /** 同级重排。 */
  reorderCollection(workspaceKey, id, order) {
    const node = this.collection(workspaceKey, id)
    if (node === undefined) return false
    node.order = order
    return true
  }

  /**
   * 移动分类(带环检测);`index` 决定在同级里的位置。
   * @returns 是否成功。
   */
  moveCollection(workspaceKey, id, parentId = null, index = null) {
    const workspace = this.state.workspaces[workspaceKey]
    if (workspace === undefined) return false
    const node = workspace.collections[id]
    if (node === undefined) return false
    if (parentId !== null) {
      if (workspace.collections[parentId] === undefined) return false
      let cursor = parentId
      const seen = new Set()
      while (cursor !== null && !seen.has(cursor)) {
        if (cursor === id) return false
        seen.add(cursor)
        cursor = workspace.collections[cursor]?.parentId ?? null
      }
    }
    node.parentId = parentId
    const list = this.siblingsOfCollections(workspaceKey, parentId)
    const currentIndex = list.findIndex((item) => item.id === id)
    const rest = list.filter((item) => item.id !== id)
    // 同 placeNote:`index === null` 就是追加到末尾
    let at = rest.length
    if (index !== null) {
      at = Math.max(0, Math.min(list.length, Number(index)))
      if (currentIndex !== -1 && currentIndex < at) at -= 1
      at = Math.max(0, Math.min(rest.length, at))
    }
    rest.splice(at, 0, node)
    rest.forEach((item, position) => {
      item.order = position + 1
    })
    return true
  }

  /**
   * 删分类节点(不动文件)。
   * @param mode - `move-to-parent`(默认)把笔记与子分类上提;`unfile` 把笔记留为未归类。
   * @returns 是否成功。
   */
  deleteCollection(workspaceKey, id, mode = 'move-to-parent') {
    const workspace = this.state.workspaces[workspaceKey]
    if (workspace === undefined) return false
    const node = workspace.collections[id]
    if (node === undefined) return false
    const parentId = node.parentId ?? null
    for (const child of Object.values(workspace.collections)) {
      if (child.parentId === id) child.parentId = parentId
    }
    for (const note of Object.values(this.state.notes)) {
      if (note.workspaceKey !== workspaceKey) continue
      if (note.collectionId !== id) continue
      note.collectionId = mode === 'unfile' ? null : parentId
    }
    delete workspace.collections[id]
    delete workspace.refs[id]
    return true
  }

  /** 跨工作区映射:把别的工作区的笔记挂进本工作区树。 */
  addReference(workspaceKey, noteId, collectionId = null) {
    const workspace = this.state.workspaces[workspaceKey]
    if (workspace === undefined) return false
    if (this.state.notes[noteId] === undefined) return false
    workspace.refs[noteId] = { collectionId, order: Object.keys(workspace.refs).length + 1 }
    return true
  }

  /** 去掉跨工作区映射(不动笔记本身)。 */
  removeReference(workspaceKey, noteId) {
    const workspace = this.state.workspaces[workspaceKey]
    if (workspace === undefined) return false
    if (workspace.refs[noteId] === undefined) return false
    delete workspace.refs[noteId]
    return true
  }

  /** 钉住 / 取消钉住。 */
  setPinned(noteId, pinned) {
    for (const workspace of Object.values(this.state.workspaces)) {
      const has = workspace.pins.includes(noteId)
      if (pinned && !has) workspace.pins.push(noteId)
      if (!pinned && has) workspace.pins = workspace.pins.filter((value) => value !== noteId)
    }
    return true
  }

  /** 最近打开(去重,最多 20 条)。 */
  touchRecent(workspaceKey, noteId) {
    const workspace = this.state.workspaces[workspaceKey]
    if (workspace === undefined) return false
    workspace.recent = [noteId, ...workspace.recent.filter((value) => value !== noteId)].slice(0, 20)
    return true
  }

  /**
   * 某个路径是否被标为「杂项」(精确路径或 glob 命中)。
   * @param workspaceKey - 工作区键。
   * @param relPath - 工作区相对路径。
   * @returns 命中为 true。
   */
  isIgnored(workspaceKey, relPath) {
    const workspace = this.state.workspaces[workspaceKey]
    if (workspace === undefined) return false
    const path = normalizePath(relPath)
    if ((workspace.ignored ?? []).includes(path)) return true
    return this.isGlobIgnored(workspaceKey, path)
  }

  /**
   * 是否命中「杂项 glob」(**不含**精确路径)。
   *
   * 走目录时只用这一条来剪枝:精确忽略的文件要**留在扫描结果里**(这样界面能列出它、
   * 文件真被删掉时也能把它从忽略清单里摘掉),只有 glob 才是"这条规则以下都别看"。
   * @param workspaceKey - 工作区键。
   * @param relPath - 工作区相对路径。
   * @returns 命中为 true。
   */
  isGlobIgnored(workspaceKey, relPath) {
    const workspace = this.state.workspaces[workspaceKey]
    if (workspace === undefined) return false
    const path = normalizePath(relPath)
    return (workspace.ignoredGlobs ?? []).some((pattern) => globMatch(pattern, path))
  }

  /**
   * 增删「杂项」标记(精确路径走 ignored,含通配符的走 ignoredGlobs)。
   * @param workspaceKey - 工作区键。
   * @param paths - 工作区相对路径。
   * @param globs - glob 模式。
   * @param options - `on: false` = 取消忽略(放回候选)。
   * @returns 变更后的 `{ ignored, ignoredGlobs }`。
   */
  setIgnored(workspaceKey, { paths = [], globs = [] } = {}, { on = true } = {}) {
    const workspace = this.workspace(workspaceKey)
    const addPaths = paths.map((path) => normalizePath(path)).filter((path) => path !== '')
    const addGlobs = globs
      .map((pattern) => String(pattern).trim())
      .filter((pattern) => pattern !== '')
    const ignored = new Set(workspace.ignored ?? [])
    const ignoredGlobs = new Set(workspace.ignoredGlobs ?? [])
    const apply = (set, values) => {
      for (const value of values) {
        if (on) set.add(value)
        else set.delete(value)
      }
    }
    apply(ignored, addPaths)
    apply(ignoredGlobs, addGlobs)
    workspace.ignored = [...ignored]
    workspace.ignoredGlobs = [...ignoredGlobs]
    return { ignored: workspace.ignored, ignoredGlobs: workspace.ignoredGlobs }
  }

  /**
   * 用一次扫描的结果对账本工作区。
   *
   * `scopeRoot` = **这次扫描覆盖的根**:只有该根**之内**的条目才允许被"没扫到"判死;
   * 根之外的已登记笔记(例如工作区其它目录里登记的 md)一律放进 `outside`,交给
   * 调用方 stat 核实 —— 否则登记完、下一次对账就被静默丢掉(实测踩过)。
   * @param workspaceKey - 工作区键。
   * @param scanned - `[{ id, path, title }]`:扫到的 md 文件。
   * @param options - `registerUnknown` 顺带登记未知 id;`scopeRoot` 本次扫描覆盖的根。
   * @returns `{ rebound, registered, dropped, outside }`。
   */
  applyScan(workspaceKey, scanned, { registerUnknown = false, scopeRoot = null } = {}) {
    const workspace = this.state.workspaces[workspaceKey]
    if (workspace === undefined) return { rebound: 0, registered: 0, dropped: 0, outside: [] }
    const result = { rebound: 0, registered: 0, dropped: 0, outside: [] }
    const seenPaths = new Set()
    for (const entry of scanned) {
      // 先无条件记下「这次扫到了这个路径」:id 读不出来(超大文件、读失败)时也
      // **不能**让下面的收尾逻辑把它当作「文件消失」而丢掉条目。
      seenPaths.add(normalizePath(entry.path))
      const note = entry.id === null ? undefined : this.state.notes[entry.id]
      if (note !== undefined) {
        const moved = normalizePath(note.path) !== normalizePath(entry.path)
        const retitled = entry.title !== undefined && entry.title !== note.title
        if (moved || retitled) {
          this.setNotePath(note.id, entry.path, entry.title ?? note.title)
          if (moved) result.rebound += 1
        }
        if ((note.collectionId ?? null) === null && entry.collectionId !== undefined) {
          note.collectionId = entry.collectionId
        }
        continue
      }
      if (!registerUnknown || entry.id === null) continue
      this.addNote({
        id: entry.id,
        path: entry.path,
        workspaceKey,
        collectionId: entry.collectionId ?? null,
        title: entry.title ?? '',
      })
      result.registered += 1
    }
    // 已登记但这次没扫到:扫描范围内 → 文件确实没了,丢条目(不留 tombstone);
    // 扫描范围外 → **不判死**,交给调用方 stat 核实(见 scopeRoot 的说明)。
    const scope = scopeRoot === null ? null : normalizePath(scopeRoot)
    for (const note of Object.values(this.state.notes)) {
      if (note.workspaceKey !== workspaceKey) continue
      const path = normalizePath(note.path)
      if (seenPaths.has(path)) continue
      const inScope = scope !== null && (path === scope || path.startsWith(`${scope}/`))
      if (inScope) {
        this.removeNote(note.id)
        result.dropped += 1
      } else {
        result.outside.push(note.id)
      }
    }
    return result
  }
}

/** 便捷构造:带 id 的新笔记条目(供测试与 service 共用)。 */
export function noteRecord({ path, workspaceKey, collectionId = null, title = '', id = mintNoteId() }) {
  return { id, path: normalizePath(path), workspaceKey, collectionId, title }
}

/** 手动顺序优先,其次按名字/标题(中文按拼音序比较)。 */
function compareOrdered(left, right) {
  const leftOrder = Number.isFinite(left.order) ? left.order : Number.MAX_SAFE_INTEGER
  const rightOrder = Number.isFinite(right.order) ? right.order : Number.MAX_SAFE_INTEGER
  if (leftOrder !== rightOrder) return leftOrder - rightOrder
  const leftName = String(left.name ?? left.title ?? '')
  const rightName = String(right.name ?? right.title ?? '')
  return leftName.localeCompare(rightName, 'zh-Hans-CN')
}
