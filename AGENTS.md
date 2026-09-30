# dsh-notes — 项目规则(agent 必读)

DSH 的**笔记工作区**插件:右侧栏一个独立「笔记」区域(内部 = 可收起的笔记树 + Markdown 编辑器)。
笔记就是**普通 `.md` 文件**;索引只是一层**薄映射**。

## 四条硬不变量(改动前先读)

1. **永不删除、永不移动用户的 `.md`。** 插件只做三种写入:保存笔记内容(守卫式,带
   `expectedVersion`)、新建笔记文件、写资产文件。文件级删除/移动/改名仍归文件树与
   Agent 的通用文件工具。UI 里的「移除」= 只删索引条目。
   **两处例外,都只在用户显式动作下发生**(代码里都有注释):
   - **改名**:右键「重命名」/ 新建后行内改名 → 同目录 `rename`,目标已存在则拒绝(绝不覆盖);
   - **删除 = 移入回收站**:右键「Delete (move to trash)」→ 文件挪到
     `$DSH_HOME/knowledge/trash/`(在笔记根之外,重扫捞不回来)+ 索引移除,**可恢复**;
     真正的 `unlink` 只发生在「彻底删除 / 清空回收站」,且要点两次确认;
     恢复时原位置被占用则拒绝,绝不覆盖。
2. **Markdown 是权威,索引是可重建的派生态。** 索引在
   `$DSH_HOME/knowledge/registry.json`(或 `Config.storeDir`);笔记身份靠 frontmatter 里的
   `dsh-note-id`,索引丢了用 `rescan` 恢复。索引**绝不**反向复活已删除的文件;
   回收站是独立一层(`trash/index.json`),不参与对账。
3. **只有一套内容工具。** 读/写/改/搜继续用 `read` / `write` / `edit` / `glob` / `grep` / `bash`;
   本插件只额外提供 `knowledge` 工具(登记/注销/归类/分类树/未归类/重扫)。不许再长一套 note CRUD。
4. **不改 DSH 核心。** 只用官方扩展点:`ctx.sidebarRightTabs` / `ctx.slots`(`sidebar.right.pane.tab`)、
   `webServer.register`(自鉴权)、`fs`(守卫式写入)、`workspaceFiles`(只读 Remote)。权威接口面以
   `cordis_inspect_list` / `cordis_inspect_query` 与已安装包的 `lib/types/*.d.ts` 为准。

## 工作区 md 的三类模型(改动前先读)

工作区里的 md 分三类(见 `service.classify`):

| 类 | 含义 | 界面 |
| --- | --- | --- |
| **笔记** | 已纳入索引(有 `dsh-note-id`) | 笔记树 |
| **候选** | 未纳入、也还没标记 | 「纳入管理」面板(最近 / 按文件夹) |
| **杂项** | 未纳入、被显式标为忽略 | 面板「已忽略」段,可放回候选 |

- **扫描范围**(`workspace.scanRoots`,默认只有 `notesDir`):实测本机一次 `fs.listDir`
  约 **330ms**(WSL + /mnt/<盘> drvfs + 沙箱 provider),1268 个目录 ≈ 7 分钟 —— 所以
  **默认只扫 notes/**,要看别处必须在面板里加根(或 Agent 用 `knowledge ignore/include` 点名)。
- 一趟走不完会把**队列前沿**留在内存(`walkStates`),下次调用接着走;界面按块拉取并显示进度。
- **只有整趟走完且没被截断**才做"文件没了"的对账 —— 截断时绝不误删条目。
- 增量索引在 `$DSH_HOME/knowledge/index/<workspaceKey>.json`(`relPath → {v,s,id}`):
  版本/大小没变就不读文件;变了才用 `fs.readByteRange` 读前 4KB 解 id。
- 「忽略」只动映射,永不删文件;已登记的文件被删 → 走目录时按 id 找不到 → 条目一起消失。

## 渲染管线与热路径(最容易踩坑,改动前先读)

编辑器是 CodeMirror 6。渲染分三层,分层理由全是 CM6 的硬约束,不是审美:

| 层 | 文件 | 职责与约束 |
| --- | --- | --- |
| **决策层(纯函数)** | `lib/markdown-render.js` + `lib/markdown-syntax.js` | 输入「语法树 + 文本 + 选区 + knownTitles」,输出装饰**描述**(`line`/`hide`/`mark`/`widget`)。"该藏还是该露"的规则**只在这里**;`==高亮==`、`[[双链]]`、`$…$`、`$$…$$` 在 syntax 文件里注册成 lezer 真节点(不用正则二次扫描) |
| **行内层(ViewPlugin)** | `src/client/editor/decorate.ts` | 把描述翻译成 CM6 装饰。插件层**不能跨行替换**,所以这里只做行级/行内;出错由 `safeBuild` 兜底(退回旧构建器 → 空集),绝不让装饰层带崩编辑器 |
| **块级层(StateField)** | `src/client/editor/table.ts` | 跨行替换**只能**由 StateField 提供:元数据 chip、真 `<table>` widget(单元格就地编辑、表内右键插删行列)、代码卡、块级公式。它在**每次文档/选区变更**都重建 → 构建有 try/catch(`safeTableDecorations`),且按**每个编辑器**的 `sourceMode` 决定加不加装饰 |
| **装配** | `src/client/editor/setup.ts` | `createEditor()` 组装主题/键位/输入规则/点击命中/工具栏命令;`livePreview(...)` 与 `tableBlocks(sourceMode)` 在这里挂上去。**两栏分屏时两者都必须按编辑器取模式**,读模块级单例会让"另一栏切源码 → 这栏装饰全丢" |

**四条硬规则(都是踩过的坑,动热路径前先读):**

1. **CM6 选区必须用 `EditorSelection.range(...)`。** 传 `{ anchor, head }` 普通对象会被
   `state.changeByRange` **原样**塞进 `state.selection`;下一次需要映射选区的事务(打字、粘贴、
   `setDoc`)就在 `EditorSelection.map` 里抛 `TypeError: r.map is not a function`,CM6 的输入
   处理还会先读 `sel.from` 在 `doc.lineAt` 上抛错 → **编辑器卡死,只能打开别的笔记再点回来**
   (重建 EditorState 才恢复)。纯逻辑在 `src/client/editor/selection.ts`,靶子在
   `test/selection.test.mjs`(含一条反向锁:用普通对象冒充必须抛错)。
2. **lezer 在本环境 `SyntaxNode.children` 恒为 `null`。** 遍历子节点只能用 `firstChild` /
   `nextSibling`;项目里有现成的 `childrenOf()`(见 `lib/markdown-render.js`)。
3. **`@lezer/markdown` 的 `Table` 节点会把"紧跟表格的非空行"也算成 `TableRow`。** 块级侧要
   `clampTableRange` 夹到"最后一个含 `|` 的行"(否则那行被整块 replace 隐藏);决策层同样夹取,
   并对**夹取点之后**的子节点继续 `walk`(否则那些行永远拿不到行内装饰 —— 用户实测:表格下
   紧跟的 `[[链接]]` 一直显示原文)。
4. **单测必须与运行时同构。** 解析器要用
   `markdownLanguage.parser.configure(markdownSyntaxConfig())`;裸 `markdownLanguage.parser`
   没有自定义行内语法,`[[x]]` 会被解析成普通 `Link`,靶子用例永远是红的。

## 身份、标题与多文档

- **标题 = 文件名**(Obsidian 模型)。正文里的 H1 只是正文,`[[链接]]` 也按文件名解析。
- `dsh-note-id` 只在**纳入那一刻**写入;预览模式把它收成一行「⋯ 元数据」chip
  (点一下展开源码)。保存时若发现 id 被删/被改,Host 会按索引**写回**并在响应里带
  `restoredId` —— 这是身份标识的兜底,`editor.idRestored` 会提示用户。
- **标签栏 + 左右分屏**:每栏一条自己的标签栏;布局按工作区存 localStorage
  (`dsh-notes:tabs:<workspaceKey>`),最多 8 个标签/栏;标签页保持挂载(切标签不重读盘)。
- **工作区切换**:内容路由都接受 `workspaceKey`(**只认已登记的**);用户侧写入的策略
  `policyFor` = **模式仍来自会话**(read-only 依旧只读),**边界根换成目标工作区根**。

## 常驻正文 + 字号缩放(改这两块前先读)

这两件事都建立在**同一个前提**上:右栏 tab 声明了 `keepMounted: true`(`main.tsx`),
切走只是**隐藏**,组件不卸载。

### 常驻正文(keepMounted)

- 官方右栏 tab 正文默认**卸载**(`SidebarRightTabDefinition.keepMounted` 默认 false)。卸载即丢
  `NotesPane` 的全部 state(树 / 标签 / 光标 / 滚动)→ 切回来只能从头拉树,界面上就是那句
  **「读取中…」**(实测:切走时 `.dsh-notes-root` 从 DOM 消失,切回来 79ms 出现 loading)。
- 声明 `keepMounted: true` 后正文常驻(隐藏期间 `offsetWidth === 0`)。**代价与配套**:
  - 4s 轮询必须自己按可见性停下 —— 读座位注入的 `useTabInfo().tab.visible`
    (`active && (float || expanded && (title || pane.activeTabId === tabId))`),镜像进 `visibleRef`
    (不要写进 effect 依赖,否则定时器每次渲染重建 —— 与 `refreshRef` 同一个坑)。
  - **变回可见时补一次对账 + 让编辑器重量尺寸**:隐藏期间轮询停了、CodeMirror 量出来是 0。
    外壳用 `measureNonce` 通知 `EditorArea` 调 `requestMeasure()`(复用"切标签重量"的那条 effect)。
  - 首次挂载仍是**可见时**发生(未访问过的正文不会提前挂载),所以"挂载即 focus"那类副作用不受影响。
- 首次取树等 `wsReady`(`loadWorkspaces()` 完成后才放行):`fetchTree` 带的是**模块级**
  `activeWorkspaceKey`,刚挂载时可能还是上一个会话留下的值 —— 抢跑会白跑一次、甚至取错工作区。

### 字号缩放

- 两个变量,都落在 `.dsh-notes-root` 上:
  - `--dsh-notes-scale`(0.85–1.5,默认 1)= **本区微调**,由 React 行内 style 写(`scaleVars()`),
    偏好存 `localStorage['dsh-notes:ui-scale']`(显示器级偏好,按浏览器存才对);
  - `--dsh-content-font-delta` = 宿主**全局「字体大小」**的增量(ui-theme 写在 `body` 上,默认 0px)。
    加上它 → 设置 → 通用改字号,笔记区跟着变,不用再调一次。
- **唯一公式**:`cssSize(设计px)` = `calc(Npx × 系数 + 增量)`(`src/client/scale.ts`)。
  样式表以 `sc` 的名字 import 它,行内样式/图标/CM6 主题直接用 `cssSize`。
  **不要改用 `em`**:em 会逐层相乘(父级设了字号,子级再设一次就叠),而这里每个尺寸都要彼此独立、
  且在「系数 1 + 增量 0」时与设计值逐像素一致(实测:13/26/30/13.5 全部原样)。
- 用 `sc()` 的地方:字号、承载文字的高度/最小宽度、会被字撑开的宽度上限、图标、缩进、编辑器正文。
  **保持 px**:边框/hairline、圆角、padding、gap、阴影、面板尺寸、以及 `position:fixed` 浮层的
  **JS 坐标**(右键菜单 / 工作区菜单 / 拖拽跟随块)。
- 所以**不许用 `zoom` / `transform: scale`**:浮层坐标是 JS 按视口 px 算的,缩放会把它们整体推偏
  (实测 1.5× 时右键菜单左上空隙就是它的表现)。图标一律走 `icons.tsx` 的外壳
  (自己画 svg 的 `IconChevron` 也要带上 width/height —— 漏了就是"只有折叠箭头不变大")。


## 功能现状(已交付,别重复造)

- **编辑器**:预览/源码**按栏独立**(表头按钮切换);工具栏 23 键(7 组 + 4 弹层:标题 / 链接 /
  表格 / 公式);右键菜单 = 「引用此处」+ 文本格式 / 段落设置 / 插入(**表内**右键换成插删行列);
  `[[` 补全(Tab 接受、不再多出 `]]`);图片粘贴/拖入;大纲面板;`Ctrl/Cmd+S/F/B/I/E`、
  `Ctrl+1…6/0`、表格内 Tab 跳单元格。
- **拖放语义**:从左栏拖笔记 → **落进正文 = 插入 `[[标题]]`**(不开标签)、**落到标签栏 = 新开标签**;
  拖到编辑区左右边缘带 = 落到对应分栏。
- **标签与分屏**:每栏自己的 `＋`;跨栏拖动、栏内按中线重排、空栏自动收;`Ctrl/Cmd+PageUp/Down`
  切栏(**+Shift** 把当前标签搬到另一栏);撤销按钮**先**回退"同一标签内的跳转历史"(点 `[[链接]]`
  跳走后,撤销回上一篇),没有再走文档撤销。
- **侧栏**:笔记树(右键菜单、拖拽)+ 纳入管理面板(最近 / 文件夹 / 已忽略 + 扫描范围 + 批量)
  + 回收站 + 大纲,四块共用一套 `ContextMenu` / panel 样式。
- **缺 `notes/` 的工作区**:空态卡片 —— 「创建 notes/」或「改用已有目录(按工作区相对路径)」。
- **字号/图标大小**:标题栏一个 `Aa`(五档预设 + 滑块 + 复位)→ `--dsh-notes-scale`,只作用于笔记区;
  基准字号**跟随**设置 → 通用的「字体大小」。改字号/图标相关的东西前先读上面那节。
- **窗口:** 侧栏 tab 的 chip 是「图标 + Notes」(`sidebar.right.pane.tab.title` 座位)。

## 位置决定(已实测,别再翻)

- DSH **左栏没有**给插件留内容插槽(`sidebar.workspaces` 由 ui-workspace 独占,强占即 `shadows-shipped-ui`)。
- 右栏 `sidebar.right.pane.tab` 是**按 tab 类型 id 派发**的加法插槽 → 笔记树 + 编辑区都放在**一个** tab 内部。
- 右栏 tab 是 **session 作用域**;因此树内容按**工作区**(`sessionId → session.header.cwd`)取,布局按会话。
- 右栏 tab 正文**默认卸载**(没在显示的 tab 不进 DOM),所以本插件注册时带 `keepMounted: true`:
  切走只是隐藏、state 不丢(细节与配套见上面「常驻正文 + 字号缩放」那节)。
- `.md` 的官方渲染实现是 `documentPreviews` 的 `…/markdown`(priority `builtin`);将来若要接管
  文件树里的 `.md` 预览,注册 `priority:'extension'` 的同扩展实现即可,不必改核心。

## 目录

| 路径 | 作用 |
| --- | --- |
| `lib/index.js` | Host 半:配置、索引装配、路由注册、`knowledge` 工具 |
| `lib/service.js` | 工作区解析与切换、扫描(目录前沿续走)、三类分类、回收站、守卫式保存 |
| `lib/registry.js` | 按工作区的薄索引(登记/忽略/忽略 glob/扫描根/最近使用) |
| `lib/notes.js` | 纯函数:路径 / frontmatter / 标题(=文件名)/ glob 匹配 |
| `lib/routes.js` | 内容路由 `/dsh-notes/*`(全部接受 `workspaceKey`) |
| `lib/tool.js` | `knowledge` 工具的两个 op 面 |
| `lib/markdown-render.js` | **渲染决策层(纯函数)**,单测 `test/markdown-render.test.mjs` |
| `lib/markdown-syntax.js` | 自定义行内语法(高亮 / 双链 / 公式)的 lezer 注册 |
| `lib/outline.js` / `lib/section.js` | 大纲解析 / 章节搬移(纯函数,有单测) |
| `lib/client.js` | **构建产物**,勿手改(`npm run build`) |
| `src/client/main.tsx` | 侧栏注册、错误边界、i18n(zh/en 两份字典要同步加键) |
| `src/client/NotesPane.tsx` | 区域外壳:工作区切换、树、4s 轮询(按 `tab.visible` 门控)、布局(`tabs`)、字号缩放状态 |
| `src/client/scale.ts` | 字号/图标缩放的**纯模型**(偏好读写/夹取 + `cssSize()` 公式),单测 `test/scale.test.mjs` |
| `src/client/ScaleControl.tsx` | 标题栏的 `Aa` 按钮 + 浮层(预设 / 滑块 / 复位) |
| `src/client/editor/tabs.ts` | 标签/分栏**纯模型**(打开/关闭/移栏/持久化),单测 `test/tabs.test.mjs` |
| `src/client/EditorArea.tsx` / `TabStrip.tsx` | 分栏渲染、标签条、拖动换栏 |
| `src/client/TreePane.tsx` | 笔记树(拖拽载荷:`x-dsh-note-id` / `x-dsh-note-title` / `text/plain` = `[[标题]]`) |
| `src/client/CandidatesPanel.tsx` | 纳入管理面板(最近 / 文件夹 / 已忽略 + 扫描范围) |
| `src/client/TrashPane.tsx` / `OutlinePane.tsx` / `QuickOpen.tsx` | 回收站 / 大纲 / 快速打开 |
| `src/client/ContextMenu.tsx` | 共享右键菜单(分组 + 二级菜单 + 视口夹取) |
| `src/client/editor/setup.ts` | CM6 装配:主题、键位、输入规则、点击命中、工具栏命令 |
| `src/client/editor/decorate.ts` | 行内装饰 ViewPlugin(`safeBuild` 兜底) |
| `src/client/editor/table.ts` | 块级 StateField(chip / 表格 / 代码卡 / 公式)+ `tableTab` |
| `src/client/editor/selection.ts` | 选区包裹的纯逻辑(**必须用 `EditorSelection.range`**) |
| `src/client/editor/table-model.ts` / `blocks.ts` / `reference.ts` | 纯模型:表格解析 / 块级插入规划 / 引用载荷 |
| `src/client/editor/media.ts` | 媒体地址工具(单独成模块是为打断 `decorate ⇄ setup` 循环依赖) |
| `src/client/api.ts` | 客户端 → `/dsh-notes/*` 的薄封装 |
| `src/client/styles.ts` | 全部 CSS(走主题 token:layer / border-l1-l2 / brand) |
| `scripts/build.mjs` | esbuild 打包(module loader 懒工厂格式;react 保持 external) |
| `scripts/build-graph.mjs` | 依赖环检查(改完客户端跑一次,要求 `cycles: 0`) |
| `cordis.patch.yml` | 安装进 profile 的 bundle patch(插入一行) |
| `test/` | `node --test` 单测(145 条) |

## 开发与验证

```bash
cd "<你克隆 dsh-notes 的目录>"
npm run setup                # 装构建工具链(只有 esbuild,落在 scripts/node_modules)
npm run build                # src/client → lib/client.js
node --check lib/index.js && node --check lib/client.js
npm test                     # = node --experimental-strip-types --test test/*.test.mjs
node scripts/build-graph.mjs # 依赖环检查:必须 cycles: 0
```

**`node_modules` 是符号链接,不是装出来的**(本工作区惯例,同 `dsh-explain-sidebar`):

```bash
ln -s $DSH_HOME/profiles/<profile>/node_modules node_modules
```

原因:插件以 `link:` 装进 profile 后,Node 从**真实路径**(`/mnt/<盘>/...`)解析裸导入,
找不到 `@deepseek-ai/*`;指向 profile 的 `node_modules` 才有全套 harness 包。
所以**别在本目录跑 `npm install`** —— 那会生成真的 `node_modules` 并遮蔽符号链接,
表现为 `dsh-notes (dsh-notes): failed to import`(Host 半整行 inactive)。
构建工具链因此单独放在 `scripts/`(它有自己的 `package.json`)。

- 装/更新:用 `plugin_manager` 的 `install_bundle`(target = 本目录绝对路径),
  **不要**手写 profile 的 `package.json` / `cordis.patch.yml`,**不要**在 profile 里跑 pnpm。
- **改了客户端** → `npm run build` 后**刷新页面**即可(客户端 bundle 由页面加载,**不需要**
  `web_restart`);**改了 Host 半**(`lib/*.js` 里除决策层以外的部分)→ 必须 `web_restart`
  再刷新。`lib/markdown-render.js` / `lib/markdown-syntax.js` 是**打包进 `lib/client.js`** 的,
  按客户端处理。
- 验完在 `cordis_inspect_query`(client `Slots`,root `sidebar.right.pane.tab`)里确认占用者含 `dsh-notes`;
  Host 侧看 `Config.listConfigs`(name=dsh-notes)的 `status` 必须是 `schema`,不是 `inactive`。

**排错与取证(都实测过):**

- 客户端崩溃/卡死时用**非压缩构建**拿真名栈:`DSH_NOTES_NO_MINIFY=1 npm run build`(随后务必
  再跑一次普通 `npm run build` 还原)。
- `createEditor()` 把 `EditorView` 挂在宿主元素上(`options.parent.__dshView`),浏览器里可直接
  核对"文档 / 选区 / 装饰"而不必靠反复点击试探。
- 只读决策层的行为用 Node 就能验(`test/markdown-render.test.mjs` 走真解析器),不要用截图当证据;
  热路径上的改动先用靶子用例红→绿,再动浏览器。

> **升级/重装依赖之后**:先在**工作区根**跑那四组补丁校验脚本(见根 `AGENTS.md`),
> 再重启 web —— 否则本机六组补丁可能已丢失(尤其 A2 临时组,仅 0.2.0-rc.1 需要)。

## 事实来源

运行中的 harness(`cordis_inspect_list` / `cordis_inspect_query`)与已安装包的
`lib/types/*.d.ts` 是权威,不是本文档,也不是记忆。

<!-- project-context:begin -->
## Project Context

This directory is a Managed Project. Long-term project memory lives in `AGENTS.md`.
Those files are a low-frequency projection of the code: the code is always the
final source of truth for current behavior.

Rules for agents working here:

- Canonical documents may be written **only** when the user asks for project
  initialization or for a core-memory update, and confirms the plan or proposal
  first. Ordinary development, status checks, and architecture refreshes must
  not modify them.
- After a task that changed files in this project, append one lightweight line to
  `.agent-context/changes.jsonl` using the `project-context` skill. Do not record
  pure questions, read-only analysis, formatting-only changes, or tasks with no
  file changes.
- Do not edit anything under `.agent-context/` by hand; it is maintained by the
  `project-context` skill.
<!-- project-context:end -->
