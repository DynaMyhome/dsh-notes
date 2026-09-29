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

import { mintCollectionId, mintNoteId, normalizePath } from './notes.js'

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
      }
      workspaces[key] = workspace
    } else {
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

  /** 改归属(null = 未归类)。 */
  moveNote(id, collectionId = null) {
    const note = this.state.notes[id]
    if (note === undefined) return false
    note.collectionId = collectionId
    note.updatedAt = Date.now()
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
   * 移动分类(带环检测)。
   * @returns 是否成功。
   */
  moveCollection(workspaceKey, id, parentId = null) {
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
   * 用一次受限扫描的结果对账本工作区。
   *
   * @param workspaceKey - 工作区键。
   * @param scanned - `[{ id, path, title }]`:带 `dsh-note-id` 的 md 文件。
   * @returns `{ rebound, registered, dropped }`。
   */
  applyScan(workspaceKey, scanned, { registerUnknown = false } = {}) {
    const workspace = this.state.workspaces[workspaceKey]
    if (workspace === undefined) return { rebound: 0, registered: 0, dropped: 0 }
    const result = { rebound: 0, registered: 0, dropped: 0 }
    const seenPaths = new Set()
    for (const entry of scanned) {
      const note = entry.id === null ? undefined : this.state.notes[entry.id]
      if (note !== undefined) {
        seenPaths.add(normalizePath(entry.path))
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
      seenPaths.add(normalizePath(entry.path))
      result.registered += 1
    }
    // 已登记但这次没扫到(文件消失)→ 直接丢条目,不留 tombstone。
    for (const note of Object.values(this.state.notes)) {
      if (note.workspaceKey !== workspaceKey) continue
      if (seenPaths.has(normalizePath(note.path))) continue
      this.removeNote(note.id)
      result.dropped += 1
    }
    return result
  }
}

/** 便捷构造:带 id 的新笔记条目(供测试与 service 共用)。 */
export function noteRecord({ path, workspaceKey, collectionId = null, title = '', id = mintNoteId() }) {
  return { id, path: normalizePath(path), workspaceKey, collectionId, title }
}
