/**
 * 标签/分栏的**纯模型**(不依赖 React,也不碰 DOM)。
 *
 * 形状与 Obsidian 的 leaf/tab-group 同构但刻意做小:最多两栏(左右),每栏自己的
 * 标签列表 + 活动标签;布局按工作区持久化,重开页面时恢复。
 *
 * 为什么单独成模块:这里全是纯函数(打开/关闭/激活/移栏/序列化),好推理也好测,
 * 组件只管渲染和事件。
 */

/** 一个打开的标签(指向某个工作区里的一篇笔记;`ref` = 跨工作区映射的只读条目)。 */
export interface NoteTab {
  /** 稳定 key:`<workspaceKey>:<noteId>`(同一篇笔记在两栏里也只算一个标签实例)。 */
  key: string
  workspaceKey: string
  noteId: string
  path: string
  title: string
  /** 跨工作区映射(只读占位,没有编辑器)。 */
  ref?: boolean
}

/** 一栏(一个 tab group)。 */
export interface PaneState {
  id: 'p1' | 'p2'
  tabs: NoteTab[]
  active: string | null
}

/** 整个编辑区状态。 */
export interface LayoutState {
  panes: PaneState[]
  /** 键盘/大纲跟随的栏。 */
  activePane: 'p1' | 'p2'
}

/** 每栏标签数上限(每栏一个 CodeMirror 实例,太多会吃内存)。 */
export const MAX_TABS_PER_PANE = 8

/** 空布局:一栏、空标签。 */
export function emptyLayout(): LayoutState {
  return { panes: [{ id: 'p1', tabs: [], active: null }], activePane: 'p1' }
}

/** 由笔记生成标签 key(同一篇笔记在同一栏里只会有一个标签)。 */
export function tabKeyOf(workspaceKey: string, noteId: string): string {
  return `${workspaceKey}:${noteId}`
}

/** 找某一栏。 */
function paneOf(layout: LayoutState, id: 'p1' | 'p2'): PaneState | undefined {
  return layout.panes.find((pane) => pane.id === id)
}

/** 在任意栏里找某个标签。 */
export function findTab(layout: LayoutState, key: string): { pane: PaneState; tab: NoteTab } | null {
  for (const pane of layout.panes) {
    const tab = pane.tabs.find((item) => item.key === key)
    if (tab !== undefined) return { pane, tab }
  }
  return null
}

/**
 * 打开一篇笔记。
 *
 * 语义照 Obsidian:普通打开 = 在**活动栏**里替换当前标签(同一篇已开着就激活它);
 * `mode='tab'` = 在当前栏新开一个标签。
 * @param layout - 当前布局。
 * @param tab - 要打开的标签。
 * @param options - `mode`:`reuse`(默认,替换当前标签)/ `tab`(新标签)/ `split`(移到/开到第 2 栏)。
 * @returns 新布局(纯函数,不改原对象)。
 */
export function openTab(
  layout: LayoutState,
  tab: NoteTab,
  { mode = 'reuse' as 'reuse' | 'tab' | 'split' } = {},
): LayoutState {
  const next = cloneLayout(layout)
  const existing = findTab(next, tab.key)
  if (existing !== null) {
    // 已经开着:激活它(如果指定了 split 而它在别的栏,就把它挪到第 2 栏)
    if (mode === 'split' && existing.pane.id !== 'p2') {
      return moveTabToPane(next, tab.key, 'p2')
    }
    next.panes = next.panes.map((pane) => (pane.id === existing.pane.id ? { ...pane, active: tab.key } : pane))
    next.activePane = existing.pane.id
    return next
  }

  if (mode === 'split') {
    const second = ensureSecondPane(next)
    if (second.tabs.length >= MAX_TABS_PER_PANE) return next
    second.tabs = [...second.tabs, tab]
    second.active = tab.key
    next.activePane = 'p2'
    return next
  }

  const pane = paneOf(next, next.activePane) ?? next.panes[0]
  if (mode === 'tab') {
    if (pane.tabs.length >= MAX_TABS_PER_PANE) return next
    pane.tabs = [...pane.tabs, tab]
  } else {
    // 替换当前标签(没有活动标签就追加)
    const index = pane.active === null ? -1 : pane.tabs.findIndex((item) => item.key === pane.active)
    if (index >= 0) {
      const tabs = [...pane.tabs]
      tabs[index] = tab
      pane.tabs = tabs
    } else {
      pane.tabs = [...pane.tabs, tab]
    }
  }
  pane.active = tab.key
  return next
}

/** 关闭一个标签(该栏空了就清空 active;只剩两栏里的一栏空着也没关系)。 */
export function closeTab(layout: LayoutState, key: string): LayoutState {
  const next = cloneLayout(layout)
  for (const pane of next.panes) {
    const index = pane.tabs.findIndex((item) => item.key === key)
    if (index < 0) continue
    const tabs = pane.tabs.filter((item) => item.key !== key)
    let active = pane.active
    if (active === key) {
      // 关掉活动标签 → 激活它右边那个,没有就左边
      active = tabs[index]?.key ?? tabs[index - 1]?.key ?? null
    }
    pane.tabs = tabs
    pane.active = active
  }
  // 第 2 栏空了就收掉(回到单栏)
  const second = paneOf(next, 'p2')
  if (second !== undefined && second.tabs.length === 0) next.panes = next.panes.filter((pane) => pane.id === 'p1')
  if (next.activePane === 'p2' && paneOf(next, 'p2') === undefined) next.activePane = 'p1'
  return next
}

/** 激活某栏里的某个标签(也把该栏设为活动栏)。 */
export function activateTab(layout: LayoutState, key: string): LayoutState {
  const next = cloneLayout(layout)
  const found = findTab(next, key)
  if (found === null) return next
  next.panes = next.panes.map((pane) => (pane.id === found.pane.id ? { ...pane, active: key } : pane))
  next.activePane = found.pane.id
  return next
}

/** 关掉某栏里除 `key` 之外的标签。 */
export function closeOtherTabs(layout: LayoutState, key: string): LayoutState {
  const next = cloneLayout(layout)
  const found = findTab(next, key)
  if (found === null) return next
  next.panes = next.panes.map((pane) => (pane.id === found.pane.id ? { ...pane, tabs: [found.tab], active: key } : pane))
  return next
}

/** 保证第 2 栏存在(用于"向右分屏")。 */
export function ensureSecondPane(layout: LayoutState): PaneState {
  const existing = paneOf(layout, 'p2')
  if (existing !== undefined) return existing
  const created: PaneState = { id: 'p2', tabs: [], active: null }
  layout.panes = [...layout.panes, created]
  return created
}

/** 把一个标签挪到另一栏(拖到右边 / 分屏打开)。 */
export function moveTabToPane(layout: LayoutState, key: string, target: 'p1' | 'p2'): LayoutState {
  const next = cloneLayout(layout)
  const found = findTab(next, key)
  if (found === null || found.pane.id === target) return next
  if ((paneOf(next, target)?.tabs.length ?? 0) >= MAX_TABS_PER_PANE) return next
  // 先摘掉,再放进目标栏(顺序很重要:目标栏可能是新建的)
  for (const pane of next.panes) {
    if (pane.id !== found.pane.id) continue
    const tabs = pane.tabs.filter((item) => item.key !== key)
    pane.tabs = tabs
    if (pane.active === key) pane.active = tabs[0]?.key ?? null
  }
  const dest = target === 'p2' ? ensureSecondPane(next) : (paneOf(next, 'p1') as PaneState)
  dest.tabs = [...dest.tabs, found.tab]
  dest.active = key
  next.activePane = dest.id
  // 源栏空了:第 2 栏就收掉(第 1 栏空着没关系,它是常驻的)
  const source = paneOf(next, found.pane.id)
  if (source !== undefined && source.id === 'p2' && source.tabs.length === 0) {
    next.panes = next.panes.filter((pane) => pane.id === 'p1' || pane.tabs.length > 0)
    if (next.activePane === 'p2') next.activePane = 'p1'
  }
  return next
}

/** 关掉第 2 栏(标签并入第 1 栏末尾)。 */
export function closeSecondPane(layout: LayoutState): LayoutState {
  const next = cloneLayout(layout)
  const second = paneOf(next, 'p2')
  const first = paneOf(next, 'p1')
  if (second === undefined || first === undefined) return next
  const merged = [...first.tabs]
  for (const tab of second.tabs) {
    if (!merged.some((item) => item.key === tab.key)) merged.push(tab)
  }
  first.tabs = merged.slice(0, MAX_TABS_PER_PANE)
  first.active = second.active !== null && first.tabs.some((item) => item.key === second.active) ? second.active : first.active ?? first.tabs[0]?.key ?? null
  next.panes = [first]
  next.activePane = 'p1'
  return next
}

/**
 * 按工作区安全地清理标签。
 *
 * 与 {@link pruneTabs} 的区别:这个只删**确实属于该工作区、且该工作区的笔记列表里没有**
 * 的标签。踩过的坑:早先用"当前 layoutKey 算出来的全量集合"当判据,于是
 * ① 布局还在 `session` 键下、而工作区键已经解析出来时,标签被整批误删
 * ② 拿到别的工作区的树时,也会把当前标签删掉 —— 表现就是"打开笔记几秒后自己关了"。
 * @param layout - 当前布局。
 * @param workspaceKey - 当前工作区键。
 * @param noteIds - 该工作区当前的笔记 id 集合。
 * @returns 新布局(可能原样返回)。
 */
export function pruneTabsForWorkspace(
  layout: LayoutState,
  workspaceKey: string,
  noteIds: Iterable<string>,
): LayoutState {
  const alive = noteIds instanceof Set ? noteIds : new Set(noteIds)
  const keep = (tab: NoteTab): boolean =>
    tab.ref === true || tab.workspaceKey !== workspaceKey || alive.has(tab.noteId)
  const next = cloneLayout(layout)
  next.panes = next.panes.map((pane) => {
    const tabs = pane.tabs.filter(keep)
    return { ...pane, tabs, active: tabs.some((tab) => tab.key === pane.active) ? pane.active : (tabs[0]?.key ?? null) }
  })
  const second = paneOf(next, 'p2')
  if (second !== undefined && second.tabs.length === 0) next.panes = next.panes.filter((pane) => pane.id === 'p1')
  if (next.activePane === 'p2' && paneOf(next, 'p2') === undefined) next.activePane = 'p1'
  return next
}

/**
 * 把一份布局从一个存储键迁到另一个键(**只在目标还没有自己的布局时**)。
 *
 * 用途:挂载瞬间还不知道工作区键,标签会先存到 `session` 键下;等键解析出来时把这
 * 一份迁过去,否则切键的那一刻标签会"消失"(用户实测的自动关闭)。
 * @param fromKey - 源键(通常是 `session`)。
 * @param toKey - 目标工作区键。
 * @param storage - 可注入的存储(便于单测)。
 * @returns 是否真的迁移了。
 */
export function migrateLayout(
  fromKey: string,
  toKey: string,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = typeof window === 'undefined' ? null : window.localStorage,
): boolean {
  if (storage === null || fromKey === toKey) return false
  try {
    if (storage.getItem(layoutStorageKey(toKey)) !== null) return false
    const source = storage.getItem(layoutStorageKey(fromKey))
    if (source === null) return false
    storage.setItem(layoutStorageKey(toKey), source)
    storage.removeItem(layoutStorageKey(fromKey))
    return true
  } catch {
    return false
  }
}

/** 去掉已经不存在的笔记(工作区删了/笔记移出索引了)后重建布局。 */
export function pruneTabs(layout: LayoutState, alive: (key: string) => boolean): LayoutState {
  const next = cloneLayout(layout)
  next.panes = next.panes.map((pane) => {
    const tabs = pane.tabs.filter((tab) => alive(tab.key))
    return { ...pane, tabs, active: tabs.some((tab) => tab.key === pane.active) ? pane.active : tabs[0]?.key ?? null }
  })
  const second = paneOf(next, 'p2')
  if (second !== undefined && second.tabs.length === 0) {
    next.panes = next.panes.filter((pane) => pane.id === 'p1')
    if (next.activePane === 'p2') next.activePane = 'p1'
  }
  return next
}

/** 深拷贝(布局很小,JSON 往返即可,顺带保证可持久化)。 */
function cloneLayout(layout: LayoutState): LayoutState {
  return JSON.parse(JSON.stringify(layout)) as LayoutState
}

/**
 * 序列化到 localStorage 的值。
 *
 * 按**工作区**存:切到别的工作区时,各自的标签/分栏互不干扰(Obsidian 也是按 vault 存)。
 */
export function layoutStorageKey(workspaceKey: string): string {
  return `dsh-notes:tabs:${workspaceKey}`
}

/** 读布局(坏数据/没存过 → 空布局)。 */
export function loadLayout(workspaceKey: string): LayoutState {
  try {
    const raw = window.localStorage.getItem(layoutStorageKey(workspaceKey))
    if (raw === null) return emptyLayout()
    const parsed = JSON.parse(raw) as LayoutState
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.panes) || parsed.panes.length === 0) {
      return emptyLayout()
    }
    // 防御:只认 p1/p2、去重 key、修 active
    const panes: PaneState[] = []
    for (const id of ['p1', 'p2'] as const) {
      const pane = parsed.panes.find((item) => item?.id === id)
      if (pane === undefined) continue
      const seen = new Set<string>()
      const tabs = (Array.isArray(pane.tabs) ? pane.tabs : []).filter((tab) => {
        if (tab === null || typeof tab.key !== 'string' || seen.has(tab.key)) return false
        seen.add(tab.key)
        return true
      })
      panes.push({
        id,
        tabs: tabs.slice(0, MAX_TABS_PER_PANE),
        active: tabs.some((tab) => tab.key === pane.active) ? pane.active : (tabs[0]?.key ?? null),
      })
    }
    if (panes.length === 0) return emptyLayout()
    return {
      panes,
      activePane: parsed.activePane === 'p2' && panes.some((pane) => pane.id === 'p2') ? 'p2' : 'p1',
    }
  } catch {
    return emptyLayout()
  }
}

/** 写布局(存不了就算了:隐私模式等)。 */
export function saveLayout(workspaceKey: string, layout: LayoutState): void {
  try {
    window.localStorage.setItem(layoutStorageKey(workspaceKey), JSON.stringify(layout))
  } catch {
    /* 忽略 */
  }
}
