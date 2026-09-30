/**
 * dsh-notes — Client 半。
 *
 * P0 只做两件事:
 *   1. 注册右侧栏 tab 类型 `notes`(并在官方 guide 页留一枚入口胶囊);
 *   2. 把区域外壳注册进 `sidebar.right.pane.tab`,键 = 本包 id。
 *
 * 位置决定(实测依据):DSH 左栏只有一个内容区且已被 ui-workspace 独占,
 * 插件可用的加法插槽是右栏的 `sidebar.right.pane.tab`。因此笔记树与编辑区
 * 都放进这一个 tab 内部分栏,中央对话永不被遮挡。
 */

import React from 'react'

import { NotesPane } from './NotesPane'
import { IconNote } from './icons'
import { CSS } from './styles'

/** 本包名(= 模块加载器里的注册 id)。 */
const PKG = 'dsh-notes'
/** tab 类型身份:同时是 `sidebar.right.pane.tab` 的键。 */
const ID = 'dsh-notes'
/** tab 类型判别符:`ctx.sidebarRight.openTab('notes')` 用它。 */
const KIND = 'notes'
/** 文案命名空间。 */
const NS = 'dshNotes'

const ZH: Record<string, string> = {
  'tab.title': '笔记',
  'tab.guide': '打开笔记区域:左侧笔记树(分类 / 未归类),右侧 Markdown 编辑器。',
  'tree.collapse': '收起笔记树',
  'tree.expand': '展开笔记树',
  'tree.resize': '拖动调整笔记树宽度',
  'tree.title': '笔记树',
  'tree.loading': '读取中…',
  'tree.summary': '{n} 篇笔记 · {c} 个分类',
  'tree.empty': '这个工作区还没有笔记。标题栏 ＋ 新建,或让 Agent 写一篇 md 再登记。',
  'tree.hint': '「未归类文件」是笔记根下存在、但还没纳入笔记树的 md:点一下即可纳入。',
  'notesdir.title': '这个工作区还没有 {p}/ 目录',
  'notesdir.hint': '笔记默认放在 {p}/。你可以创建它,或把工作区里已有的目录(如 docs)设为笔记根 —— 只创建,不会动任何现有文件。',
  'notesdir.create': '创建 {p}/',
  'notesdir.apply': '设为笔记根',
  'notesdir.useExisting': '改用已有目录(工作区相对,如 docs)',
  'notesdir.later': '暂时忽略',
  'status.notesDirCreated': '已创建 {p}',
  'status.notesRootSet': '笔记根已设为 {p}',
  'tabs.close': '关闭标签(中键也可以)',
  'tabs.quickOpen': '快速打开(Ctrl/Cmd+P)',
  'tabs.splitRight': '向右分屏(也可以把标签拖过去)',
  'tabs.moveLeft': '移到左栏',
  'tabs.closeSplit': '关闭分屏(标签并入左栏)',
  'tabs.mergeShort': '合并',
  'ws.switch': '切换工作区(笔记区域可以看别的已登记工作区)',
  'ws.sessionWorkspace': '会话工作区',
  'ws.sessionTag': '当前会话',
  'ws.openPath': '打开其它目录(绝对路径,回车)',
  'ws.backToSession': '回到会话自己的工作区',
  'status.workspaceOpened': '已打开工作区:{p}',
  'tree.unfiled': '未纳入',
  'tree.unfiledHint': '点开「纳入管理」:候选(未标记)/ 杂项 一览,可搜索、多选、批量纳入或忽略',
  'tree.ignoredBadge': '杂项 {n}',
  'menu.unregisterIgnore': '移出并忽略',
  'action.files': '纳入管理(未纳入的 md)',
  'files.title': '纳入管理',
  'files.close': '关闭',
  'files.stats': '笔记 {notes} · 候选 {candidates} · 杂项 {ignored} · 工作区 md {total}',
  'files.search': '搜索路径或文件名…',
  'files.seg.recent': '最近',
  'files.seg.folders': '按文件夹',
  'files.seg.ignored': '已忽略',
  'files.loading': '正在扫描工作区…',
  'files.empty': '没有未纳入的 md',
  'files.emptyIgnored': '没有已忽略的文件',
  'files.rootFolder': '(工作区根)',
  'files.more': '还有 {n} 个…',
  'files.rules': '批量忽略规则',
  'files.dropRule': '删除规则',
  'files.picked': '已选 {n} 个',
  'files.include': '纳入',
  'files.ignore': '忽略',
  'files.restore': '放回候选',
  'files.hint': '勾选后可批量纳入或忽略;忽略只做标记,不动文件',
  'files.hintIgnored': '勾选后可放回候选',
  'files.truncated': '文件过多,已截断',
  'files.scope': '扫描范围',
  'files.addRoot': '加目录(回车)…',
  'files.dropRoot': '不再扫这个目录',
  'files.wholeWorkspace': '整个工作区',
  'files.wholeHint': '扫整个工作区:目录多时很慢(本机实测每目录约 0.3s),会分批续扫',
  'files.scanning': '扫描中:已看 {dirs} 个目录 · {files} 个 md…',
  'files.back': '返回',
  'files.badge': '有 id',
  'files.hadId': '这个文件已有 dsh-note-id:纳入时沿用,跨改名/移动也认得出',
  'status.included': '已纳入 {n} 篇',
  'status.includedSome': '已纳入 {n} 篇,{m} 篇失败',
  'status.ignored': '已标为杂项 {n} 项(可在「已忽略」放回)',
  'status.unignored': '已放回候选 {n} 项',
  'status.unregisteredIgnored': '「{p}」已移出笔记并标为杂项',
  'tree.collectionHint': '分类(可折叠;把笔记或分类拖到它上面)',
  'tree.refHint': '来自其它工作区:{name}(映射,不是副本)',
  'action.newNote': '新建笔记',
  'action.newCollection': '新建分类',
  'action.rescan': '重新扫描(按 dsh-note-id 重建映射)',
  'compose.note': '笔记标题,回车创建',
  'compose.collection': '分类名,回车创建',
  'compose.ok': '建',
  'status.untitled': '未命名',
  'status.newCollection': '新分类',
  'status.wikiMissing': '没有这篇笔记(不会自动新建)',
  'status.created': '已新建并登记',
  'status.collectionCreated': '已新建分类',
  'status.registered': '已纳入笔记树',
  'status.moved': '已移动',
  'status.rescanned': '已重新扫描',
  // 重扫回显:告诉用户这次扫描到底改变了什么(以前按钮"看不出用处")
  'status.rescanReport': '扫描完成:md {scanned} 个 · 重绑 {rebound} · 移除 {dropped} · 未纳入 {unfiled}',
  'status.rescanTruncated': '(文件过多,已截断)',
  'status.noSession': '没有会话上下文,无法定位工作区',
  'editor.pending': '编辑器在 P2 接入(CodeMirror 6);现在这里显示选中笔记的路径。',
  'editor.noSelection': '在左侧选一篇笔记。',
  'editor.refFrom': '来自其它工作区:{name}(映射,不是副本)',
  'editor.loading': '载入中…',
  'editor.saving': '保存中…',
  'editor.dirty': '未保存',
  'editor.saved': '已保存',
  'editor.saveFailed': '保存失败',
  'editor.loadFailed': '打不开这篇笔记。',
  'editor.conflict': '文件已被外部修改(Agent / Obsidian / 另一个窗口)',
  'editor.reload': '重新载入',
  'editor.overwrite': '用我的覆盖',
  'editor.chars': '{n} 字符',
  'editor.bold': '粗体',
  'editor.italic': '斜体',
  'editor.highlight': '高亮 ==…==',
  'editor.heading': '二级标题',
  'editor.list': '列表',
  'editor.quote': '引用',
  'editor.code': '行内代码',
  'editor.image': '插入图片',
  'editor.idRestored': '已恢复 dsh-note-id(身份标识不能丢:改名/移动时靠它认人)',
  'editor.saveNow': '立即保存(Ctrl/Cmd+S)',
  'editor.previewMode': '切到源码模式(看到原始 markdown)',
  'editor.sourceMode': '切回预览模式(隐藏标记)',
  'editor.modeSourceShort': '源码',
  'editor.modePreviewShort': '预览',
  'editor.undo': '撤销(Ctrl/Cmd+Z)',
  'editor.redo': '重做(Ctrl/Cmd+Shift+Z)',
  'editor.headingMenu': '标题级别',
  'editor.bodyText': '正文',
  'editor.strike': '删除线 ~~…~~',
  'editor.orderedList': '有序列表',
  'editor.taskList': '任务列表 - [ ]',
  'editor.indent': '增加缩进',
  'editor.outdent': '减少缩进',
  'editor.codeBlock': '代码块 ```',
  'editor.hr': '分隔线 ---',
  'editor.link': '插入链接',
  'editor.linkText': '链接文字(留空则用选中文本)',
  'editor.linkUrl': '网址 URL(可留空稍后填)',
  'editor.table': '插入表格',
  'editor.tableHint': '拖动选择行 × 列',
  'editor.tableSize': '{r} 行 × {c} 列',
  'editor.math': '插入公式',
  'editor.mathTex': 'TeX 代码,如 a^2+b^2=c^2',
  'editor.mathInline': '行内公式',
  'editor.mathBlock': '块级公式',
  'editor.wikiLink': '双链 [[笔记标题]]',
  'editor.confirm': '插入',
  'editor.cancel': '取消',
  'tree.into': '归入',
  'tree.before': '插到',
  'tree.after': '插到',
  'tree.topLevel': '放到顶层',
  'panel.files': '文件',
  'panel.outline': '大纲',
  'outline.empty': '这篇笔记还没有标题。写一行 `# 标题` 就会出现在这里。',
  'outline.jump': '跳到第 {n} 行',
  'menu.pin': '置顶',
  'menu.rename': '重命名',
  'menu.unpin': '取消置顶',
  'menu.copyPath': '复制完整路径',
  'menu.reveal': '在文件树中定位',
  'menu.newNoteHere': '在此新建笔记',
  'menu.newSubCollection': '在此新建子分类',
  'menu.newNote': '新建笔记',
  'menu.newCollection': '新建分类',
  'menu.unregister': '移出笔记树(不删文件)',
  'menu.trash': '删除(移入回收站)',
  'trash.title': '回收站',
  'trash.hint': '删除的笔记先放这里,随时可以恢复;只有「彻底删除」才会真的从磁盘移除。',
  'trash.root': '位置:{p}',
  'trash.empty': '回收站是空的。',
  'trash.loading': '读取中…',
  'trash.restore': '恢复',
  'trash.purge': '彻底删除',
  'trash.purgeAll': '清空回收站',
  'trash.close': '关闭',
  'trash.missing': '(文件已不在)',
  'trash.confirm': '确定彻底删除吗?',
  'action.trash': '回收站',
  'status.trashed': '已移入回收站:{p}(可在回收站恢复)',
  'status.restored': '已恢复到 {p}',
  'status.purged': '已彻底删除 {n} 项',
  'status.purgeAllHint': '再点一次「清空回收站」确认彻底删除 {n} 项',
  'status.pinned': '已置顶',
  'status.unpinned': '已取消置顶',
  'status.unregistered': '已移出笔记树(文件还在)',
  'status.pathCopied': '路径已复制:{p}',
  'status.copyFailed': '复制失败(浏览器没给剪贴板权限)',
  'status.revealHint': '已复制 {p} —— 粘到「文件」页即可定位(客户端没有切换官方文件页的接口)',
  'status.imported': '已导入 {n} 篇笔记',
  'status.importSkipped': '只支持 .md 文件',
  'status.dismiss': '关闭提示',
}

const EN: Record<string, string> = {
  'tab.title': 'Notes',
  'tab.guide': 'Open the notes area: a notes tree (collections / unfiled) beside a Markdown editor.',
  'tree.collapse': 'Collapse notes tree',
  'tree.expand': 'Expand notes tree',
  'tree.resize': 'Drag to resize the notes tree',
  'tree.title': 'Notes tree',
  'tree.loading': 'Loading…',
  'tree.summary': '{n} notes · {c} collections',
  'tree.empty': 'No notes in this workspace yet. Use + in the header, or have the agent write a .md and register it.',
  'tree.hint': '“Unfiled files” are .md under the notes root that are not in the tree yet — click one to file it.',
  'notesdir.title': 'This workspace has no {p}/ yet',
  'notesdir.hint': 'Notes live in {p}/ by default. Create it, or point the notes root at an existing folder (e.g. docs) — we only create, never touch existing files.',
  'notesdir.create': 'Create {p}/',
  'notesdir.apply': 'Use as notes root',
  'notesdir.useExisting': 'Use an existing folder (workspace-relative, e.g. docs)',
  'notesdir.later': 'Not now',
  'status.notesDirCreated': 'Created {p}',
  'status.notesRootSet': 'Notes root set to {p}',
  'tabs.close': 'Close tab (middle-click works too)',
  'tabs.quickOpen': 'Quick open (Ctrl/Cmd+P)',
  'tabs.splitRight': 'Split right (or drag the tab over)',
  'tabs.moveLeft': 'Move to left pane',
  'tabs.closeSplit': 'Close split (tabs merge into the left pane)',
  'tabs.mergeShort': 'Merge',
  'ws.switch': 'Switch workspace (the notes pane can look at another registered workspace)',
  'ws.sessionWorkspace': 'Session workspace',
  'ws.sessionTag': 'this session',
  'ws.openPath': 'Open another folder (absolute path, Enter)',
  'ws.backToSession': 'Back to the session workspace',
  'status.workspaceOpened': 'Opened workspace: {p}',
  'tree.unfiled': 'Not filed',
  'tree.unfiledHint': 'Opens the intake manager: candidates (unmarked) and ignored files, with search, multi-select and bulk actions',
  'tree.ignoredBadge': 'ignored {n}',
  'menu.unregisterIgnore': 'Remove and ignore',
  'action.files': 'Intake manager (md not filed yet)',
  'files.title': 'Intake manager',
  'files.close': 'Close',
  'files.stats': 'notes {notes} · candidates {candidates} · ignored {ignored} · workspace md {total}',
  'files.search': 'Search path or file name…',
  'files.seg.recent': 'Recent',
  'files.seg.folders': 'By folder',
  'files.seg.ignored': 'Ignored',
  'files.loading': 'Scanning the workspace…',
  'files.empty': 'No unfiled md',
  'files.emptyIgnored': 'Nothing ignored',
  'files.rootFolder': '(workspace root)',
  'files.more': '{n} more…',
  'files.rules': 'Bulk ignore rules',
  'files.dropRule': 'Drop rule',
  'files.picked': '{n} selected',
  'files.include': 'File it',
  'files.ignore': 'Ignore',
  'files.restore': 'Back to candidates',
  'files.hint': 'Select rows to file or ignore in bulk; ignoring only marks, never deletes',
  'files.hintIgnored': 'Select rows to put them back into candidates',
  'files.truncated': 'Too many files — truncated',
  'files.scope': 'Scan scope',
  'files.addRoot': 'Add folder (Enter)…',
  'files.dropRoot': 'Stop scanning this folder',
  'files.wholeWorkspace': 'Whole workspace',
  'files.wholeHint': 'Scan the whole workspace: slow with many folders (~0.3s per folder here); runs in chunks',
  'files.scanning': 'Scanning: {dirs} folders · {files} md…',
  'files.back': 'Back',
  'files.badge': 'has id',
  'files.hadId': 'Already carries a dsh-note-id: filing reuses it, so renames/moves stay recognisable',
  'status.included': 'Filed {n} note(s)',
  'status.includedSome': 'Filed {n}, {m} failed',
  'status.ignored': 'Marked {n} as ignored (restore from the Ignored tab)',
  'status.unignored': 'Put {n} back into candidates',
  'status.unregisteredIgnored': '“{p}” removed from notes and ignored',
  'tree.collectionHint': 'Collection (collapsible; drop a note or collection on it)',
  'tree.refHint': 'From another workspace: {name} (a mapping, not a copy)',
  'action.newNote': 'New note',
  'action.newCollection': 'New collection',
  'action.rescan': 'Rescan (rebuild the mapping from dsh-note-id)',
  'compose.note': 'Note title, Enter to create',
  'compose.collection': 'Collection name, Enter to create',
  'compose.ok': 'OK',
  'status.wikiMissing': 'No such note (nothing created)',
  'status.created': 'Created and registered',
  'status.untitled': 'Untitled',
  'status.newCollection': 'New collection',
  'status.collectionCreated': 'Collection created',
  'status.registered': 'Added to the notes tree',
  'status.moved': 'Moved',
  'status.rescanned': 'Rescanned',
  'status.rescanReport': 'Scan done: {scanned} md · rebound {rebound} · removed {dropped} · unfiled {unfiled}',
  'status.rescanTruncated': '(truncated: too many files)',
  'status.noSession': 'No session context — cannot resolve a workspace',
  'tree.into': 'Into',
  'tree.before': 'Before',
  'tree.after': 'After',
  'tree.topLevel': 'To top level',
  'menu.pin': 'Pin',
  'menu.rename': 'Rename',
  'menu.unpin': 'Unpin',
  'menu.copyPath': 'Copy full path',
  'menu.reveal': 'Reveal in file tree',
  'menu.newNoteHere': 'New note here',
  'menu.newSubCollection': 'New sub-collection',
  'menu.newNote': 'New note',
  'menu.newCollection': 'New collection',
  'menu.unregister': 'Remove from notes tree (keeps the file)',
  'menu.trash': 'Delete (move to trash)',
  'trash.title': 'Trash',
  'trash.hint': 'Deleted notes land here first and can be restored; only “Delete forever” removes them from disk.',
  'trash.root': 'Location: {p}',
  'trash.empty': 'Trash is empty.',
  'trash.loading': 'Loading…',
  'trash.restore': 'Restore',
  'trash.purge': 'Delete forever',
  'trash.purgeAll': 'Empty trash',
  'trash.close': 'Close',
  'trash.missing': '(file is gone)',
  'trash.confirm': 'Delete forever?',
  'action.trash': 'Trash',
  'status.trashed': 'Moved to trash: {p} (restorable)',
  'status.restored': 'Restored to {p}',
  'status.purged': 'Deleted {n} item(s) forever',
  'status.purgeAllHint': 'Click “Empty trash” again to permanently delete {n} item(s)',
  'status.pinned': 'Pinned',
  'status.unpinned': 'Unpinned',
  'status.unregistered': 'Removed from the notes tree (file kept)',
  'status.pathCopied': 'Path copied: {p}',
  'status.copyFailed': 'Copy failed (no clipboard permission)',
  'status.revealHint': 'Copied {p} — paste it in the Files tab to locate it (no public API to switch that tab)',
  'status.imported': 'Imported {n} note(s)',
  'status.importSkipped': 'Only .md files are supported',
  'status.dismiss': 'Dismiss',
  'editor.pending': 'The editor arrives in P2 (CodeMirror 6); for now this shows the selected note path.',
  'editor.noSelection': 'Pick a note on the left.',
  'editor.refFrom': 'From another workspace: {name} (a mapping, not a copy)',
  'editor.loading': 'Loading…',
  'editor.saving': 'Saving…',
  'editor.dirty': 'Unsaved',
  'editor.saved': 'Saved',
  'editor.saveFailed': 'Save failed',
  'editor.loadFailed': 'Could not open this note.',
  'editor.conflict': 'The file changed outside this editor (agent / Obsidian / another window)',
  'editor.reload': 'Reload',
  'editor.overwrite': 'Overwrite with mine',
  'editor.chars': '{n} chars',
  'editor.bold': 'Bold',
  'editor.italic': 'Italic',
  'editor.highlight': 'Highlight ==…==',
  'editor.heading': 'Heading 2',
  'editor.list': 'List',
  'editor.quote': 'Quote',
  'editor.code': 'Inline code',
  'editor.image': 'Insert image',
  'editor.idRestored': 'Restored dsh-note-id (the note identity must survive renames/moves)',
  'editor.saveNow': 'Save now (Ctrl/Cmd+S)',
  'editor.previewMode': 'Switch to source mode (raw markdown)',
  'editor.sourceMode': 'Back to preview mode (markers hidden)',
  'editor.modeSourceShort': 'Source',
  'editor.modePreviewShort': 'Preview',
  'editor.undo': 'Undo (Ctrl/Cmd+Z)',
  'editor.redo': 'Redo (Ctrl/Cmd+Shift+Z)',
  'editor.headingMenu': 'Heading level',
  'editor.bodyText': 'Body text',
  'editor.strike': 'Strikethrough ~~…~~',
  'editor.orderedList': 'Ordered list',
  'editor.taskList': 'Task list - [ ]',
  'editor.indent': 'Increase indent',
  'editor.outdent': 'Decrease indent',
  'editor.codeBlock': 'Code block ```',
  'editor.hr': 'Horizontal rule ---',
  'editor.link': 'Insert link',
  'editor.linkText': 'Link text (empty = selection)',
  'editor.linkUrl': 'URL (may stay empty)',
  'editor.table': 'Insert table',
  'editor.tableHint': 'Drag to pick rows × columns',
  'editor.tableSize': '{r} rows × {c} columns',
  'editor.math': 'Insert math',
  'editor.mathTex': 'TeX source, e.g. a^2+b^2=c^2',
  'editor.mathInline': 'Inline math',
  'editor.mathBlock': 'Block math',
  'editor.wikiLink': 'Wiki link [[note title]]',
  'editor.confirm': 'Insert',
  'editor.cancel': 'Cancel',
  'panel.files': 'Files',
  'panel.outline': 'Outline',
  'outline.empty': 'No headings in this note yet. Write a `# heading` line to see it here.',
  'outline.jump': 'Jump to line {n}',
}

/**
 * 装载客户端插件。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: any): void {
  ctx.effect(
    () => ctx.locale.register(NS, { zh: ZH, en: EN }),
    'dsh-notes: dictionaries',
  )

  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const tag = document.createElement('style')
    tag.dataset.plugin = PKG
    tag.textContent = CSS
    document.head.appendChild(tag)
    return () => {
      if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
    }
  }, 'dsh-notes: styles')

  const t = ctx.locale.bind(NS)

  // 1) tab 类型:纯页面类型(按 kind 打开),并在 guide 页留一枚入口胶囊。
  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        title: () => t('tab.title'),
        guide: [
          {
            id: PKG,
            order: 40,
            title: () => t('tab.title'),
            description: () => t('tab.guide'),
            icon: IconNote,
          },
        ],
      }),
    'dsh-notes: tab type',
  )

  // 2) 侧栏标签(chip)的内容:往 `sidebar.right.pane.tab.title` 注册,渲染「图标 + 标题」。
  //    官方 tab 定义里**没有** icon 字段,chip 的文字/图标都由这个座位提供
  //    (参考 @deepseek-ai/dsh-client-ui-schedule 的做法);座位按 session 作用域,
  //    并注入 `useTabInfo` 让我们能拿到当前 tab 的标题。
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab.title', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: ID, locale: NS }, NotesChipTitle as any),
      ),
    'dsh-notes: tab chip title',
  )

  // 3) tab 面板体:键必须是 tab 定义里的 id。
  //    外面再套一层错误边界:宿主插槽渲染失败时只会留一个空 div(实测踩到),
  //    空白面板极难排查;这里把错误直接画出来(平时正常渲染时零开销)。
  ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register(
      {
        name: 'sidebar.right.pane.tab',
        key: ID,
        locale: NS,
      },
      NotesPaneWithBoundary as any,
    ),
  )
}

/** 只声明本插件真正读取的服务(硬依赖可选服务会在他处禁用该服务时拖垮整个 GUI)。 */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * 侧栏标签(chip)的内容:一个音符图标 + 当前 tab 的标题。
 *
 * props 由座位注入:`useTabInfo()` 给出当前 tab 记录(标题在里面),`t` 是本地化函数。
 * @param props - 座位注入的 props。
 */
function NotesChipTitle(props: { useTabInfo: () => { tab: { title: string } }; t: (key: string) => string }): React.ReactElement {
  const { tab } = props.useTabInfo()
  return (
    <span className="dsh-notes-chip">
      <IconNote size={16} />
      <span>{tab?.title ?? props.t('tab.title')}</span>
    </span>
  )
}

/**
 * 面板 = NotesPane 外面套一层错误边界。
 *
 * 注意:注册的必须是**带 children 的包装组件** —— 直接把边界类注册上去的话
 * children 是空的,面板什么都不渲染(实测踩到:整个笔记区域空白)。
 */
function NotesPaneWithBoundary(props: Record<string, unknown>): React.ReactElement {
  return (
    <PaneBoundary>
      <NotesPane {...(props as never)} />
    </PaneBoundary>
  )
}

/**
 * 笔记面板的渲染兜底。
 *
 * 宿主插槽在渲染抛错时只留一个空 div(`data-slot-error`),界面上看不到任何信息。
 * 这一层把错误的栈直接画出来,顺带把上下文写进 console,免得再出现"面板莫名空白"。
 */
class PaneBoundary extends React.Component<{ children?: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error): void {
    // eslint-disable-next-line no-console
    console.error('[dsh-notes] 面板渲染失败', error)
  }

  render(): React.ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="dsh-notes-root">
          <div className="dsh-notes-header">
            <span className="dsh-notes-title">dsh-notes 渲染失败</span>
          </div>
          <pre className="dsh-notes-crash">{String(this.state.error?.stack ?? this.state.error)}</pre>
        </div>
      )
    }
    return this.props.children
  }
}
