# dsh-notes — 项目规则(agent 必读)

DSH 的**笔记工作区**插件:右侧栏一个独立「笔记」区域(内部 = 可收起的笔记树 + Markdown 编辑器)。
笔记就是**普通 `.md` 文件**;索引只是一层**薄映射**。

## 四条硬不变量(改动前先读)

1. **永不删除、永不移动用户的 `.md`。** 插件只做三种写入:保存笔记内容(守卫式,带
   `expectedVersion`)、新建笔记文件、写资产文件。文件级删除/移动/改名仍归文件树与
   Agent 的通用文件工具。UI 里的「移除」= 只删索引条目。
2. **Markdown 是权威,索引是可重建的派生态。** 索引在
   `$DSH_HOME/knowledge/registry.json`(或 `Config.storeDir`);笔记身份靠 frontmatter 里的
   `dsh-note-id`,索引丢了用 `rescan` 恢复。索引**绝不**反向复活已删除的文件,也不做回收站。
3. **只有一套内容工具。** 读/写/改/搜继续用 `read` / `write` / `edit` / `glob` / `grep` / `bash`;
   本插件只额外提供 `knowledge` 工具(登记/注销/归类/分类树/未归类/重扫)。不许再长一套 note CRUD。
4. **不改 DSH 核心。** 只用官方扩展点:`ctx.sidebarRightTabs` / `ctx.slots`(`sidebar.right.pane.tab`)、
   `webServer.register`(自鉴权)、`fs`(守卫式写入)、`workspaceFiles`(只读 Remote)。权威接口面以
   `cordis_inspect_list` / `cordis_inspect_query` 与已安装包的 `lib/types/*.d.ts` 为准。

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
| `lib/client.js` | **构建产物**,勿手改(`npm run build`) |
| `src/client/` | 客户端源码:区域外壳、树、编辑器、样式 |
| `scripts/build.mjs` | esbuild 打包(module loader 懒工厂格式;react 保持 external) |
| `cordis.patch.yml` | 安装进 profile 的 bundle patch(插入一行) |
| `test/` | `node --test` 单测 |

## 开发与验证

```bash
cd "<你克隆 dsh-notes 的目录>"
npm install                 # 只为构建:esbuild
npm run build               # src/client → lib/client.js
node --check lib/index.js && node --check lib/client.js
node --test test/*.test.mjs
```

- 装/更新:用 `plugin_manager` 的 `install_bundle`(target = 本目录绝对路径),
  **不要**手写 profile 的 `package.json` / `cordis.patch.yml`,**不要**在 profile 里跑 pnpm。
- 改了客户端 → 重新 `npm run build` 后 `web_restart` + 刷新页面;改了 Host 半 → `web_restart`。
- 验完在 `cordis_inspect_query`(client `Slots`,root `sidebar.right.pane.tab`)里确认占用者含 `dsh-notes`。

> **升级/重装依赖之后**:先在**工作区根**跑那四组补丁校验脚本(见根 `AGENTS.md`),
> 再重启 web —— 否则本机六组补丁可能已丢失(尤其 A2 临时组,仅 0.2.0-rc.1 需要)。

## 事实来源

运行中的 harness(`cordis_inspect_list` / `cordis_inspect_query`)与已安装包的
`lib/types/*.d.ts` 是权威,不是本文档,也不是记忆。
