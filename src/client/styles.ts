/**
 * dsh-notes 客户端样式。
 *
 * 只用官方主题 token(`--dsw-alias-*` / `--dsw-specific-sidebar-fill`),
 * 不写死颜色 —— 明暗主题跟随宿主。
 *
 * ## 字号与缩放(改字号相关的东西前先读这段)
 *
 * 笔记区的尺寸由**两个变量**合成,都落在 `.dsh-notes-root` 上:
 *
 * - `--dsh-notes-scale` —— 本区微调系数(0.85–1.5,默认 1;由 React 用行内 style 写,
 *   见 NotesPane + src/client/scale.ts)。侧栏比正文密,有人要它更紧凑或更松。
 * - `--dsh-content-font-delta` —— 宿主的**全局「字体大小」增量**
 *   (`calc(--dsh-content-font-size - 14px)`,ui-theme 写在 `body` 上,默认 0px)。
 *   加上它,「设置 → 通用 → 字体大小」一动笔记区就跟着变大变小,不用再调一次。
 *
 * 凡是会被字号带动的长度都写成 `sc(设计值px)`(`calc(Npx × 系数 + 增量)`)。
 * **不要改成 em**:em 会逐层相乘(父级设了字号,子级再设一次就叠),
 * 而这里每个尺寸都要彼此独立、且在「系数 1 + 增量 0」时与改动前逐像素一致。
 *
 * `sc()` 只用在文字度量上(字号、承载文字的高度/最小宽度、会被字撑开的宽度上限、
 * 图标旁的分隔条)。**边框/hairline、圆角、padding、gap、阴影、浮层尺寸与
 * `position:fixed` 浮层的 JS 坐标保持 px** —— 那些是观感骨架,不跟着字走;
 * 也正因为浮层坐标是 JS 按视口 px 算的,这里**不能用 `zoom`/`transform:scale`**
 * (会把右键菜单、工作区菜单、拖拽跟随块整体推偏)。
 */

import { cssSize as sc } from './scale'

export const CSS = [
  /* 外壳 */
  `.dsh-notes-root{--dsh-notes-scale:1;position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:${sc(13)}}`,
  `.dsh-notes-header{display:flex;align-items:center;gap:4px;flex:0 0 auto;height:${sc(30)};padding:0 8px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill)}`,
  `.dsh-notes-title{font-size:${sc(12)};font-weight:600;white-space:nowrap}`,
  `.dsh-notes-sub{font-size:${sc(11)};color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`,
  '.dsh-notes-spacer{flex:1 1 auto}',
  // 按钮:无描边,hover 才浮一层底色(与 DSH 自身控件同款观感)
  `.dsh-notes-btn{appearance:none;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:2px 6px;font:inherit;font-size:${sc(13)};line-height:1.5;cursor:pointer;white-space:nowrap;transition:background .12s ease,color .12s ease,opacity .12s ease}`,
  '.dsh-notes-btn:hover:not([disabled]){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}',
  '.dsh-notes-btn:active:not([disabled]){background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2))}',
  '.dsh-notes-btn[disabled]{opacity:.4;cursor:default}',
  // 分段按钮组(工具栏用):首尾圆角 + 组内 hairline,比"每个按钮各自带框"干净
  '.dsh-notes-seg{display:inline-flex;align-items:center;gap:0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:1px;background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 55%, transparent)}',
  '.dsh-notes-seg>.dsh-notes-btn{border-radius:6px}',
  '.dsh-notes-seg>.dsh-notes-btn+.dsh-notes-btn{margin-left:1px}',
  '.dsh-notes-body{display:flex;flex:1 1 auto;min-height:0}',

  /* 树列 */
  '.dsh-notes-tree{flex:0 0 auto;min-width:0;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-specific-sidebar-fill);border-right:1px solid var(--dsw-alias-border-l1)}',
  '.dsh-notes-tree-inner{display:flex;flex-direction:column;min-height:0;flex:1 1 auto}',
  `.dsh-notes-tree-head{display:flex;align-items:center;gap:4px;flex:0 0 auto;min-height:${sc(30)};padding:0 6px 0 8px;font-size:${sc(12)};color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1)}`,
  '.dsh-notes-tree-title{font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-notes-tree-body{flex:1 1 auto;min-height:0;overflow:auto;padding:3px 0}',
  `.dsh-notes-row{display:flex;align-items:center;gap:4px;height:${sc(26)};padding-right:6px;font-size:${sc(13)};cursor:pointer;white-space:nowrap;user-select:none}`,
  '.dsh-notes-row:hover{background:var(--dsw-alias-bg-layer-2)}',
  '.dsh-notes-row-selected{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}',
  '.dsh-notes-row-ref .dsh-notes-row-label{color:var(--dsw-alias-label-secondary)}',
  /* 分类 vs 笔记:一眼可分 —— 分类加粗带文件夹;笔记常规字重、次要色 */
  '.dsh-notes-row-collection .dsh-notes-row-label{font-weight:600;color:var(--dsw-alias-label-primary)}',
  '.dsh-notes-row-note .dsh-notes-row-label,.dsh-notes-row-unfiled .dsh-notes-row-label{color:var(--dsw-alias-label-secondary)}',
  '.dsh-notes-row-note.dsh-notes-row-selected .dsh-notes-row-label{color:var(--dsw-alias-label-primary)}',
  '.dsh-notes-row-drop{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}',
  /* 拖放指示:插入线(上/下)/ 容器高亮(内部)/ 拖动源淡出 / 跟随光标的层级标签 */
  '.dsh-notes-row-ins-before{box-shadow:inset 0 2px 0 0 var(--dsw-alias-brand-primary)}',
  '.dsh-notes-row-ins-after{box-shadow:inset 0 -2px 0 0 var(--dsw-alias-brand-primary)}',
  '.dsh-notes-row-ins-inside{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary);border-radius:5px}',
  '.dsh-notes-row-dragging{opacity:.45}',
  `.dsh-notes-drop-chip{position:fixed;z-index:40;pointer-events:none;max-width:${sc(340)};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 9px;border-radius:999px;font-size:${sc(11)};line-height:1.7;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 6px 18px rgba(0,0,0,.2)}`,
  '.dsh-notes-tree-body-dragging{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 4%, transparent)}',
  /* 拖动中把所有"可以放进去"的容器标出来,不然只有悬停到才知道哪儿能放 */
  '.dsh-notes-tree-body-dragging .dsh-notes-row-collection{box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2);border-radius:5px}',
  '.dsh-notes-drop-line{height:2px;margin:3px 8px;border-radius:2px;background:var(--dsw-alias-brand-primary)}',
  '.dsh-notes-drop-root{box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}',
  `.dsh-notes-glyph{flex:0 0 auto;font-size:${sc(11)};line-height:1;opacity:.9}`,
  `.dsh-notes-caret{flex:0 0 auto;width:${sc(12)};font-size:${sc(11)};color:var(--dsw-alias-label-secondary);text-align:center}`,
  '.dsh-notes-row-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}',
  `.dsh-notes-count{flex:0 0 auto;font-size:${sc(11)};color:var(--dsw-alias-label-secondary)}`,
  `.dsh-notes-badge{flex:0 0 auto;max-width:${sc(120)};overflow:hidden;text-overflow:ellipsis;font-size:${sc(11)};padding:0 5px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;color:var(--dsw-alias-label-secondary)}`,
  `.dsh-notes-hint{padding:7px 10px;font-size:${sc(12)};line-height:1.6;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1)}`,

  /* 输入条 / 状态 */
  '.dsh-notes-compose{display:flex;align-items:center;gap:4px;padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
  `.dsh-notes-input{flex:1 1 auto;min-width:0;box-sizing:border-box;padding:3px 7px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:${sc(13)}}`,
  '.dsh-notes-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
  /* 状态提示:浮层 toast —— 之前它插在正常流里,出现/消失会把下面的内容整体顶一下(用户看到"一闪一闪") */
  `.dsh-notes-status{position:absolute;top:${sc(34)};left:50%;transform:translateX(-50%);z-index:50;pointer-events:none;max-width:80%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 10px;border-radius:999px;font-size:${sc(11)};color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 6px 18px rgba(0,0,0,.18);animation:dsh-notes-status-fade 2.4s forwards}`,
  '@keyframes dsh-notes-status-fade{0%,70%{opacity:1}100%{opacity:0}}',
  `.dsh-notes-error{display:flex;align-items:flex-start;gap:6px;padding:4px 6px 4px 10px;font-size:${sc(11)};line-height:1.6;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}`,
  '.dsh-notes-error-text{flex:1 1 auto;min-width:0}',
  `.dsh-notes-error-close{flex:0 0 auto;appearance:none;border:none;background:transparent;color:inherit;font:inherit;font-size:${sc(13)};line-height:1;padding:0 4px;cursor:pointer;opacity:.7}`,
  '.dsh-notes-error-close:hover{opacity:1}',
  /* 浮层材质(用户审计:模态面板只有 60% 不透明,背后正文穿透可读)。
     本主题(open-sea-skin)把所有 `--dsw-alias-bg-*` 都做成了半透明,所以**不能**只拿
     `bg-base` 当浮层底色;宿主自己的菜单/对话框用的是 `--dsw-specific-menu` +
     `backdrop-filter: var(--dsw-menu-backdrop-filter)`(本机实测 `blur(40px) saturate(150%)`)。
     这里照抄同一套:跟随主题 token(不写死颜色)且背后内容变成不可读的模糊。
     浮层尺寸与 `position:fixed` 的 JS 坐标仍是 px,不受影响。 */
  '.dsh-notes-panel,.dsh-notes-context,.dsh-notes-submenu,.dsh-notes-wsmenu,.dsh-notes-popover,.dsh-notes-drop-chip,.dsh-notes-status{background:var(--dsw-specific-menu, var(--dsw-alias-bg-overlay));backdrop-filter:var(--dsw-menu-backdrop-filter, blur(24px) saturate(140%));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter, blur(24px) saturate(140%))}',
  /* 右键菜单 */

  /* 左列标签页(文件 / 大纲)+ 大纲 */
  '.dsh-notes-column{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;min-width:0}',
  '.dsh-notes-panel-tabs{display:flex;align-items:center;gap:2px;flex:0 0 auto;padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
  // 分段控件:整组一个浅底胶囊,选中项浮起来(现代分段的做法)
  '.dsh-notes-panel-segments{flex:0 0 auto;display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
  `.dsh-notes-panel-tab{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:${sc(12)};line-height:1.6;padding:2px 10px;border-radius:7px;cursor:pointer;transition:background .12s ease,color .12s ease}`,
  '.dsh-notes-panel-tab:hover{color:var(--dsw-alias-label-primary)}',
  '.dsh-notes-panel-tab-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}',
  '.dsh-notes-outline{flex:1 1 auto;min-height:0;overflow:auto;padding:4px 0}',
  `.dsh-notes-outline-row{display:flex;align-items:center;gap:6px;height:${sc(24)};padding-right:8px;font-size:${sc(12.5)};color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;user-select:none}`,
  '.dsh-notes-outline-row:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
  '.dsh-notes-outline-active{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}',
  '.dsh-notes-outline-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}',
  `.dsh-notes-outline-h{flex:0 0 auto;font-size:${sc(9.5)};letter-spacing:.02em;color:var(--dsw-alias-label-secondary);opacity:.7}`,
  '.dsh-notes-outline-h1{color:var(--dsw-alias-brand-primary);opacity:1}',
  '.dsh-notes-outline-h2{opacity:.92}',
  '.dsh-notes-outline-h3{opacity:.8}',

  /* 分隔条 / 收起条 */
  '.dsh-notes-resizer{flex:0 0 auto;width:4px;cursor:col-resize;background:transparent}',
  '.dsh-notes-resizer:hover{background:var(--dsw-alias-border-l2)}',
  `.dsh-notes-rail{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:4px;width:${sc(30)};padding:4px 0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill)}`,
  `.dsh-notes-rail .dsh-notes-btn{min-width:${sc(24)};padding:3px 0;font-size:${sc(17)};line-height:1;text-align:center}`,
  '.dsh-notes-toolbar{display:flex;align-items:center;gap:2px;flex:0 0 auto}',
  `.dsh-notes-toolbar .dsh-notes-btn{min-width:${sc(24)};padding:2px 0;font-size:${sc(16)};line-height:1.2;text-align:center}`,

  /* 分栏 + 标签栏(P6) */
  '.dsh-notes-area{flex:1 1 auto;min-width:0;min-height:0;display:flex}',
  '.dsh-notes-pane{flex:1 1 0;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
  '.dsh-notes-area-split .dsh-notes-pane+.dsh-notes-pane{border-left:1px solid var(--dsw-alias-border-l2)}',
  '.dsh-notes-pane-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
  '.dsh-notes-tabpage{flex:1 1 auto;min-height:0;flex-direction:column}',
  '.dsh-notes-tabstrip{flex:0 0 auto;display:flex;align-items:center;gap:2px;padding:2px 4px;overflow-x:auto;overflow-y:hidden;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill);scrollbar-width:thin}',
  '.dsh-notes-tab-drop{flex:0 0 auto;align-self:stretch;width:2px;margin:2px 1px;border-radius:1px;background:var(--dsw-alias-brand-primary)}',
  '.dsh-notes-pane-drop{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent)}',
  '.dsh-notes-tabstrip-on{background:var(--dsw-alias-bg-layer-1)}',
  `.dsh-notes-tabstrip .dsh-notes-btn{flex:0 0 auto;min-width:${sc(20)};padding:1px 4px;font-size:${sc(12)}}`,
  `.dsh-notes-tab{flex:0 0 auto;display:flex;align-items:center;gap:3px;max-width:${sc(150)};padding:1px 4px 1px 7px;border:1px solid transparent;border-radius:5px;font-size:${sc(11.5)};color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}`,
  '.dsh-notes-tab:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
  '.dsh-notes-tab-on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-weight:600}',
  '.dsh-notes-tab-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  `.dsh-notes-tab-badge{font-size:${sc(10)};opacity:.7}`,
  `.dsh-notes-tab-close{appearance:none;border:none;background:transparent;color:inherit;font:inherit;font-size:${sc(12)};line-height:1;padding:0 2px;border-radius:3px;cursor:pointer;opacity:.55}`,
  '.dsh-notes-tab-close:hover{opacity:1;background:var(--dsw-alias-bg-layer-1)}',
  /* 纳入管理面板(候选/杂项) */
  '.dsh-notes-missing{flex:0 0 auto;display:flex;flex-direction:column;gap:6px;margin:6px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
  `.dsh-notes-missing-title{font-size:${sc(12.5)};font-weight:600}`,
  '.dsh-notes-missing-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap}',
  `.dsh-notes-missing .dsh-notes-input{font-size:${sc(11)}}`,
  /* 右键菜单 */
  // 弹层风格对齐 dsh-token-usage 的小悬浮框:
  // bg-layer-2 + border-l2 + 圆角 8 + 0 6px 20px rgba(0,0,0,.22) + 11~12px 字号
  '.dsh-notes-context{position:fixed;z-index:80;min-width:196px;max-width:320px;padding:5px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 6px 20px rgba(0,0,0,.22)}',
  '.dsh-notes-menu{display:flex;flex-direction:column;min-width:0}',
  '.dsh-notes-menu-row{position:relative}',
  `.dsh-notes-menu-item{display:flex;align-items:center;gap:10px;width:100%;appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:${sc(12)};line-height:1.65;text-align:left;padding:5px 9px;border-radius:6px;cursor:pointer;transition:background .12s ease}`,
  // 悬停底色用 label 的 8% 混合:菜单底已经是 layer-2,直接用 layer-2 会看不见
  '.dsh-notes-menu-item:hover:not([disabled]){background:color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent)}',
  '.dsh-notes-menu-item[disabled]{opacity:.45;cursor:default}',
  '.dsh-notes-menu-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  `.dsh-notes-menu-key{flex:0 0 auto;font-size:${sc(11)};color:var(--dsw-alias-label-secondary)}`,
  '.dsh-notes-menu-arrow{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}',
  '.dsh-notes-menu-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1)}',
  '.dsh-notes-submenu{position:absolute;left:100%;top:-6px;margin-left:4px;z-index:81;min-width:186px;max-height:min(70vh,420px);overflow:auto;padding:5px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 6px 20px rgba(0,0,0,.22)}',
  // 悬停桥:父项与子菜单之间那 4px 也算子菜单的命中区,指针跨缝不会"掉落"
  '.dsh-notes-submenu::before{content:"";position:absolute;left:-6px;top:0;bottom:0;width:6px}',
  '.dsh-notes-chip{display:inline-flex;align-items:center;gap:6px;min-width:0}',
  '.dsh-notes-chip>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  `.dsh-notes-ws{appearance:none;border:none;background:transparent;color:inherit;font:inherit;font-size:${sc(11)};padding:0 2px;margin-right:4px;cursor:pointer;border-radius:4px;max-width:${sc(150)};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
  '.dsh-notes-ws:hover{background:var(--dsw-alias-bg-layer-2)}',
  `.dsh-notes-wsmenu{position:absolute;z-index:60;top:${sc(29)};left:8px;min-width:260px;max-height:60%;overflow:auto;display:flex;flex-direction:column;padding:4px 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 30px rgba(0,0,0,.28)}`,
  `.dsh-notes-wsmenu-item{display:flex;align-items:center;gap:8px;width:100%;appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:${sc(12)};text-align:left;padding:5px 10px;cursor:pointer}`,
  '.dsh-notes-wsmenu-item:hover{background:var(--dsw-alias-bg-layer-2)}',
  '.dsh-notes-wsmenu-on{font-weight:600}',
  '.dsh-notes-wsmenu-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-notes-wsmenu-add{padding:4px 8px;border-top:1px solid var(--dsw-alias-border-l1)}',
  `.dsh-notes-panel-overlay{position:absolute;inset:0;z-index:70;display:flex;align-items:flex-start;justify-content:center;padding-top:${sc(34)};background:color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent)}`,
  // 面板风格对齐 dsh-token-usage 的大面板:
  // bg-base + border-l1 + 圆角 14 + 0 18px 60px rgba(0,0,0,.32)
  '.dsh-notes-panel{width:96%;max-width:760px;height:80%;display:flex;flex-direction:column;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);box-shadow:0 18px 60px rgba(0,0,0,.32);overflow:hidden}',
  `.dsh-notes-panel .dsh-notes-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:4px 10px;font-size:${sc(12)}}`,
  '.dsh-notes-panel .dsh-notes-btn:hover:not([disabled]){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}',
  `.dsh-notes-panel-sm{max-width:520px;height:auto;max-height:72%;margin-top:${sc(34)}}`,
  `.dsh-notes-panel-note{flex:0 0 auto;padding:6px 10px;font-size:${sc(11)};line-height:1.6;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1)}`,
  '.dsh-notes-panel-pad{padding:10px}',
  '.dsh-notes-panel-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
  `.dsh-notes-panel-title{font-size:${sc(12.5)};font-weight:600;white-space:nowrap;letter-spacing:.01em}`,
  `.dsh-notes-panel-stats{font-size:${sc(11)};color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`,
  '.dsh-notes-panel-bar{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
  '.dsh-notes-panel-search{flex:1 1 auto}',
  '.dsh-notes-panel-segments{flex:0 0 auto;display:flex;align-items:center;gap:2px}',
  `.dsh-notes-panel-scope{flex:0 0 auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 10px;font-size:${sc(11)};border-bottom:1px solid var(--dsw-alias-border-l1)}`,
  `.dsh-notes-scope-chip{display:inline-flex;align-items:center;gap:2px;padding:1px 3px 1px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:${sc(11)}}`,
  `.dsh-notes-scope-chip .dsh-notes-btn{font-size:${sc(11)};padding:0 3px;line-height:1.3}`,
  `.dsh-notes-scope-input{flex:0 1 ${sc(130)};min-width:${sc(90)};font-size:${sc(11)};padding:2px 6px}`,
  `.dsh-notes-panel-crumb{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:4px 10px;font-size:${sc(11)};color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1)}`,
  `.dsh-notes-panel-error{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:5px 10px;font-size:${sc(12)};color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}`,
  '.dsh-notes-panel-body{flex:1 1 auto;min-height:0;overflow:auto;padding:4px 0}',
  // 排序:「最近」段默认按修改时间倒序,主键 4 选 1 + 一个方向按钮
  `.dsh-notes-panel-sort{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:3px 10px;font-size:${sc(11)};border-bottom:1px solid var(--dsw-alias-border-l1)}`,
  `.dsh-notes-sort-select{flex:0 1 ${sc(120)};min-width:${sc(88)};font-size:${sc(11)};padding:2px 6px}`,
  `.dsh-notes-sort-dir{min-width:${sc(24)};padding:2px 0;text-align:center;font-size:${sc(12)}}`,
  // 每行的修改时间(认不出时间的文件不显示这一列 —— 别拿假时间骗人)
  `.dsh-notes-panel-stamp{flex:0 0 auto;font-size:${sc(11)};font-variant-numeric:tabular-nums;white-space:nowrap}`,
  // 目录选择器:压在纳入管理面板**上面**(它自己是一个 overlay,套在同一个绝对定位祖先里)
  '.dsh-notes-panel-overlay-top{z-index:80}',
  `.dsh-notes-dirpicker-crumbs{flex:0 0 auto;display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:5px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}`,
  `.dsh-notes-dirpicker-crumb{max-width:${sc(150)};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
  '.dsh-notes-dirpicker-body{display:flex;flex-direction:column;padding:4px 6px}',
  `.dsh-notes-dirpicker-row{display:flex;align-items:center;gap:8px;width:100%;appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:${sc(12.5)};text-align:left;padding:5px 8px;border-radius:7px;cursor:pointer;transition:background .12s ease}`,
  '.dsh-notes-dirpicker-row:hover{background:var(--dsw-alias-bg-layer-2)}',
  '.dsh-notes-dirpicker-row>svg{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}',
  '.dsh-notes-dirpicker-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  `.dsh-notes-dirpicker-go{flex:0 0 auto;font-size:${sc(11)};opacity:0;transition:opacity .12s ease}`,
  '.dsh-notes-dirpicker-row:hover .dsh-notes-dirpicker-go{opacity:1}',
  `.dsh-notes-dirpicker-more{padding:4px 8px;font-size:${sc(11)}}`,
  '.dsh-notes-panel-row{display:flex;align-items:center;gap:8px;padding:3px 10px;border-radius:6px;transition:background .12s ease}',
  '.dsh-notes-panel-row:hover{background:var(--dsw-alias-bg-layer-2)}',
  '.dsh-notes-panel-name{flex:1 1 auto;min-width:0;display:flex;align-items:baseline;gap:8px;appearance:none;border:none;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;overflow:hidden}',
  `.dsh-notes-panel-title2{font-size:${sc(12.5)};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%}`,
  `.dsh-notes-panel-name .dsh-notes-mono{font-size:${sc(11)};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;min-width:0}`,
  '.dsh-notes-panel-group{margin:2px 0 6px}',
  `.dsh-notes-panel-grouph{width:100%;display:flex;align-items:center;gap:8px;appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:${sc(12)};font-weight:600;text-align:left;padding:4px 10px;border-radius:6px;cursor:pointer}`,
  '.dsh-notes-panel-grouph:hover{background:var(--dsw-alias-bg-layer-2)}',
  '.dsh-notes-panel-grouplist{padding-left:10px}',
  `.dsh-notes-panel-more{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:${sc(11)};padding:2px 10px;cursor:pointer}`,
  '.dsh-notes-panel-globs{margin-top:8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:6px}',
  `.dsh-notes-panel-rule{display:flex;align-items:center;gap:8px;padding:3px 10px;font-size:${sc(12)}}`,
  '.dsh-notes-panel-rule .dsh-notes-mono{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-notes-trash-list{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 8px}',
  '.dsh-notes-trash-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;transition:background .12s ease}',
  '.dsh-notes-trash-row>svg{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}',
  `.dsh-notes-trash-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:${sc(26)} 10px;color:var(--dsw-alias-label-secondary);font-size:${sc(12)}}`,
  '.dsh-notes-trash-empty svg{opacity:.5}',
  '.dsh-notes-trash-row:hover{background:var(--dsw-alias-bg-layer-2)}',
  `.dsh-notes-trash-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:${sc(12.5)}}`,
  `.dsh-notes-trash-meta{flex:0 0 auto;font-size:${sc(11)};color:var(--dsw-alias-label-secondary)}`,
  '.dsh-notes-trash-danger{color:var(--dsw-alias-state-error-primary)}',
  `.dsh-notes-panel-foot{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:6px 10px;border-top:1px solid var(--dsw-alias-border-l1);font-size:${sc(11)}}`,
  '.dsh-notes-panel-foot .dsh-notes-dim{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

  /* 编辑区 */
  '.dsh-notes-editor{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;overflow:auto}',
  '.dsh-notes-editor-pane{display:flex;flex-direction:column;height:100%;min-height:0;flex:1 1 auto}',
  `.dsh-notes-editor-bar{position:relative;display:flex;align-items:center;gap:4px;flex:0 0 auto;min-height:${sc(32)};padding:2px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}`,
  /* 标题:先保它自己(`flex:0 0 auto` + 38% 上限),**让工具栏去收缩/滚动** ——
     否则弹性收缩按 basis 分摊,标题会被压成只剩 30px 的「UI …」(实测)。
     完整标题在 `title` 里悬停可见。 */
  `.dsh-notes-editor-name{flex:0 0 auto;min-width:0;font-size:${sc(13)};font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:38%}`,
  /* 工具栏是**一行**命令:窄侧栏(约 700px)放不下时横向滚动,绝不换行把编辑区顶下去。
     `flex:1 1 auto` 让它吃掉剩余宽度(配合上面的标题不收缩)。 */
  '.dsh-notes-editor-tools{flex:1 1 auto;min-width:0;overflow-x:auto;overflow-y:hidden;flex-wrap:nowrap;scrollbar-width:thin;padding-right:2px}',
  /* 整篇动作(预览/源码 + 保存):固定在右侧,**不参与横向滚动**。
     以前它们排在工具栏末尾,默认侧栏宽度下被挤出可视区(用户审计:工具栏 662/334)。 */
  '.dsh-notes-editor-actions{flex:0 0 auto;display:flex;align-items:center;gap:2px;margin-left:2px}',
  '.dsh-notes-editor-tools::-webkit-scrollbar{height:6px}',
  '.dsh-notes-editor-tools::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:3px}',
  `.dsh-notes-editor-tools .dsh-notes-btn{min-width:${sc(24)};min-height:${sc(24)};padding:2px 4px;display:inline-flex;align-items:center;justify-content:center;gap:1px}`,
  /* 分组之间的细分隔线(不参与收缩,免得被挤没) */
  `.dsh-notes-sep{flex:0 0 auto;align-self:center;width:1px;height:${sc(15)};margin:0 4px;background:var(--dsw-alias-border-l1);opacity:.75}`,
  `.dsh-notes-h-mark{font-size:${sc(12)};font-weight:700;line-height:1}`,
  `.dsh-notes-caret-mark{font-size:${sc(8)};line-height:1;opacity:.75}`,
  /* 弹出面板:挂在编辑器条上(不是工具栏里)—— 工具栏是 overflow:auto,放里面会被裁掉 */
  '.dsh-notes-popover{position:absolute;top:100%;z-index:80;display:flex;flex-direction:column;gap:2px;padding:4px;min-width:112px;max-width:min(280px,92%);border-radius:8px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 10px 28px rgba(0,0,0,.22)}',
  `.dsh-notes-popover-item{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:${sc(12)};line-height:1.6;text-align:left;padding:4px 9px;border-radius:5px;cursor:pointer;white-space:nowrap}`,
  '.dsh-notes-popover-item:hover{background:var(--dsw-alias-bg-layer-2)}',
  '.dsh-notes-popover-form{gap:5px;padding:6px;min-width:236px}',
  '.dsh-notes-popover-input{width:100%;box-sizing:border-box}',
  '.dsh-notes-popover-row{display:flex;align-items:center;gap:4px}',
  `.dsh-notes-popover-label{font-size:${sc(11)};line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:nowrap;padding:0 2px}`,
  /* 表格选择网格:悬停高亮已选的行×列 */
  '.dsh-notes-grid{display:flex;flex-direction:column;gap:2px;padding:2px}',
  '.dsh-notes-grid-row{display:flex;gap:2px}',
  `.dsh-notes-grid-cell{appearance:none;width:${sc(14)};height:${sc(14)};padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:2px;background:var(--dsw-alias-bg-layer-1);cursor:pointer}`,
  '.dsh-notes-grid-cell-on{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent);border-color:var(--dsw-alias-brand-primary)}',
  // 状态条:固定一行,不折行;宽度不够时先挤掉字符数与路径(省略号 + title 看全文)
  `.dsh-notes-editor-status{flex:0 0 auto;display:flex;align-items:center;gap:10px;height:${sc(22)};padding:0 8px;font-size:${sc(11)};color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1);white-space:nowrap;overflow:hidden}`,
  '.dsh-notes-status-state{flex:0 0 auto}',
  '.dsh-notes-status-chars{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-notes-status-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;text-align:right}',
  '.dsh-notes-editor-host{flex:1 1 auto;min-height:0;overflow:hidden;display:flex}',
  '.dsh-notes-editor-host .cm-editor{flex:1 1 auto;min-width:0}',
  `.dsh-notes-editor-status{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:3px 10px;font-size:${sc(11)};color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1)}`,
  `.dsh-notes-crash{flex:1 1 auto;min-height:0;overflow:auto;margin:0;padding:10px;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:${sc(11)};line-height:1.5;white-space:pre-wrap;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}`,
  `.dsh-notes-notice{flex:0 0 auto;padding:4px 10px;font-size:${sc(12)};color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1)}`,
  `.dsh-notes-conflict{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:5px 10px;font-size:${sc(12)};color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);border-bottom:1px solid var(--dsw-alias-border-l1)}`,
  '.dsh-notes-conflict-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  `.dsh-notes-empty{display:flex;align-items:center;justify-content:center;flex:1 1 auto;padding:${sc(16)};text-align:center;font-size:${sc(13)};line-height:1.7;color:var(--dsw-alias-label-secondary)}`,
  `.dsh-notes-placeholder{display:flex;flex-direction:column;gap:6px;padding:${sc(14)} ${sc(16)}}`,
  `.dsh-notes-placeholder-title{font-size:${sc(15)};font-weight:600}`,
  // 占位块里的路径用 mono(没有自己的字号,不给就会继承根字号 —— 根字号是设计基准 13px,
  // 而这里要的是"次要信息"的 11px)
  `.dsh-notes-placeholder .dsh-notes-mono{font-size:${sc(11)}}`,
  `.dsh-notes-dim{font-size:${sc(11)};line-height:1.6;color:var(--dsw-alias-label-secondary)}`,
  '.dsh-notes-mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);word-break:break-all}',

  /* 字号 / 图标大小控件(标题栏上的 Aa + 浮层)
     挂在 `.dsh-notes-scale-wrap`(position:relative)上,所以浮层定位相对按钮;
     靠右所以 left:auto + right:0,不越出面板。 */
  '.dsh-notes-scale-wrap{position:relative;display:inline-flex;align-items:center}',
  '.dsh-notes-scale-btn{font-weight:600;letter-spacing:.02em}',
  '.dsh-notes-popover.dsh-notes-scale-pop{gap:6px;padding:8px;min-width:224px;left:auto;right:0;margin-top:4px;white-space:normal}',
  '.dsh-notes-scale-head{display:flex;align-items:center;gap:6px;padding:0 2px}',
  `.dsh-notes-scale-value{flex:1 1 auto;text-align:right;font-size:${sc(11)};color:var(--dsw-alias-label-secondary)}`,
  '.dsh-notes-scale-presets{display:flex;align-items:center;gap:2px}',
  `.dsh-notes-scale-preset{flex:1 1 0;appearance:none;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:${sc(11)};line-height:1.5;padding:2px 0;text-align:center;cursor:pointer;transition:background .12s ease,color .12s ease}`,
  '.dsh-notes-scale-preset:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
  '.dsh-notes-scale-preset-on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-weight:600}',
  '.dsh-notes-scale-range{width:100%;margin:0;accent-color:var(--dsw-alias-brand-primary)}',
  `.dsh-notes-scale-hint{font-size:${sc(11)};line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:normal;padding:0 2px}`,
  '.dsh-notes-scale-actions{display:flex;align-items:center;justify-content:flex-end;gap:4px}',
].join('\n')
