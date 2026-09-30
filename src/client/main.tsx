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

import { NotesPane } from './NotesPane'
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
  'tree.unfiled': '未归类文件',
  'tree.unfiledHint': '笔记根下存在、还没纳入笔记树的 md(点一下纳入)',
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
  'editor.saveNow': '立即保存(Ctrl/Cmd+S)',
  'editor.previewMode': '切到源码模式(看到原始 markdown)',
  'editor.sourceMode': '切回预览模式(隐藏标记)',
  'editor.modeSourceShort': '源码',
  'editor.modePreviewShort': '预览',
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
  'tree.unfiled': 'Unfiled files',
  'tree.unfiledHint': '.md under the notes root that is not in the tree yet (click to file it)',
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
  'editor.saveNow': 'Save now (Ctrl/Cmd+S)',
  'editor.previewMode': 'Switch to source mode (raw markdown)',
  'editor.sourceMode': 'Back to preview mode (markers hidden)',
  'editor.modeSourceShort': 'Source',
  'editor.modePreviewShort': 'Preview',
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
          },
        ],
      }),
    'dsh-notes: tab type',
  )

  // 2) tab 面板体:键必须是 tab 定义里的 id。
  ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register(
      {
        name: 'sidebar.right.pane.tab',
        key: ID,
        locale: NS,
      },
      NotesPane as any,
    ),
  )
}

/** 只声明本插件真正读取的服务(硬依赖可选服务会在他处禁用该服务时拖垮整个 GUI)。 */
export const inject = ['slots', 'locale', 'sidebarRightTabs']
