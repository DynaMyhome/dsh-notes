# 更新记录

本插件按 [语义化版本](https://semver.org/lang/zh-CN/) 打 tag;`v0.2.0` 是**首个带 tag 的发布**
(0.1.0 是开发期的初始版本,当时没有打 tag,仓库里也没有 release)。

## v0.5.1 — README 有图了:8 张真实界面截图 + 市场截图声明(2026-10-02)

### 文档

- **README 从纯文字变成"看图就懂"**:页首一张区域全貌,新增 `## 界面预览` 一节,按功能段落排 7 张截图
  (预览模式 / 表格公式代码卡 / 标签与分屏 / 大纲与快速打开 / 纳入管理 / 分类右键 / 回收站)。
  截图取自**运行中的插件本体**(DSH 中文界面),示例内容是一套虚构的「星图 Aster」知识库 ——
  不含任何真实笔记、会话、路径或机器信息(回收站面板里那行绝对路径已抹掉)。
- 新增仓库根的 **`screenshots.json`**:8 条相对路径,顺序即画廊顺序。插件市场(dsh-market)按它展示
  App Store 风格截图;不声明时市场只能"从 README 里抓图",声明后能控制顺序与取舍。
  路径相对该文件本身、不以 `/` 开头、不含 `..`,符合
  [awesome-dsh-plugin 的截图约定](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)。

### 变更

- 版本 `0.5.0` → `0.5.1`:**只有文档与截图声明,没有代码改动**(`lib/` 与 `src/` 一行未动,`lib/client.js` 未重建)。
- 图片放 `docs/images/`,8 张 PNG、1217×1028、合计约 1.1 MB;`package.json.files` 白名单不变
  (`private: true`,本轮不发 npm)。

### 隐私清理(同日补,2026-10-02)

仓库转 public 之后复查了**全部公开文件**,把与本机布局相关的字符串清掉(**只改字符串,不改行为**):

- 本机绝对路径 → 中立写法:`/mnt/<盘>/.../dsh-notes` → `<你克隆 dsh-notes 的目录>`;
  `/home/<user>/.dsh/profiles/web/node_modules` → `$DSH_HOME/profiles/<profile>/node_modules`;
  `/mnt/<盘>/...` 这类举例 → 「Windows 盘(`/mnt/*`)」/「很长的磁盘路径」。
- 涉及:`AGENTS.md`、`README.md`、`CHANGELOG.md`、`src/client/editor/setup.ts` 的注释、
  `lib/service.js` 的注释,以及 `test/*.mjs` 里当假数据用的绝对路径(`/home/user` → `/home/user`,
  `/mnt/<盘>/...` → `/data/...`;断言只看"是不是绝对路径",不依赖具体值)。
- 复核:`npm test` **238 条全绿**、`node scripts/build-graph.mjs` `cycles: 0`、
  `node --check` 通过;`npm run build` 重建后 `lib/client.js` **逐字节不变**(注释进不了产物)。
- 仍然保留(有意):`LICENSE` 的作者署名 `Phy-D`、仓库/包名 `DynaMyhome/dsh-notes`、
  `$DSH_HOME` 这类公开约定的环境变量。

## v0.5.0 — 插件卡片终于显示「笔记工作区」/ 删掉从不生效的 meta 字段 / 补齐许可证与规范化(2026-10-01)

### 修

- **`设置 → 插件` 卡片标题一直显示包名 `dsh-notes`,本地化从未生效。**
  根因是两处形状都不对:
  - `package.json` 里的 `meta: {title, description}` **根本不是 DSH 读的字段** ——
    `dsh-app-boot` 的 `readPluginMeta()`（`lib/index.js:1969`）只读 `manifest.icon` /
    `manifest.name` / `manifest.description` 与 `locale/<lang>.json`；已在 **0.1.7-alpha.1 与
    0.2.0-rc.2 两个 runtime** 里 grep 确认没有任何代码读 `manifest.meta`。
  - `locale/{en,zh}.json` 写成了**根级** `title` / `description`，而读取端（`dictionariesOf()`）
    读的是 **`parsed.meta.title` / `parsed.meta.description`** —— 于是整个字典被当成"没有 title"，
    标题退回 `manifest.name`（包名），描述退回 `manifest.description`（中文描述就这样"看起来是对的"，
    掩盖了问题）。
  修法：locale 两份改成规范形状 `{"meta":{"title","description"}}`；**删除 `package.json.meta`**
  （内容已搬进 locale，不留一个从来没人读的字段误导后来人）。

### 变更

- **补 `license` / `repository` / `homepage` / `bugs` 字段**与 **`LICENSE` 正文**（MIT © 2026 Phy-D）：
  此前 `package.json` 既没有 `license` 字段、仓库里也没有许可证正文。
- **新增 `.gitattributes`**（`* text=auto eol=lf` + 二进制保护）：本插件的开发目录挂在
  Windows 盘（WSL 的 `/mnt/*`）上，工作树被 Windows 侧工具改成 CRLF 时，`git diff` 会整文件重写、真实改动被淹没
  （`dsh-restart-manager` 上实测过 719 增 / 719 删而真实差异为 0）。
- `files` 白名单：`locale` → `locale/*.json`（与其他插件一致），补 `LICENSE`。
- 版本 `0.4.0` → `0.5.0`。`private: true` **保留**（只挡 `npm publish`，不影响 `git`/`link:` 安装，
  本项目也从不走 npm 发布）。

### 文档更正（重要，与本插件代码无关但会误导人）

- **`dsh.client.inject` 不是"信息性字段"。** 早先 README 沿用了 `dsh-device-center` 的说法
  （"框架不校验"），**那是错的**：`@deepseek-ai/dsh-client-modules` 会校验它
  （`optionalStringArray(pkgName, "dsh.client.inject", decl.inject)`），并把它同时用作
  ①客户端模块图的**到达前置**（`arriveGraphRow` 先 `await` 完 `row.inject` 里的依赖）与
  ②客户端插件 fiber 的 `inject`（即**要等这些客户端服务就位才激活**）。
  所以这份清单必须**只列这个 bundle 真正必需的服务**；凡是"有就读、没有就算了"的可选服务
  （本插件的 `uiWorkspace` 就是）**绝不能写进去**，否则最小组合里整个插件起不来 ——
  这正是 `AGENTS.md`「服务经 `ctx.get('uiWorkspace')` 可选读取（不写进 `dsh.client.inject`）」
  那条注释的由来。本插件现有三项
  （`dsh-client-locale` / `dsh-client-ui-slots` / `dsh-client-ui-sidebar-right`）
  恰好等于 `lib/client.js` 自己的 `exports.inject`，**保持不变**。

### 实测

- `设置 → 插件` 卡片显示「笔记工作区 / Notes workspace」与自有图标（此前是包名 + 通用占位图标）。
- 客户端槽位实地核对：`cordis_inspect_query`(client `Slots`, root `sidebar.right.pane.tab`)
  的 occupants 里 `dsh-notes` **`active: true`**。
- 宿主半实地核对：`/dsh-notes/tree` 返回 **401**（路由在、自建鉴权拦下；未知路径是 404）。
- `npm test`（238 条）与 `node scripts/build-graph.mjs`（cycles: 0）保持全绿。

## v0.4.0 — 可点选目录 / 排序与时间修正 / 分类可改名可删除 / CRLF 笔记打不开 / 索引改记相对路径(2026-10-01)

### 修

- **新建分类立刻报「分类不存在」** —— 行身份取错了字段:`TreePane` 里行内改名用的是
  `row.id`,而 `Row` 上**从来没有这个字段**(取出来是 `undefined`),于是
  `renameCollection(ws, undefined, name)` 返回 false,Host 抛「分类不存在」。
  新建分类走的是"先建默认名、再立刻进 行内改名",所以看起来是**一建就报错**。
  改成从行 key 上取 id(`c:<id>` / `n:<id>`,笔记那条分支本来就是这么写的)。
  旁证:用户树里那 5 个还叫「新分类」的分类,就是这条的症状。
- **「最近」其实不是按时间排** —— Host 用 `Number(entry.version)` 当 mtime,而真 provider
  (`@deepseek-ai/dsh-fs-local`)的 version 是 `` `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}` ``,
  `Number(...)` 是 NaN → `at` 恒为 0 → 全部并列 → **实际按路径排**。现在按严格形状解析第 4 段
  (mtimeNs),认不出的形状一律 0(回落路径序,绝不瞎猜)。**测试替身一直给
  `String(mtimeMs)`,所以这条在单测里永远测不出来** —— 新测试改用真形状,与运行时同构。
- **打开 CRLF 笔记报 `Selection points outside of document`** —— CM6 的
  `EditorState.create({ doc })` 用 `/\r\n?|\n/` 切分重建,CRLF 文件的 `doc.length`
  **比磁盘原文少掉「CR 的个数」**;`initialAnchor` 拿原文长度当坐标,而那一处
  `dispatch({selection:{anchor}})` 又是全项目唯一**没夹取**的。用户那篇 123KB / 1244 个 CR
  的笔记正中:状态栏以前显示 75404,现在是 **74160**(= 75404 − 1244)。
- **保存会静默把 CRLF 改成 LF** —— `fs.writeText` 是原样写(不像官方 `editText` 会
  `restoreLineEndings`)。现在保存前采样文件头判断行尾并按原风格写回;
  `FS_STALE_VERSION` 交出去的 `currentText` 也归一成 LF —— 否则 CRLF 笔记上
  "磁盘内容 == 我正要写的内容"那条自愈分支永远不成立,会误报外部修改。
- **超过 64KB 的笔记根本存不下去** —— 路由的 JSON 请求体上限是 64KB,而 `save` 走的正是它:
  用户那篇 123,530 字节的笔记每次保存都被挡住,界面只显示「**Save failed**」,
  真正的原因(`请求体过大`)藏在响应里。上限提到 8MB(本地同源路由、自带鉴权,
  笔记是纯文本;资产那条本来就是 16MB)。靶子用例:一条 >128KB 的 body 必须 200。
- **表格里的 markdown 完全没渲染** —— 单元格以前是 `td.textContent = cell.text`,
  于是 `**加粗**`、`$公式$`、`==高亮==`、`` `代码` ``、`[[双链]]` 在表格里全是**原文**。
  现在每格单独跑**决策层**再落成 DOM(见 `editor/cell-inline.ts` / `cell-render.ts`)——
  规则不在第二处重写,"该藏还是该露"仍然只有决策层说了算。公式走 Temml(与正文同一个渲染器)。
- **表格列一多就把整篇顶宽**(分屏时正文也得左右拖) —— 两个原因是叠加的:
  ① 单元格里的长文本不换行,把列撑到几千像素;
  ② **`.cm-content` 是 CM6 的 flex item**(`flex-grow:2; flex-shrink:0`),
  它的 `min-width:auto` 等于**min-content 宽度** —— 宽表格的 min-content 把内容区撑到比滚动区还宽
  (实测:滚动区 384px、内容区 687px),于是**连正文都在 687px 上换行**。
  修法:**表格自己滚**(外壳 `overflow-x:auto; max-width:100%`)+
  **内容区 `min-width:0`**(让正文老老实实等于滚动区宽度)+ 单元格换行。
  现在照 Typora:正文一律自适应、**没有横向滚动条**;只有表格在列多时出横向滚动条。
- **渲染出来的图片不跟着横向宽度自适应** —— `inline-flex` 外壳的宽度是由图片本身决定的,
  子元素再写 `max-width:100%` 只是"相对自己"的空转,一张 2000px 宽的图照样把正文顶宽。
  现在外壳也带 `max-width:100%`(百分比相对**行/内容区**解析,这才是真约束),
  图片 `max-width:100% + height:auto`(只缩不放、保持长宽比)。

### 新增

- **「选择目录…」:扫描范围不再只能手打。** 面板内浏览器(面包屑 + 子目录列表,
  种子 = **工作区根**,且不许走出工作区;点目录/`SKIP_DIRS` 不给,免得选了也是空的)。
  数据来自官方 `uiWorkspace.listDirectory`;拿不到该服务时按钮**不出现**(官方口径:
  藏起入口而不是失败)。**特意没用 `pickDirectory()`** —— 它要 `native` capability,
  而本 profile 组合的是 `browse` 后端,调用会被 `directory-picker/unavailable` 拒绝(实测)。
- **排序**:候选/杂项两段支持 时间 / 名称 / 路径 / 大小 × 升降序;「最近」默认**时间倒序**;
  每行显示修改时间(认不出时间的文件不显示那列 —— 不拿假时间骗人)。
- **分类右键:重命名 + 删除**。删除**只动树**(索引里的归属),磁盘上一个文件都不碰:
  「笔记移到上级分类」或「笔记留为未归类」。二级菜单本身就是二次动作,不再弹窗确认。
- **扫描范围接受绝对路径**:Host 侧换算成工作区相对,并拒绝工作区**外**的目录
  (否则"多看一个目录"就变成越界读用户主目录)。

### 存储:索引改记**相对路径**

`<工作区>/.dsh-notes/index.json` 里,笔记与笔记根从绝对路径改成**工作区相对**
(`notes[].rel` / `workspaces[].notesRootRel`);只有 `workspace.root` 保持绝对 —— 它是锚点,
也是工作区键的来源。

- **为什么**:这个文件就躺在工作区里,它记的每一篇笔记必然在工作区内,记绝对路径等于把
  "这台机器的盘符和目录名"抄进用户数据。v0.3.0 的搬迁能力其实是靠装载时那一趟
  `rebasePath` 硬扳回来的;改成相对之后**搬迁 = 零操作**(同一个文件在新根下直接就是对的),
  文件也不再泄漏机器路径。
- **迁移**:旧文件(绝对 `path`)装载时自动补出 `rel`,下次落盘即迁移完;键与 `root` 的认领逻辑不变。
- **例外**:`storeScope: 'home'`(机器本地一份整体索引,里面装着多个工作区与跨工作区映射)
  仍然用绝对路径 —— 那里只有绝对路径说得清"是哪个文件"。
- 一处刻意的区分:`notesRootOverrideRel` 用 `'.'` 表示"显式设成工作区根",因为 `''` 在
  这个字段上的含义是"**没设过**";不区分的话往返一趟就丢(用户显式选过的笔记根会变回默认)。

### 工程

- 单测 184 → **238** 条;`node scripts/build-graph.mjs` cycles 0。
- 新增 `src/client/scan-sort.ts`(排序纯逻辑)、`src/client/browse-path.ts`(目录浏览器纯逻辑)、
  `src/client/DirPicker.tsx`;`src/client/editor/cell-inline.ts`(单元格行内**节点模型**,纯函数)、
  `cell-render.ts`(落成 DOM);`lib/notes.js` 新增 `mtimeOfVersion` / `detectEol` / `applyEol` /
  `normalizeEol` / `relativeToWorkspace`;`lib/store.js` 新增 `relativizeState`。
- **Host 半热重载打通**(本轮实测,profile 侧配置):给 `hmr` 行的 `root` 加上本插件的
  `lib/` 目录,改 Host 代码约 1 秒后自动热替换插件条目,**不用重启**;客户端半一直走
  `dsh-client-hmr` 的 500ms bundle 轮询,改完 `npm run build` 已打开的页面**自动换新**(不用刷)。
  两个坑都写进了 profile 注释:
  1. `root` 只能给**很小的子目录**。给插件根会让 chokidar(默认无限递归 + 跟随软链)把整个工作区
     递归进去 —— 实测 6530 个 inotify watch 且持续增长、永不 ready,把 WSL 的 drvfs/9p 打满,
     表现是**端口在听但永不应答**(systemd 还显示 active)。只给 `lib/` 是 13 个 watch。
  2. **WSL 的 inotify 看不见 `/mnt/<盘>`(drvfs)**:独立进程实测,改 ext4(`/tmp`、`/home`)能收到
     `change`，改 Windows 盘（`/mnt/*`）下的目录收不到**任何**事件。所以必须开 `usePolling`
     (chokidar 选项能经 config 透传:`schemastery` 会保留未声明的键,不用给
     `@deepseek-ai/dsh-hmr` 打补丁);`interval: 1000`,实测代价 **+0.5% 单核**。

## v0.3.0 — 插件数据跟着工作区走(2026-10-01)

**破坏性存储变更,带自动迁移。** 插件的**语义数据**(分类树、笔记归属、忽略规则、置顶、
跨工作区映射、回收站)从用户主目录搬进**工作区自己**的 `.dsh-notes/`:

```
<工作区>/
├── notes/                  # 笔记(不变)
├── .dsh-assets/            # 图片资产(不变)
└── .dsh-notes/             # 新增:插件数据(自动写 .gitignore,不进 git status)
    ├── index.json          #   薄索引
    └── .trash/             #   回收站(文件本体 + trash.json)
```

为什么:以前这些数据在 `$DSH_HOME/knowledge/registry.json` —— **用户主目录**。备份工作区、
或把工作区搬到另一台机器,数据不跟着走,得从头组织一遍。现在整份拷过去、装上同一个插件就能原样读出来。

### 变化

- **跟着工作区走**:备份 / 迁机 / 改路径之后,分类树、归属、忽略规则、置顶、跨工作区映射、
  回收站(可恢复的删除)全都在。
- **路径自动重定位**:索引里记的是绝对路径;工作区换路径后,装载时按旧根的相对位置**重定位**到新根,
  不会留下一堆指向老机器的死路径(这条不做的话,"搬走的工作区"是打不开的)。
- **升级零操作**:第一次打开工作区时,把旧 `registry.json` 里属于它的切片自动迁进
  `.dsh-notes/index.json`,**旧文件原样保留**作备份;已知工作区列表改存 `$DSH_HOME/knowledge/workspaces.json`。
- **机器本地只剩**扫描缓存(`index/<key>.json`,派生数据)与"这台机器见过哪些工作区"。
- **`storeScope: home`** 逃生开关:完全回到旧行为(只读挂载、共享仓库、应急回退时用);
  `knowledge` 工具新增 **`migrate`** op(`toWorkspace` / `toHome`),在两个位置之间**显式搬运**
  (移动语义,不留两半)。
- **只读工作区**:读路径(对账/扫描)只记一次日志、不抛,界面仍能用内存里的索引;
  用户**显式写操作**才如实报错。
- **`.dsh-notes/` 永不被扫描**:走目录时跳过所有点目录,所以回收站里的 `.md` 不会被当成候选笔记
  重新登记回树(回收站搬进工作区的前提)。
- **标签/分屏布局、字号**刻意留在浏览器 `localStorage`(设备形状的偏好,不跟着工作区跑)。

### 工程

- 新增 `lib/store.js`(存储位置决策 + 数据切片,纯函数)与 `test/store.test.mjs`(9 条)、
  `test/store-scope.test.mjs`(8 条:迁移 / 搬走工作区 / 只读 / 回收站 / 点目录不被扫 / 两种形态等价)。
- 单测 **184 条**(v0.2.0 是 164 条),`build-graph` cycles 0。

## v0.2.0 — 首个正式版本(2026-10-01)

从 0.1.0 起累计 40 个提交:P0–P6 全部落地,并修完两个只读审计会话里**核实过**的 9 条缺陷。

### 新增

- **笔记区域常驻**:侧栏切到别的 tab / 收起整栏,笔记区只是被藏起来(注册时 `keepMounted: true`)——
  笔记树、打开着的标签、光标与滚动都在原处,切回来不再重新拉一遍;隐藏期间不轮询,回来立刻对一次账并让编辑器重量尺寸。
- **字号 / 图标大小可调**:标题栏 `Aa`(五档预设 + 滑块 + 复位),只作用于笔记区;
  基准字号**跟随**宿主「设置 → 通用 → 字体大小」。统一公式 `cssSize() = calc(Npx × 系数 + 增量)`,不用 `zoom`(会把浮层坐标推偏)。
- **笔记树 + 纳入管理面板**:工作区里的 md 分三类(笔记 / 候选 / 杂项);面板按最近改动或文件夹分组,
  可搜索、多选、批量纳入/忽略,并显式管理**扫描范围**(默认只扫 `notes/`)。
- **标签栏 + 左右分屏**:每栏一条自己的标签栏;点=替换、Ctrl/Cmd+点击或中键=新标签、
  拖标签或 ⇥ 分屏;跨栏拖动、栏内按中线重排、空栏自动收;布局按工作区记住。
- **编辑器**:预览/源码**按栏独立**;工具栏 21 键(6 组 + 4 弹层:标题 / 链接 / 表格 / 公式);
  右键菜单(引用此处 / 文本格式 / 段落设置 / 插入,**表内**换成插删行列);`[[双链]]` 补全;
  图片粘贴与拖入;**真表格**就地编辑;代码卡片(语言可改、一键复制);块级公式;frontmatter 收成一行元数据 chip;
  `Ctrl/Cmd+S/F/B/I/E`、`Ctrl+1…6/0`、表格内 Tab 跳单元格。
- **大纲面板**:标题树,可拖拽重排整节(纯文本级搬移)。
- **快速打开**:区域内 `Ctrl/Cmd+P`(也接受 `Ctrl/Cmd+K`)。
- **回收站**:删除 = 移入 `$DSH_HOME/knowledge/trash/` 并移出索引,可恢复、可彻底删除(两次确认)。
- **工作区切换**:能切到别的**已登记**工作区(或输入绝对路径打开新目录),各自有独立的树与布局;
  工作区没有 `notes/` 时给空态卡片(创建 / 改用已有目录)。
- **Agent 侧**:新增 `knowledge` 工具(登记 / 注销 / 归类 / 分类树 / 未归类 / 重扫 / 候选与忽略 / 回收站),
  内容读写仍然只用 DSH 既有的文件工具。

### 修复

- **软换行上点击塌回行首**(用户报):粘贴进来的长段落折行后,不管点哪一行光标都跳到行的前面。
  根因是命中判定把"不在同一视觉行"当成"点在更前面",二分一路塌到行首;现在按视觉行夹区间 + 行内二分,
  并优先使用浏览器自身的文本命中。
- **切「预览/源码」丢未保存的编辑**:载入 effect 的依赖里带着模式,切模式即销毁重建并**重读磁盘**,
  800ms 自动保存窗口里刚打的字被磁盘内容覆盖。现在切模式用**当前文档**重建,不重读。
- **关标签 / 收分屏 / 切工作区不落盘**:卸载前没有 flush。现在 cleanup 先取文本再销毁并保存,
  另外关页面 / 切后台走 `navigator.sendBeacon` 尽力落盘。
- **表格「删行」删错行**:行号语义改成「数据行 = tbody 下标(0 起),表头 = -1」——
  以前首行删不掉、其余删的是上一行。
- **改名后标签失联**:`refresh` 依赖写漏,一直调用旧闭包,改名后标签标题/路径不更新,
  继续编辑保存会报 `NOT_FOUND`;现在改名即时生效,新建笔记也会自动打开。
- **索引每 ~8s 整份重写、一次写失败永久失效**:`persist()` 现在内容没变就不写盘,
  写失败只记日志、不毒化后续;`lastUsedAt` 只在会话**换**工作区时更新(轮询不再刷它)。
- **浮层半透明穿帮**:本主题的 `bg-*` 都是半透明,面板/菜单/弹层改用与宿主菜单同一套材质
  (`--dsw-specific-menu` + `backdrop-filter`),背后正文不再可读。
- **关键按钮被挤出屏幕**:工具栏默认宽度下 `scrollWidth` 是 `clientWidth` 的两倍,
  「预览/源码」与「保存」在可视区外、标题被压成 30px;现在这两个整篇动作固定在编辑器条右侧,标题不再被压缩。
- **英文界面混中文**:代码卡的「复制」、元数据 chip、快速打开的占位符等以前写死中文,现在全部走字典
  (并有守卫测试盯着:双字典键必须一致、英文值不许含中文、DOM 文案不许硬编码中文)。
- **编辑期稳定性**(更早几轮):`wrapSelection` 用普通对象冒充选区导致"设一次格式就卡死";
  表格重影与吞掉紧跟段落的行;点击正文时光标漂一行;右键菜单项点击无响应;拖拽高亮卡住;
  分屏切源码后另一栏行内装饰全丢。

### 安全与可靠性

- 四条硬不变量写进 `AGENTS.md`:**永不删除、永不移动用户的 `.md`**(只有"改名"与"移入回收站"两处显式例外,
  且彻底删除要两次确认);Markdown 权威、索引是可重建的派生态;只加一个 Agent 工具;不改 DSH 核心。
- 保存是**守卫式**的(带 `expectedVersion`),并有身份自愈:frontmatter 里的 `dsh-note-id` 被删/被改时,
  Host 会按索引写回并在响应里带 `restoredId`。

### 工程

- `npm test`:164 条单测(纯模型/决策层与运行时同构解析),含落点、表格、索引落盘与双语文案的守卫用例。
- `node scripts/build-graph.mjs`:依赖环 `cycles: 0`。
- `AGENTS.md` 同步四条渲染管线硬规则、常驻正文 + 字号缩放、编辑安全五条与目录表;`README.md` 补手感说明;
  项目管理层(`.agent-context/`)的记忆与架构图已刷新。

## v0.1.0 — 初始开发(未打 tag)

右侧栏「笔记」区域骨架、索引与 `/dsh-notes/*` 路由、CodeMirror 6 编辑器与守卫式保存、
树操作与大纲、纳入管理面板,以及本工作区的安装方式(`link:` + profile bundle patch)。
