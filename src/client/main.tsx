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
  'p0.notice': '骨架',
  'tree.collapse': '收起笔记树',
  'tree.expand': '展开笔记树',
  'tree.resize': '拖动调整笔记树宽度',
  'tree.pending': '笔记树将在 P1 接入(索引与工作区绑定)。',
  'editor.pending': '编辑器将在 P2 接入(CodeMirror 6)。',
}

const EN: Record<string, string> = {
  'tab.title': 'Notes',
  'tab.guide': 'Open the notes area: a notes tree (collections / unfiled) beside a Markdown editor.',
  'p0.notice': 'skeleton',
  'tree.collapse': 'Collapse notes tree',
  'tree.expand': 'Expand notes tree',
  'tree.resize': 'Drag to resize the notes tree',
  'tree.pending': 'The notes tree arrives in P1 (index + workspace binding).',
  'editor.pending': 'The editor arrives in P2 (CodeMirror 6).',
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
