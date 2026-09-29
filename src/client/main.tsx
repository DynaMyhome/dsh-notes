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
  'tree.into': '归入',
  'tree.before': '插到',
  'tree.after': '插到',
  'tree.topLevel': '放到顶层',
  'panel.files': '文件',
  'panel.outline': '大纲',
  'outline.empty': '这篇笔记还没有标题。写一行 `# 标题` 就会出现在这里。',
  'outline.jump': '跳到第 {n} 行',
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
  'status.created': 'Created and registered',
  'status.collectionCreated': 'Collection created',
  'status.registered': 'Added to the notes tree',
  'status.moved': 'Moved',
  'status.rescanned': 'Rescanned',
  'status.noSession': 'No session context — cannot resolve a workspace',
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
