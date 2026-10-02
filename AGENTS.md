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
     `<工作区>/.dsh-notes/.trash/`(**点目录**,重扫捞不回来)+ 索引移除,**可恢复**;
     真正的 `unlink` 只发生在「彻底删除 / 清空回收站」,且要点两次确认;
     恢复时原位置被占用则拒绝,绝不覆盖。
2. **Markdown 是权威,索引是可重建的派生态。** 语义索引在
   **`<工作区>/.dsh-notes/index.json`**(跟着工作区走);机器本地只剩派生缓存与"见过哪些工作区"。
   笔记身份靠 frontmatter 里的 `dsh-note-id`,索引丢了用 `rescan` 恢复。索引**绝不**反向复活已删除的文件;
   回收站是独立一层(`.dsh-notes/.trash/trash.json`),不参与对账。
3. **只有一套内容工具。** 读/写/改/搜继续用 `read` / `write` / `edit` / `glob` / `grep` / `bash`;
   本插件只额外提供 `knowledge` 工具(登记/注销/归类/分类树/未归类/重扫)。不许再长一套 note CRUD。
4. **不改 DSH 核心。** 只用官方扩展点:`ctx.sidebarRightTabs` / `ctx.slots`(`sidebar.right.pane.tab`)、
   `webServer.register`(自鉴权)、`fs`(守卫式写入)、`workspaceFiles`(只读 Remote)。权威接口面以
   `cordis_inspect_list` / `cordis_inspect_query` 与已安装包的 `lib/types/*.d.ts` 为准。

### 平台约定(改路径 / 文件名之前先读)

**内部只有一种路径写法:一律 `/` 分隔**(`lib/notes.js` 的 `toPosix` / `normalizePath`)。
`node:path` 的 `join()` 在 Windows 上产出 `\`,所以 `store.js` / `service.js` 里**每个** `join()`
的结果都要 `normalizePath()` 包一层 —— 少一处,同一个目录就会同时存在两种写法,
字符串比较与集合键静默失配。**Linux 上测不出来**(那边 join 本来就是 `/`),2026-10-02 在
Windows node 上实测:这类问题一次红 12 条。宿主 `fs` 与 Win32 API 都接受 `/`,
所以归一之后不需要在调用前换回 `\`。

文件名侧同理:`sanitizeFileName()` 已经处理 Windows 保留设备名(含 `CON.md`)、尾随点/空格、
非法字符与长度上限。三平台的差异、已验证的证据、以及**没有真机**的 macOS 边界见 README 的
「平台支持」一节;靶子在 `test/platform-paths.test.mjs`(喂 Win32 输入,所以在 Linux 上也照红)。

## 数据放在哪(改存储前先读)

**语义数据跟着工作区走;机器本地只留派生缓存与"见过哪些工作区"。** 这是本插件的存储契约:
用户备份工作区、或把整份工作区搬到另一台机器/另一个路径,装上同一个插件就能原样读出来。

| 数据 | 位置 | 性质 |
| --- | --- | --- |
| 笔记身份 | `<root>/notes/*.md` 的 frontmatter `dsh-note-id` | 权威 |
| 图片资产 | `<root>/.dsh-assets/<noteId>/` | 工作区数据 |
| **薄索引**(分类树 / 归属 / 忽略 / 置顶 / 最近 / `refs` / 扫描范围 / 笔记根覆盖) | **`<root>/.dsh-notes/index.json`** | 可重建(rescan),但**人工组织只在这里** |
| **回收站**(文件本体 + `trash.json`) | **`<root>/.dsh-notes/.trash/`** | 工作区数据 |
| 自忽略文件 | `<root>/.dsh-notes/.gitignore`(内容 `*`) | 让插件数据不进用户的 `git status` |
| 扫描缓存 `relPath → {v,s,id}` | `$DSH_HOME/knowledge/index/<workspaceKey>.json` | 派生数据(删了只影响扫描速度) |
| 已知工作区根表 | `$DSH_HOME/knowledge/workspaces.json` | 机器状态(切换器列表 + `lastUsedAt`) |
| 标签/分屏布局、字号 | 浏览器 `localStorage` | **设备本地**(刻意不跟着工作区走) |

几条不变量:

- **工作区键是派生的,不是数据**:`workspaceKey = sha1(规范化 root)[:12]`。文件里存了也不可信 ——
  装载时按**当前 root** 重算(见 `store.js` 的 `adoptWorkspaceKey`)。
- **索引里记的是相对路径,只有 `root` 是绝对的**(v0.4.0 起)。这个文件就躺在工作区里,
  它记的每一篇笔记必然在工作区内,所以 `notes[].rel` / `workspaces[].notesRootRel` 用**工作区相对**
  记法,装载时按当前根展开(见 `store.js` 的 `relativizeState` / `toAbsolute`)。
  于是"搬走工作区"是**零操作**;`root` 留着是因为它既是锚点、又是键的来源。
  旧格式(绝对 `path`)装载时自动补出 `rel`,下次落盘即迁移完。写在边界上的一句总结:
  **内存里一律绝对,落盘一律相对**,转换只发生在 `registryFor`(读)与 `persist`(写)两个点。
  唯一的例外是 `storeScope: 'home'`(机器本地一份整体索引,装着多个工作区与跨工作区映射,
  只有绝对路径说得清"是哪个文件"),它保持旧行为。
- **点目录天然安全**:两处走目录都 `entry.name.startsWith('.') → continue`,所以
  `.dsh-notes/`(含 `.trash/` 里的 `.md`)永远不会被当成候选笔记重新登记回树。
- **升级是懒迁移**:`<root>/.dsh-notes/index.json` 不存在而旧的 `$DSH_HOME/knowledge/registry.json`
  里有这个工作区的切片 → 自动迁进来,**旧文件原样保留**(备份)。`storeScope: 'home'` 是逃生开关
  (完全旧行为);`knowledge` 工具的 `migrate` op 是**显式**双向搬运(移动语义)。
- **只读工作区**:读路径(`persistSafe`)只记一次日志、不抛 —— 界面仍能用内存里的索引;
  用户**显式写操作**才如实报错。
- **笔记根覆盖的 `''` 与 `'.'` 含义不同**(踩过一次):`notesRootOverrideRel` 是**可选**字段,
  `''`(= 字段缺席)表示"没设过",所以"用户显式把笔记根设成工作区根本身"必须记成 `'.'`;
  不区分的话往返一趟就丢(会静默退回默认 `notesDir`)。`notesRootRel` 恒有意义,`''` 就是根。

## 时间与行尾(改这两处前先读)

这两个都是"官方接口面不提供,只能自己想办法"的地方,各有一次实测踩坑。

### 「最近」的修改时间从哪来

- 官方 `fs` **不暴露 mtime**:`FsDirEntry` 只有不透明的 `version`/`size`,`FsInfo` /
  `WorkspaceFileStat` 同样。目录列举也不给时间。
- 本机 provider(`@deepseek-ai/dsh-fs-local`)的 `versionOf()` 是
  `` `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}` ``(**第 4 段就是 mtime**)。
- 所以 `lib/notes.js` 的 `mtimeOfVersion(version)` 做**严格形状校验**:5 段全数字 → 第 4 段纳秒换毫秒;
  单段纯数字 → 按毫秒(部分替身/provider 这么给);**其它形状一律 0**,调用方回落成路径序。
- 旧代码写的是 `Number(entry.version) || 0` —— 在真 token 上恒为 NaN→0,于是"最近"悄悄退化成
  按路径排;**而单测的假 provider 一直用 `String(info.mtimeMs)`,所以永远测不出来**。
  新测试(`test/service-scan-time.test.mjs`)故意用**真形状**,与运行时同构。
- ⚠️ **升级 DSH 或换 fs provider 之后要复核这条**:token 形状一变,时间就全变 0(排序退回路径序,
  界面上是"时间列不显示"),不会报错。

### 行尾必须保住

- 编辑器(CM6)里的文本**恒为 LF**:`EditorState.create({ doc })` 用 `/\r\n?|\n/` 切分重建。
- `fs.readText` 给的是**磁盘原文**(CRLF 原样),`fs.writeText` 也是**原样写** —— 与官方
  `editText` 不同,后者会 `restoreLineEndings`。
- 所以 `service.save()` 写盘前必须 `applyEol(payload, await this.eolOf(target))`(采样文件头,
  规则与 fs-local 的 `detectLineEndings` 一致:前 4096 字节里 CRLF 占多数 → CRLF)。
  不做的话,随手保存一篇 CRLF 笔记就把整份文件的行尾改写了(实测那篇 123KB 里有 1244 个 CR)。
- 同理,`FS_STALE_VERSION` 抛出去的 `currentText` **必须归一成 LF**:客户端那条
  "磁盘内容 == 我正要写的内容 → 自愈"的分支拿它和编辑器文本(恒 LF)比相等,不归一就永远不相等,
  于是 CRLF 笔记上误报"文件已被外部修改"。
- **打开笔记的坐标也必须按 CM6 的切分规则算**:`initialAnchor` 用 `LINE_SPLIT`(`/\r\n?|\n/`)
  而不是 `'\n'`,否则 CRLF 文件算出来的锚点比 `doc.length` 大 → CM6 抛
  `Selection points outside of document`(硬抛,编辑器整个带崩)。
  除此之外 `EditorPane` 里那处 `dispatch({selection})` 还额外 `Math.min(anchor, doc.length)` 夹一次
  —— 项目里其它每个 dispatch 都有同样的夹取,别再漏。

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
- 增量索引(扫描缓存)在 `$DSH_HOME/knowledge/index/<workspaceKey>.json`(`relPath → {v,s,id}`):
  版本/大小没变就不读文件;变了才用 `fs.readByteRange` 读前 4KB 解 id。它是**派生数据**,
  所以留在机器本地、不跟着工作区走(否则每次都往用户仓库里写几十 KB)。
- 「忽略」只动映射,永不删文件;已登记的文件被删 → 走目录时按 id 找不到 → 条目一起消失。

## 渲染管线与热路径(最容易踩坑,改动前先读)

编辑器是 CodeMirror 6。渲染分三层,分层理由全是 CM6 的硬约束,不是审美:

| 层 | 文件 | 职责与约束 |
| --- | --- | --- |
| **决策层(纯函数)** | `lib/markdown-render.js` + `lib/markdown-syntax.js` | 输入「语法树 + 文本 + 选区 + knownTitles」,输出装饰**描述**(`line`/`hide`/`mark`/`widget`)。"该藏还是该露"的规则**只在这里**;`==高亮==`、`[[双链]]`、`$…$`、`$$…$$` 在 syntax 文件里注册成 lezer 真节点(不用正则二次扫描) |
| **行内层(ViewPlugin)** | `src/client/editor/decorate.ts` | 把描述翻译成 CM6 装饰。插件层**不能跨行替换**,所以这里只做行级/行内;出错由 `safeBuild` 兜底(退回旧构建器 → 空集),绝不让装饰层带崩编辑器 |
| **块级层(StateField)** | `src/client/editor/table.ts` | 跨行替换**只能**由 StateField 提供:元数据 chip、真 `<table>` widget(单元格就地编辑、表内右键插删行列)、代码卡、块级公式。它在**每次文档/选区变更**都重建 → 构建有 try/catch(`safeTableDecorations`),且按**每个编辑器**的 `sourceMode` 决定加不加装饰 |
| **装配** | `src/client/editor/setup.ts` | `createEditor()` 组装主题/键位/输入规则/点击命中/工具栏命令;`livePreview(documentPath, getKnownTitles, sourceMode, expandTitle)` 与 `tableBlocks(sourceMode, strings)` 在这里挂上去(widget 文案经 `strings` 一路传到 `table.ts`)。**两栏分屏时两者都必须按编辑器取模式**,读模块级单例会让"另一栏切源码 → 这栏装饰全丢" |

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

### 横向宽度:正文永不横滚,表格自己滚(改宽度相关前先读)

用户口径(照 Typora):**正文必须自适应换行、不许有横向滚动条;只有表格在列多时才横滚。**

三条一起才成立,少一条就会"整篇都要左右拖"(2026-10-01 实测:滚动区 384px、内容区被撑到 687px):

1. `.cm-content { min-width: 0 }` —— **最关键的一条**。CM6 把 `.cm-content` 做成
   `.cm-scroller`(display:flex)里的 flex item(`flex-grow:2; flex-shrink:0`),而 flex item 的
   `min-width:auto` 等于它的 **min-content 宽度**:表格一宽就把内容区撑得比滚动区还宽,
   于是**正文也跟着在更宽的宽度上换行**,整篇都得左右拖。`min-width:0` 让内容区恒等于滚动区宽度。
2. `.dsh-cm-table-wrap { max-width:100%; overflow-x:auto }` + 表格 `width:max-content; min-width:100%`
   —— 窄表格仍铺满(照 Typora),宽表格由**外壳**滚。少了 `max-width:100%` 就会去顶 `.cm-content`。
3. `.cm-content { overflow-wrap:anywhere }` + `.cm-scroller { overflow-x:hidden }` ——
   长到没有空格的串(URL、很长的磁盘路径、长公式)默认**不换行**;这一条是兜底,
   保证正文侧永远没有横向滚动条。

配套两条:

- **单元格**要 `white-space:normal; overflow-wrap:anywhere; max-width:32em`,否则一格长文本
  能把那一列拉到几千像素。
- **图片**必须两级都约束:外壳 `max-width:100%`(百分比相对**行/内容区**解析,这才是真约束)
  + `img { max-width:100%; height:auto; object-fit:contain }`。只写图片那一级是**空转** ——
  `inline-flex` 外壳的宽度本来就是由图片决定的,一张 2000px 宽的图照样把正文顶宽(用户实测)。

### 表格单元格里的行内 markdown

单元格以前是 `td.textContent = cell.text`,于是表格里的 `**加粗**`、`$公式$`、`==高亮==`
全是原文(用户实测"表格里面没法渲染")。现在每格走**同一套决策层**:

- `editor/cell-inline.ts` 是**纯函数**(无 DOM / 无 Temml,所以能进 `node --test`):
  把决策层给的**扁平区间**(mark/hide/widget)折成**嵌套节点树** —— `**粗体里的 `代码`**`
  是 MARK 套 MARK + 两个 HIDE。
- `editor/cell-render.ts` 落成 DOM:公式走 Temml(与正文同一个渲染器、同一套 CSS);
  **认不出来的 widget 一律退回原文**,绝不吞内容。
- `MARK_CLASS` 必须与 `decorate.ts` / `setup.ts` 的 theme 一致,否则"正文里的加粗是粗的、
  表格里的不是"。
- 单元格单独解析(`tableBlocks` 里的 `parseCellMarkdown`),**必须用配置过自定义语法的 parser**,
  否则 `[[x]]` / `==x==` / `$x$` 根本不会变成节点(第四条硬规则)。
- 就地编辑不受影响:输入框仍然吃 `cell.text` 原文,渲染只是"底下那一层"。
- ⚠️ **绝不要往活的 `.cm-content` 里塞测试节点**:CM6 的 MutationObserver 会把 DOM 变更
  当成**真实的编辑**读回文档(实测:塞一个 `test` 节点 = 文档多 12 个字符并触发自动保存)。
  要量 CSS 就把测试节点挂到 **`.cm-scroller`**(它不在 contenteditable 里)或干脆用离线页面。

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
- **浮层材质**:本主题(open-sea-skin)把所有 `--dsw-alias-bg-*` 都做成了半透明 —— 浮层
  (面板 / 右键菜单 / 弹层 / 提示块)必须配 `--dsw-specific-menu` + `backdrop-filter:
  var(--dsw-menu-backdrop-filter)`(宿主菜单同一套),否则**背后正文穿透可读**(用户审计实测)。

## 编辑安全(改编辑器前先读这五条,全是踩过的)

1. **重建编辑器只有两个合法理由:「载入」与「切模式」。** 载入 effect 的依赖**只有**
   `[note.path, sessionId]` —— 把 `sourceMode` 或回调放进去,它们一变就重读磁盘,800ms 自动保存
   窗口里没落盘的输入会被磁盘内容覆盖(用户实测:切一次「源码/预览」,刚打的字静默消失)。
   切模式走单独那条 effect:**用当前文档 + 当前光标/滚动**重建,`versionRef`/`dirtyRef` 原样保留。
2. **卸载前必须 flush。** cleanup 里先取文本 → destroy → `void saveRef.current(text)`;
   `save()` 因此拆成能吃文本的 `saveText(text)`。
3. **关页面 / 切后台走 `navigator.sendBeacon`**(`api.saveNoteBeacon`;拿不到就 fetch keepalive):
   `pagehide` + `visibilitychange(hidden)`。beacon **拿不到响应**,版本号会过期 —— 所以
   hidden → visible 时要**静默对一次版本**(磁盘内容 == 我们 beacon 写的内容 → adopt 新版本),
   否则下次保存会误报"文件已被外部修改"(实测踩到)。
4. **`FS_STALE_VERSION` 要自愈一次**:磁盘内容 == 正要写的内容 → 那是自己写的,只对齐版本、算成功;
   内容不同才走冲突 UI(真正的**外部**改动内容必然不同)。
5. **表格行下标语义**(`TableActionTarget.row`):数据行 = `<tbody>` 内下标(0 起),**表头 = -1**。
   `<thead>`/`<tbody>` 各自从 0 编号,所以**不能**拿"节点在父元素里的下标"当行号 ——
   旧代码因此"删第一行"变空操作、"删第二行"删掉第一行(用户实测)。块计算是纯函数
   `applyTableAction`(单测 `test/table-model.test.mjs`),别再把逻辑写回组件里。

另外两条与状态有关的:

- **`refresh` 的依赖要写全**(`[sessionId, syncLayout, openNote]`)。以前只写 `[sessionId]`,
  于是它一直调用"`layoutReady` 还是 false"那一帧的旧 `syncLayout`(每次都直接 `return current`)
  → **改名后标签标题/路径永不更新**,继续编辑就会保存到不存在的路径(实测 Host 报 NOT_FOUND)。
  轮询/可见性/focus 仍然走 `refreshRef.current` —— 这条老规矩不变(否则定时器被反复重建)。
- **跨异步链读状态要用 ref**:`pendingOpenRef`(新建后自动打开)就是例子 ——
  `await call('create')` → 回调里 `setPendingOpen` → `await refresh()`,中间**不经过渲染**,
  state 那时还是旧值(旧代码读到的永远是初值 null,"＋ 建了笔记但不打开")。


## 功能现状(已交付,别重复造)

- **编辑器**:预览/源码**按栏独立**(编辑器条**右侧固定簇**里的那个按钮切换,不参与工具栏滚动);
  工具栏 **21 键**(6 组 + 4 弹层:标题 / 链接 / 表格 / 公式),另有 **2 个整篇动作**(预览/源码、保存)
  固定在右侧 —— 它们以前排在工具栏末尾,默认侧栏宽度下会被挤出可视区;
  右键菜单 = 「引用此处」+ 文本格式 / 段落设置 / 插入(**表内**右键换成插删行列);
  `[[` 补全(Tab 接受、不再多出 `]]`);图片粘贴/拖入;大纲面板;`Ctrl/Cmd+S/F/B/I/E`、
  `Ctrl+1…6/0`、表格内 Tab 跳单元格。
- **拖放语义**:从左栏拖笔记 → **落进正文 = 插入 `[[标题]]`**(不开标签)、**落到标签栏 = 新开标签**;
  拖到编辑区左右边缘带 = 落到对应分栏。
- **标签与分屏**:每栏自己的 `＋`;跨栏拖动、栏内按中线重排、空栏自动收;`Ctrl/Cmd+PageUp/Down`
  切栏(**+Shift** 把当前标签搬到另一栏);撤销按钮**先**回退"同一标签内的跳转历史"(点 `[[链接]]`
  跳走后,撤销回上一篇),没有再走文档撤销。
- **侧栏**:笔记树(右键菜单、拖拽)+ 纳入管理面板(最近 / 文件夹 / 已忽略 + 扫描范围 + 批量)
  + 回收站 + 大纲,四块共用一套 `ContextMenu` / panel 样式。
- **纳入管理 v0.4.0**:「最近」**默认按修改时间倒序**并显示时间;排序可选
  时间 / 名称 / 路径 / 大小 × 升降序(`src/client/scan-sort.ts`,纯函数带单测);
  扫描范围既能手打相对路径,也能点 **「选择目录…」浏览着挑**
  (`src/client/DirPicker.tsx` + `browse-path.ts`,种子 = 工作区根、不许走出工作区;
  Host 侧 `setScanRoots` 也接受绝对路径并再校验一次边界)。
  **不要用 `uiWorkspace.pickDirectory()`** —— 它要 `native` capability,本 profile 组合的是
  `browse` 后端,调用会被 `directory-picker/unavailable` 拒绝(实测);只用 `listDirectory`,
  而且拿不到该服务时**藏起入口**而不是报错。服务经 `main.tsx` 的 `ctx.get('uiWorkspace')`
  **可选**读取(不写进 `dsh.client.inject`,否则最小组合里整个插件起不来)。
- **分类可改名可删除 v0.4.0**:分类行右键 = 新建 / **重命名** / **删除**(二级菜单:
  「笔记移到上级分类」或「笔记留为未归类」)。删除**只动树里的归属**,磁盘上一个文件都不碰。
- **缺 `notes/` 的工作区**:空态卡片 —— 「创建 notes/」或「改用已有目录(按工作区相对路径)」。
- **字号/图标大小**:标题栏一个 `Aa`(五档预设 + 滑块 + 复位)→ `--dsh-notes-scale`,只作用于笔记区;
  基准字号**跟随**设置 → 通用的「字体大小」。改字号/图标相关的东西前先读上面那节。
- **不丢字**(2026-10-01 修):切模式/关标签/收分屏/切工作区/关页面都会把未保存的编辑交出去
  (见「编辑安全」1–3);`FS_STALE_VERSION` 撞上自己刚写的内容时自愈,不误报冲突。
- **点击落点**(2026-10-01 修):**软换行**的长段落里点哪一行就落在哪一行
  (以前"不管怎么点光标都在行首",见 `editor/click-hit.ts`);单视觉行仍走浏览器原生文本命中。
- **表内右键**(2026-10-01 修):删/插行落在**右键那一行**(以前首行删不掉、其余删的是上一行)。
- **表格里的 markdown 会渲染 + 正文永不横滚**(v0.4.0):单元格也走决策层(公式/加粗/行内码/
  高亮/双链都渲染);列多时**只有表格**出横向滚动条,正文一律自适应换行(照 Typora);
  渲染出来的图片跟着行宽缩放、保持长宽比。细节与三条必须同时成立的条件见「横向宽度」那节。
- **大笔记能存了**(v0.4.0 修):路由的 JSON 体上限原来是 64KB,而保存正文走的正是它 ——
  用户那篇 123KB 的笔记每次保存都只显示「Save failed」。上限提到 8MB。
- **改名/新建**(2026-10-01 修):改名后标签标题与路径跟着变、继续编辑能正常保存(以前保存报
  NOT_FOUND);树工具栏 ＋ 建了笔记会**自动打开**(以前不打开)。
- **浮层材质 + 文案**(2026-10-01 修):模态面板/菜单/弹层用宿主菜单材质(不再半透明穿透);
  widget 与快速打开的文案全部走字典(英文界面不再出现「复制」「⋯ 元数据」),
  `test/locale-guard.test.mjs` 会拦住以后再硬编码中文。
- **索引落盘**(2026-10-01 修):内容没变不写盘(以前每 ~8s 整份重写一次,因为 4s 轮询每次都刷
  `lastUsedAt`);一次写失败不再毒化后续(以前索引从此只活在内存里)。
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
| `lib/service.js` | 工作区解析与切换、扫描(目录前沿续走)、三类分类、回收站、守卫式保存;**每个工作区一份 registry**(`registryFor` / `persist(key)`) |
| `lib/store.js` | **存储位置决策 + 数据切片 + 路径记法(纯函数)**:工作区/机器本地路径、切片与合并、键的认领、**绝对 ⇄ 工作区相对的转换(`relativizeState` / `toAbsolute` / `toWorkspaceRel`)**;单测 `test/store.test.mjs` |
| `lib/registry.js` | 按工作区的薄索引(登记/忽略/忽略 glob/扫描根/最近使用) |
| `lib/notes.js` | 纯函数:路径 / frontmatter / 标题(=文件名)/ glob 匹配 / **`mtimeOfVersion`(版本号 → mtime)** / **`detectEol`·`applyEol`·`normalizeEol`** / `relativeToWorkspace` |
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
| `src/client/EditorArea.tsx` / `TabStrip.tsx` | 分栏渲染、标签条、拖动换栏(切回可见/改字号时 `requestMeasure`) |
| `src/client/EditorPane.tsx` | 单篇编辑器外壳:**载入 / 切模式重建、守卫式保存 + 卸载 flush + beacon、工具栏(固定右簇)、表格右键、装饰文案** |
| `src/client/editor/click-hit.ts` | 点击落点**纯函数**(视觉行夹取 + 行内二分),单测 `test/click-hit.test.mjs` |
| `src/client/TreePane.tsx` | 笔记树(拖拽载荷:`x-dsh-note-id` / `x-dsh-note-title` / `text/plain` = `[[标题]]`) |
| `src/client/CandidatesPanel.tsx` | 纳入管理面板(最近 / 文件夹 / 已忽略 + 排序 + 扫描范围;**目录选择入口**) |
| `src/client/scan-sort.ts` | 排序**纯模型**(时间/名称/路径/大小 × 升降序 + 时间显示),单测 `test/scan-sort.test.mjs` |
| `src/client/browse-path.ts` | 目录浏览器的**纯逻辑**(过滤 SKIP/隐藏项、相对化、面包屑夹取),单测 `test/browse-path.test.mjs` |
| `src/client/DirPicker.tsx` | 目录选择浮层(breadcrumb + 子目录;种子 = 工作区根;**不许走出工作区**) |
| `src/client/TrashPane.tsx` / `OutlinePane.tsx` / `QuickOpen.tsx` | 回收站 / 大纲 / 快速打开(`t` 由外壳注入,文案走字典) |
| `src/client/ContextMenu.tsx` | 共享右键菜单(分组 + 二级菜单 + 视口夹取) |
| `src/client/editor/setup.ts` | CM6 装配:主题、键位、输入规则、点击命中、工具栏命令、**widget 文案(`strings` 转发)** |
| `src/client/editor/decorate.ts` | 行内装饰 ViewPlugin(`safeBuild` 兜底) |
| `src/client/editor/table.ts` | 块级 StateField(chip / 表格 / 代码卡 / 公式)+ `tableTab`;**单元格用决策层渲染行内 markdown** |
| `src/client/editor/cell-inline.ts` | 单元格的**行内节点模型**(纯函数:扁平区间 → 嵌套树),单测 `test/cell-inline.test.mjs` |
| `src/client/editor/cell-render.ts` | 节点树 → DOM(公式走 Temml;认不出的 widget 退回原文) |
| `src/client/editor/selection.ts` | 选区包裹的纯逻辑(**必须用 `EditorSelection.range`**) |
| `src/client/editor/table-model.ts` / `blocks.ts` / `reference.ts` | 纯模型:表格解析 / **表内插删行列(`applyTableAction`)** / 块级插入规划 / 引用载荷 |
| `src/client/editor/media.ts` | 媒体地址工具(单独成模块是为打断 `decorate ⇄ setup` 循环依赖) |
| `src/client/editor/frontmatter.ts` | frontmatter 范围解析 + 打开笔记时的初始光标(`initialAnchor`) |
| `src/client/editor/mode.ts` | **源码模式的模块级开关**(装饰层缺省读它;分屏时按编辑器另传布尔值) |
| `src/client/icons.tsx` | 全部内联 SVG 图标(统一外壳 + 缩放契约:尺寸走 `cssSize`,漏了就是"只有折叠箭头不变大") |
| `src/client/api.ts` | 客户端 → `/dsh-notes/*` 的薄封装 |
| `src/client/styles.ts` | 全部 CSS(走主题 token:layer / border-l1-l2 / brand) |
| `scripts/build.mjs` | esbuild 打包(module loader 懒工厂格式;react 保持 external) |
| `scripts/build-graph.mjs` | 依赖环检查(改完客户端跑一次,要求 `cycles: 0`) |
| `cordis.patch.yml` | 安装进 profile 的 bundle patch(插入一行) |
| `test/` | `node --test` 单测(**250 条**):含 `store`(存储纯函数 + **相对路径往返/搬迁**)、`store-scope`(迁移/搬走工作区/只读/回收站/`.dsh-notes` 不被扫)、`service-scan-time`(**真 version token** 的时间排序)、`service-save-eol`(**行尾保真**)、`service-scan-roots`(扫描根的边界)、`browse-path` / `scan-sort` / `frontmatter`(CRLF 坐标) / `click-hit`(软换行落点)、`table-model`(表内插删行列)、`service-persist`(落盘去重/抗中毒)、`locale-guard`(双语文案守卫)、`platform-paths`(**跨平台路径方言 / 保留设备名靶子**,喂 Win32 输入) |

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
ln -s "$DSH_HOME/profiles/<profile>/node_modules" node_modules
```

原因:插件以 `link:` 装进 profile 后,Node 从**插件的真实路径**解析裸导入,
找不到 `@deepseek-ai/*`;指向 profile 的 `node_modules` 才有全套 harness 包。
所以**别在本目录跑 `npm install`** —— 那会生成真的 `node_modules` 并遮蔽符号链接,
表现为 `dsh-notes (dsh-notes): failed to import`(Host 半整行 inactive)。
构建工具链因此单独放在 `scripts/`(它有自己的 `package.json`)。

- 装/更新:用 `plugin_manager` 的 `install_bundle`(target = 本目录绝对路径),
  **不要**手写 profile 的 `package.json` / `cordis.patch.yml`,**不要**在 profile 里跑 pnpm。
- **改代码基本不用重启(2026-10-01 打通并实测)**,前提是 profile 里这两行配置:
  - **客户端半**:`npm run build` 写完 `lib/client.js` 后**连页面都不用刷** ——
    `dsh-client-hmr` 每 500ms stat 一次 bundle,变了就推新 `rev`,`dsh-client-modules` 就地换模块
    (实测:改一个字典值 → 已打开的页面里文案变了,`rev` 从 `07d32228578e` 变成 `ae363e1ce652`)。
    代价:组件内部 state 会丢,会话/工作区状态不丢。
  - **Host 半**(`lib/*.js`):profile 的 `hmr` 行 `root` 里加了本插件的
    `'<克隆下来的 dsh-notes 目录>/lib'`,改完约 1 秒自动重新导入并替换插件 fiber,**不用重启**
    (实测:临时加一条路由 → 立刻 200;删掉 → 立刻 404;全程 0 重启)。
  - **两个必须知道的边界**(都写进 profile 注释了,别再踩):
    1. `root` **只能给很小的子目录**。给插件根会让 chokidar(默认无限递归 + 跟随软链)递归整个工作区:
       实测 6530 个 inotify watch 且持续增长、永不 ready,把 WSL 的 drvfs/9p 打满,表现是
       **端口在听但永不应答**(systemd 仍显示 active,看起来像"启动不了")。只给 `lib/` 是 13 个 watch。
    2. **WSL 的 inotify 看不见 Windows 盘(如 `/mnt/<盘>`,drvfs)**:独立进程实测,ext4(`/tmp`、`/home`)能收到 `change`,
       那类挂载点下的目录收不到**任何**事件 → 必须开 `usePolling`(chokidar 的选项能经 config 透传,
       `schemastery` 会保留未声明的键,不用给 `@deepseek-ai/dsh-hmr` 打补丁);`interval: 1000`,
       实测 +0.5% 单核。
  - 仍然必须重启的:`package.json` / `exports` / 新增依赖 / profile patch 结构变化。
  - `lib/index.js` 与 `lib/*.js` 是 Host 半;**`lib/markdown-render.js` / `lib/markdown-syntax.js`
    是打包进 `lib/client.js` 的**,按客户端处理。
- 验完在 `cordis_inspect_query`(client `Slots`,root `sidebar.right.pane.tab`)里确认占用者含 `dsh-notes`;
  Host 侧看 `Config.listConfigs`(name=dsh-notes)的 `status` 必须是 `schema`,不是 `inactive`。

**排错与取证(都实测过):**

- 客户端崩溃/卡死时用**非压缩构建**拿真名栈:`DSH_NOTES_NO_MINIFY=1 npm run build`(随后务必
  再跑一次普通 `npm run build` 还原)。
- `createEditor()` 把 `EditorView` 挂在宿主元素上(`options.parent.__dshView`),浏览器里可直接
  核对"文档 / 选区 / 装饰"而不必靠反复点击试探。
- 只读决策层的行为用 Node 就能验(`test/markdown-render.test.mjs` 走真解析器),不要用截图当证据;
  热路径上的改动先用靶子用例红→绿,再动浏览器。

> **升级/重装依赖之后**:先在**工作区根**跑那三个补丁校验脚本(见根 `AGENTS.md`),
> 再重启 web —— 否则本机五组补丁可能已丢失(A2 临时组已于 2026-10-01 随 rc.2 退休)。

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
