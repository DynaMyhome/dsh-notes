/**
 * 笔记**历史快照**的纯逻辑(不碰文件系统,可在 `node --test` 里单测)。
 *
 * 为什么要有历史:agent 用通用文件工具(`write`/`edit`)改笔记,插件拦不住写入 ——
 * 唯一能兜住"改坏了要能回到改之前"的办法,就是在**改动发生前后各留一份内容快照**。
 *
 * 三条硬约定:
 *   1. **一个 entry = 一份内容**(`hash` 去重):同一个状态被多个捕获点看到也只留一条。
 *      于是 `agent 写前 → 扫描 → 用户保存 → 扫描` 不会长出一堆重复条目;
 *   2. **`version` 是正确性的核心**:每条 entry 记的是**这份内容对应的 provider 版本**。
 *      「回到这次改动之前」= 从新到旧找第一条 `version !== 当前磁盘版本` 的 entry
 *      (见 {@link predecessorOf})—— 不依赖"倒数第二条"这种位置规则,也不依赖版本号单调;
 *   3. **有界**:超过条数上限从**最旧**裁,永远保留最新一条。
 *
 * 明确**不做**:diff 视图、`callId`/`tool` 这类对正确性没有贡献的元数据、Git 式的
 * 分支/合并。历史只服务三件事:agent 改坏能回退、能翻几个旧版本、不干扰正常读写。
 */

/** 历史索引的 schema 版本。 */
export const HISTORY_SCHEMA_VERSION = 1

/** 条目来源(界面上的徽章;只区分**用户能感知的**几类)。 */
export const HISTORY_ORIGINS = ['baseline', 'agent', 'external', 'restore']

/** 空的索引。 */
export function emptyHistory() {
  return { schemaVersion: HISTORY_SCHEMA_VERSION, notes: {} }
}

/**
 * 规范化索引(容错:缺失/类型不对/损坏都补齐,**不抛**)。
 *
 * 这个文件躺在用户的工作区里,可能被手改、被半截写入、被别的工具动过 ——
 * 读的时候一律按"能救多少救多少"处理,绝不让一个坏条目把历史功能整体带崩。
 * @param raw - `JSON.parse` 的结果(可能为 null / 任意形状)。
 * @returns 规范化后的索引(**新对象**)。
 */
export function normalizeHistory(raw) {
  const out = emptyHistory()
  const notes = raw !== null && typeof raw === 'object' && raw.notes !== null && typeof raw.notes === 'object' ? raw.notes : {}
  for (const [noteId, node] of Object.entries(notes)) {
    if (noteId === '' || node === null || typeof node !== 'object') continue
    const entries = []
    for (const item of Array.isArray(node.entries) ? node.entries : []) {
      if (item === null || typeof item !== 'object') continue
      if (typeof item.file !== 'string' || item.file === '') continue
      entries.push({
        file: item.file,
        at: Number.isFinite(item.at) ? Number(item.at) : 0,
        hash: typeof item.hash === 'string' ? item.hash : '',
        size: Number.isFinite(item.size) ? Number(item.size) : 0,
        version: typeof item.version === 'string' ? item.version : '',
        origin: HISTORY_ORIGINS.includes(item.origin) ? item.origin : 'external',
      })
    }
    out.notes[noteId] = {
      rel: typeof node.rel === 'string' ? node.rel : '',
      version: typeof node.version === 'string' ? node.version : '',
      entries,
    }
  }
  return out
}

/**
 * 某篇笔记的条目(从**新到旧**)。
 * @param history - 索引。
 * @param noteId - 笔记 id。
 */
export function entriesOf(history, noteId) {
  const node = normalizeHistory(history).notes[noteId]
  return node === undefined ? [] : [...node.entries].reverse()
}

/**
 * 追加一条快照(返回**新对象**,不改入参)。
 *
 * - 与**最新一条** `hash` 相同 → 不追加(`added: false`),只把"最后观察到的版本"对齐;
 * - 追加后超过 `maxEntries` → 从最旧开始裁,`dropped` 列出被裁掉的文件名(调用方负责删文件);
 * - 笔记级 `version` 始终跟着**最后一次观察**走(扫描用它判断"变了没有")。
 * @param history - 索引。
 * @param noteId - 笔记 id。
 * @param options - `rel`(工作区相对路径)、`version`、`entry`、`maxEntries`。
 * @returns `{ history, added, dropped }`。
 */
export function upsertEntry(history, noteId, { rel = '', version = '', entry, maxEntries = 50 } = {}) {
  const next = normalizeHistory(history)
  const current = next.notes[noteId] ?? { rel: '', version: '', entries: [] }
  const observed = String(version ?? '')
  const keep = current.entries
  const latest = keep[keep.length - 1]
  const meta = { rel: String(rel ?? '') !== '' ? String(rel) : current.rel, version: observed !== '' ? observed : current.version }
  if (latest !== undefined && latest.hash !== '' && latest.hash === String(entry?.hash ?? '')) {
    // 内容没变(可能是自己刚写的那一份,也可能是重试/扫描重复看到):只对齐版本
    next.notes[noteId] = { ...meta, entries: keep }
    return { history: next, added: false, dropped: [] }
  }
  const appended = keep.concat([
    {
      file: String(entry?.file ?? ''),
      at: Number.isFinite(entry?.at) ? Number(entry.at) : Date.now(),
      hash: String(entry?.hash ?? ''),
      size: Number.isFinite(entry?.size) ? Number(entry.size) : 0,
      version: observed,
      origin: HISTORY_ORIGINS.includes(entry?.origin) ? entry.origin : 'external',
    },
  ])
  const dropped = []
  const limit = Number.isFinite(maxEntries) && maxEntries >= 1 ? Math.floor(maxEntries) : 50
  while (appended.length > limit) {
    const removed = appended.shift()
    if (removed !== undefined && removed.file !== '') dropped.push(removed.file)
  }
  next.notes[noteId] = { ...meta, entries: appended }
  return { history: next, added: true, dropped }
}

/**
 * 「当前磁盘内容**之前**那一次观察」。
 *
 * 从新到旧找第一条 `version !== currentVersion` 的条目:
 *   - 写前快照记的是**写之前**的版本 → 命中的正是这次改动之前的状态;
 *   - 扫描补记的"当前状态"那条(`version === 当前`)会被**跳过** —— 所以它补了几条、
 *     agent 连写了几次都不影响结果。
 *
 * 用**插入顺序**取"最新",只用 `version` 做相等判断(provider 的版本号里是 mtime/ctime,
 * 并不保证单调,绝不能拿它排序)。
 * @param history - 索引。
 * @param noteId - 笔记 id。
 * @param currentVersion - 当前磁盘版本(调用方现 `stat` 出来的)。
 * @returns 条目,或 `null`(没有任何更早的状态)。
 */
export function predecessorOf(history, noteId, currentVersion) {
  const current = String(currentVersion ?? '')
  for (const entry of entriesOf(history, noteId)) {
    if (String(entry.version ?? '') !== current) return entry
  }
  return null
}

/** 快照文件名的形状:`<noteId>/<毫秒时间戳>[-<序号>].md`。 */
const ENTRY_FILE = /^([A-Za-z0-9_-]{1,64})\/(\d{10,16})(?:-(\d{1,4}))?\.md$/

/**
 * 校验一个快照文件名(**防目录穿越**)。
 *
 * 这个字符串来自客户端(预览/恢复都要点名一个条目),所以只接受"第一段就是这篇笔记的
 * id、后面是纯数字时间戳"的形状 —— `..`、`/`、`\`、绝对路径一律不合法。
 * @param noteId - 笔记 id。
 * @param file - 待校验的相对文件名。
 */
export function isValidEntryFile(noteId, file) {
  const match = ENTRY_FILE.exec(String(file ?? ''))
  if (match === null) return false
  return match[1] === String(noteId ?? '')
}

/**
 * 给一条新快照取文件名(纯函数:把"已占用"交给调用方)。
 * @param noteId - 笔记 id。
 * @param at - 毫秒时间戳。
 * @param existing - 该笔记**已占用**的文件名集合。
 * @returns `<noteId>/<at>.md`,撞名就加 `-2`、`-3`…
 */
export function nextEntryFile(noteId, at, existing = new Set()) {
  const stamp = Number.isFinite(at) ? Math.floor(at) : Date.now()
  let index = 1
  let file = `${noteId}/${stamp}.md`
  while (existing.has(file)) {
    index += 1
    file = `${noteId}/${stamp}-${index}.md`
  }
  return file
}
