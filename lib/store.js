/**
 * 存储位置决策 + 数据切片(纯函数,不碰文件系统)。
 *
 * 为什么要有这一层:插件的**语义数据**(分类树、笔记归属、忽略规则、置顶、回收站)
 * 以前全在 `$DSH_HOME/knowledge/registry.json` —— 那是**用户主目录**。用户备份/搬走工作区时
 * 这些数据不跟着走,换台机器就得从头组织一遍。现在默认放进工作区自己的
 * `<root>/.dsh-notes/`;机器本地只留两类东西:① 派生缓存 ② "这台机器见过哪些工作区"。
 *
 * 三条硬约定:
 *   1. **工作区键是派生的,不是数据** —— 文件里存了也不可信,加载时一律按当前 root 重算
 *      (见 {@link adoptWorkspaceKey})。否则"把工作区挪到别的路径"就会失配。
 *   2. **工作区文件的 schema 与整体索引完全相同**(`{schemaVersion, notes, workspaces}`),
 *      只是内容被切成"这一个工作区"。这样 `NoteRegistry` / `stateFromJSON` 一行都不用改,
 *      损坏备份、重扫、applyScan 等既有路径全部复用。
 *   3. **点目录天然安全**:两个 walker 都跳过 `.` 开头的目录,所以 `.dsh-notes/`
 *      (含 `.trash/` 里的 `.md`)不会被当成候选笔记扫到 —— 这是回收站搬进工作区的前提。
 */

import { join } from 'node:path'

/** 工作区内的插件数据目录(点开头 → 不被扫描)。 */
export const STORE_DIRNAME = '.dsh-notes'
/** 工作区薄索引文件名。 */
export const STORE_FILENAME = 'index.json'
/** 工作区回收站目录名。 */
export const TRASH_DIRNAME = '.trash'
/** 回收站索引文件名(在回收站目录内)。 */
export const TRASH_FILENAME = 'trash.json'
/** 机器本地的"已知工作区根"文件名(放在 knowledge 根下)。 */
export const ROOTS_FILENAME = 'workspaces.json'
/** 写进 `.dsh-notes/.gitignore` 的内容:让插件数据不进用户的 `git status`。 */
export const STORE_GITIGNORE = '*\n'

/** 读配置里的存储形态:`'workspace'`(默认)或 `'home'`。 */
export function resolveStoreScope(config = {}) {
  return String(config.storeScope ?? '').trim() === 'home' ? 'home' : 'workspace'
}

/** 机器本地的 knowledge 根(缓存 + 已知根 + 旧整体索引):`Config.storeDir` 或 `$DSH_HOME/knowledge`。 */
export function homeStoreRoot(config, env = process.env, home = '') {
  const configured = String(config?.storeDir ?? '').trim()
  if (configured !== '') return configured
  const dshHome = String(env?.DSH_HOME ?? '').trim() !== '' ? env.DSH_HOME : join(home || '.', '.dsh')
  return join(dshHome, 'knowledge')
}

/** 旧的整体索引文件(`home` 形态在用,`workspace` 形态只作为迁移来源/备份)。 */
export function homeStoreFile(config, env, home) {
  return join(homeStoreRoot(config, env, home), 'registry.json')
}

/** 机器本地:已知工作区根列表。 */
export function rootsFile(config, env, home) {
  return join(homeStoreRoot(config, env, home), ROOTS_FILENAME)
}

/** 机器本地:扫描缓存目录(`<key>.json`)。 */
export function cacheFileFor(config, key, env, home) {
  return join(homeStoreRoot(config, env, home), 'index', `${key}.json`)
}

/** 工作区内的插件数据目录。 */
export function workspaceStoreRoot(root) {
  return join(root, STORE_DIRNAME)
}

/** 工作区薄索引文件。 */
export function workspaceStoreFile(root) {
  return join(workspaceStoreRoot(root), STORE_FILENAME)
}

/**
 * 该用哪个目录放这个工作区的语义数据。
 * @param scope - `resolveStoreScope()` 的结果。
 * @param root - 工作区根(绝对路径)。
 */
export function storeRootFor(scope, config, root, env, home) {
  return scope === 'home' ? homeStoreRoot(config, env, home) : workspaceStoreRoot(root)
}

/** 该用哪个文件放这个工作区的薄索引。 */
export function storeFileFor(scope, config, root, env, home) {
  return scope === 'home' ? homeStoreFile(config, env, home) : workspaceStoreFile(root)
}

/** 该工作区的回收站目录。 */
export function trashRootFor(scope, config, root, env, home) {
  return scope === 'home' ? join(homeStoreRoot(config, env, home), 'trash') : join(workspaceStoreRoot(root), TRASH_DIRNAME)
}

/** 该工作区的回收站索引文件。 */
export function trashIndexFileFor(scope, config, root, env, home) {
  return join(trashRootFor(scope, config, root, env, home), TRASH_FILENAME)
}

/* ------------------------------------------------------------------ */
/* 数据切片(纯)                                                       */
/* ------------------------------------------------------------------ */

/** 空的机器本地已知根表。 */
export function emptyRoots() {
  return { schemaVersion: 1, workspaces: {} }
}

/**
 * 规范化机器本地已知根表(容错:字段缺失/类型不对都补齐)。
 * @param raw - 解析出来的对象(可能为 null)。
 */
export function normalizeRoots(raw) {
  const workspaces = {}
  const source = raw !== null && typeof raw === 'object' && raw.workspaces !== null && typeof raw.workspaces === 'object' ? raw.workspaces : {}
  for (const [key, node] of Object.entries(source)) {
    if (node === null || typeof node !== 'object') continue
    const root = typeof node.root === 'string' ? node.root : ''
    if (root === '') continue
    workspaces[key] = {
      root,
      name: typeof node.name === 'string' ? node.name : '',
      lastUsedAt: Number.isFinite(node.lastUsedAt) ? Number(node.lastUsedAt) : 0,
      ...(Number.isFinite(node.migratedAt) ? { migratedAt: Number(node.migratedAt) } : {}),
    }
  }
  return { schemaVersion: 1, workspaces }
}

/**
 * 从**旧的整体索引**里提取"已知工作区根"。
 *
 * 升级路径:第一次跑 `workspace` 形态时,机器本地还没有 `workspaces.json`,
 * 就从旧的 `registry.json` 把根路径捞出来 —— 这样工作区切换器的列表不会空掉。
 * @param state - 旧的整体索引 state(`{notes, workspaces}`)。
 */
export function rootsFromLegacy(state) {
  const roots = emptyRoots()
  const workspaces = state !== null && typeof state === 'object' && state.workspaces !== null && typeof state.workspaces === 'object' ? state.workspaces : {}
  for (const [key, node] of Object.entries(workspaces)) {
    if (node === null || typeof node !== 'object' || typeof node.root !== 'string' || node.root === '') continue
    roots.workspaces[key] = {
      root: node.root,
      name: typeof node.name === 'string' ? node.name : '',
      lastUsedAt: Number.isFinite(node.lastUsedAt) ? Number(node.lastUsedAt) : 0,
    }
  }
  return roots
}

/** 登记/更新一个已知根(返回新对象,不改入参)。 */
export function upsertRoot(roots, key, patch = {}) {
  const next = normalizeRoots(roots)
  const current = next.workspaces[key] ?? { root: '', name: '', lastUsedAt: 0 }
  next.workspaces[key] = { ...current, ...patch, root: String(patch.root ?? current.root) }
  return next
}

/** 把某个工作区从已知根表里去掉(返回新对象)。 */
export function dropRoot(roots, key) {
  const next = normalizeRoots(roots)
  delete next.workspaces[key]
  return next
}

/**
 * 把**整体 state** 切成"某一个工作区的存储形态"。
 *
 * 输出与原 state 同构(只是 `notes` 只留这个工作区的、`workspaces` 只有一个键),
 * 于是 `NoteRegistry` / `stateFromJSON` 完全不用改。
 * @param state - 整体 state。
 * @param key - 工作区键。
 */
export function sliceFor(state, key) {
  const notes = {}
  const source = state !== null && typeof state === 'object' && state.notes !== null && typeof state.notes === 'object' ? state.notes : {}
  for (const [id, note] of Object.entries(source)) {
    if (note === null || typeof note !== 'object') continue
    if (String(note.workspaceKey ?? '') !== key) continue
    notes[id] = { ...note, workspaceKey: key }
  }
  const node = state?.workspaces?.[key]
  const workspaces = node === undefined ? {} : { [key]: node }
  return { schemaVersion: Number(state?.schemaVersion ?? 1), notes, workspaces }
}

/**
 * 把工作区切片并回整体 state(`migrate → home` 用)。
 * @param state - 目标整体 state。
 * @param slice - 某个工作区的切片。
 * @param key - 该切片的工作区键。
 */
export function mergeSlice(state, slice, key) {
  const out = {
    schemaVersion: Number(state?.schemaVersion ?? 1),
    notes: { ...(state?.notes ?? {}) },
    workspaces: { ...(state?.workspaces ?? {}) },
  }
  for (const [id, note] of Object.entries(slice?.notes ?? {})) {
    out.notes[id] = { ...note, workspaceKey: key }
  }
  const node = slice?.workspaces?.[key]
  if (node !== undefined) out.workspaces[key] = node
  return out
}

/**
 * 把某个工作区从整体 state 里摘掉(`migrate → workspace` 成功后清理旧文件用,可选)。
 * @param state - 整体 state。
 * @param key - 工作区键。
 */
export function pluckWorkspace(state, key) {
  const out = {
    schemaVersion: Number(state?.schemaVersion ?? 1),
    notes: {},
    workspaces: { ...(state?.workspaces ?? {}) },
  }
  for (const [id, note] of Object.entries(state?.notes ?? {})) {
    if (String(note?.workspaceKey ?? '') === key) continue
    out.notes[id] = note
  }
  delete out.workspaces[key]
  return out
}

/**
 * 这个工作区切片是不是"什么都没记"(所以**不值得在工作区里建文件**)。
 *
 * 用途:用户可能只是**看了一眼**某个工作区(切过去、渲染一次树),那一下会触发一次对账;
 * 对账完就落盘的话,每个被看过一眼的工作区都会多出一个 `.dsh-notes/` 空目录 ——
 * 那是"用户无感"的反面(实测踩到:切到隔壁工作区,它里面立刻多了个点目录)。
 * 所以:磁盘上还没有文件、且这份切片是空的 → 不写。
 * @param slice - `sliceFor()` 的输出。
 */
export function isEmptySlice(slice) {
  if (Object.keys(slice?.notes ?? {}).length > 0) return false
  const keys = Object.keys(slice?.workspaces ?? {})
  const node = keys.length === 0 ? undefined : slice.workspaces[keys[0]]
  if (node === undefined) return true
  for (const list of [node.collections, node.refs]) {
    if (list !== null && typeof list === 'object' && Object.keys(list).length > 0) return false
  }
  for (const key of ['pins', 'recent', 'ignored', 'ignoredGlobs', 'scanRoots']) {
    if (Array.isArray(node[key]) && node[key].length > 0) return false
  }
  if (typeof node.notesRootOverride === 'string' && node.notesRootOverride !== '') return false
  return true
}

/**
 * 把一个绝对路径从旧根搬到新根下(前缀替换;不在旧根下就原样返回)。
 * @param oldRoot - 索引里记着的旧工作区根。
 * @param newRoot - 当前工作区根。
 * @param path - 待重定位的绝对路径。
 */
function rebasePath(oldRoot, newRoot, path) {
  const old = String(oldRoot ?? '').replace(/\/+$/, '')
  const next = String(newRoot ?? '').replace(/\/+$/, '')
  if (old === '' || next === '' || old === next) return path
  if (path === old) return next
  if (path.startsWith(`${old}/`)) return `${next}${path.slice(old.length)}`
  return path
}

/**
 * 让一份**从工作区文件读出来的 state** 认领当前的工作区键与根路径。
 *
 * 这是"跟着工作区走"能成立的关键。写入当时记了两样**环境相关**的东西:
 *   ① 工作区键(路径派生)、② 笔记的**绝对路径**。
 * 用户完全可能把工作区挪到别的目录、拷到别的机器 —— 加载时一律以**当前 root** 为准:
 *   - 单工作区文件整体改挂到新键;
 *   - 旧根之下的路径(笔记 / 自定义笔记根)按相对位置重定位到新根;
 *   - 笔记的 `workspaceKey` 一并改写。
 * 这样"备份一份工作区 → 换台机器打开"出来的是同一棵树,而不是一堆指向旧机器的死路径。
 * @param state - 刚从工作区文件解析出来的 state(**会被就地修改**)。
 * @param key - 当前 root 派生出来的键。
 * @param root - 当前工作区根(绝对路径);省略 = 不重定位路径,只统一键。
 */
export function adoptWorkspaceKey(state, key, root = '') {
  if (state === null || typeof state !== 'object') return state
  state.workspaces = state.workspaces !== null && typeof state.workspaces === 'object' ? state.workspaces : {}
  const keys = Object.keys(state.workspaces)
  if (state.workspaces[key] === undefined && keys.length === 1) {
    // 单工作区文件 + 键不同 → 说明工作区被搬过路径,整体改挂到新键
    state.workspaces[key] = state.workspaces[keys[0]]
    delete state.workspaces[keys[0]]
  }
  const node = state.workspaces[key]
  const oldRoot = typeof node?.root === 'string' ? node.root : ''
  if (node !== undefined && root !== '' && oldRoot !== '' && oldRoot !== root) {
    if (typeof node.notesRoot === 'string') node.notesRoot = rebasePath(oldRoot, root, node.notesRoot)
    if (typeof node.notesRootOverride === 'string' && node.notesRootOverride !== '') {
      node.notesRootOverride = rebasePath(oldRoot, root, node.notesRootOverride)
    }
    node.root = root
    if (state.notes !== null && typeof state.notes === 'object') {
      for (const note of Object.values(state.notes)) {
        if (note !== null && typeof note === 'object' && typeof note.path === 'string') {
          note.path = rebasePath(oldRoot, root, note.path)
        }
      }
    }
  }
  if (state.notes !== null && typeof state.notes === 'object') {
    for (const note of Object.values(state.notes)) {
      if (note !== null && typeof note === 'object') note.workspaceKey = key
    }
  }
  return state
}
