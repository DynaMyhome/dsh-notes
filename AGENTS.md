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

## 身份、标题与多文档

- **标题 = 文件名**(Obsidian 模型)。正文里的 H1 只是正文,`[[链接]]` 也按文件名解析。
- `dsh-note-id` 只在**纳入那一刻**写入;预览模式把它收成一行「⋯ 元数据」chip
  (点一下展开源码)。保存时若发现 id 被删/被改,Host 会按索引**写回**并在响应里带
  `restoredId` —— 这是身份标识的兜底,`editor.idRestored` 会提示用户。
- **标签栏 + 左右分屏**:每栏一条自己的标签栏;布局按工作区存 localStorage
  (`dsh-notes:tabs:<workspaceKey>`),最多 8 个标签/栏;标签页保持挂载(切标签不重读盘)。
- **工作区切换**:内容路由都接受 `workspaceKey`(**只认已登记的**);用户侧写入的策略
  `policyFor` = **模式仍来自会话**(read-only 依旧只读),**边界根换成目标工作区根**。

## 位置决定(已实测,别再翻)

- DSH **左栏没有**给插件留内容插槽(`sidebar.workspaces` 由 ui-workspace 独占,强占即 `shadows-shipped-ui`)。
- 右栏 `sidebar.right.pane.tab` 是**按 tab 类型 id 派发**的加法插槽 → 笔记树 + 编辑区都放在**一个** tab 内部。
- 右栏 tab 是 **session 作用域**;因此树内容按**工作区**(`sessionId → session.header.cwd`)取,布局按会话。
- `.md` 的官方渲染实现是 `documentPreviews` 的 `…/markdown`(priority `builtin`);将来若要接管
  文件树里的 `.md` 预览,注册 `priority:'extension'` 的同扩展实现即可,不必改核心。

## 目录

| 路径 | 作用 |
| --- | --- |
| `lib/index.js` | Host 半:配置、索引、路由(`/dsh-notes/*`)、`knowledge` 工具 |
| `lib/notes.js` | 纯函数:路径 / frontmatter / 标题(=文件名)/ glob 匹配 |
| `lib/service.js` | 工作区解析与切换、扫描(目录前沿续走)、三类分类、回收站 |
| `lib/client.js` | **构建产物**,勿手改(`npm run build`) |
| `src/client/` | 客户端源码:区域外壳、树、纳入管理面板、标签/分屏、编辑器、样式 |
| `src/client/editor/tabs.ts` | 标签/分栏**纯模型**(打开/关闭/移栏/持久化),单测在 `test/tabs.test.mjs` |
| `src/client/editor/media.ts` | 媒体地址工具(单独成模块是为打断 `decorate ⇄ setup` 循环依赖) |
| `scripts/build-graph.mjs` | 依赖环检查(改完客户端跑一次,要求 `cycles: 0`) |
| `scripts/build.mjs` | esbuild 打包(module loader 懒工厂格式;react 保持 external) |
| `cordis.patch.yml` | 安装进 profile 的 bundle patch(插入一行) |
| `test/` | `node --test` 单测 |

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
- 改了客户端 → 重新 `npm run build` 后 `web_restart` + 刷新页面;改了 Host 半 → `web_restart`。
- 验完在 `cordis_inspect_query`(client `Slots`,root `sidebar.right.pane.tab`)里确认占用者含 `dsh-notes`;
  Host 侧看 `Config.listConfigs`(name=dsh-notes)的 `status` 必须是 `schema`,不是 `inactive`。

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
