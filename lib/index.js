/**
 * dsh-notes — Host 半。
 *
 * 职责边界(整个项目唯一的硬约束):
 *   - 本插件**永不删除、永不移动用户的 .md**。它只做三种写入:
 *       1) 保存笔记内容(守卫式:带 expectedVersion,冲突就报错而不是覆盖);
 *       2) 新建笔记文件(用户点「新建笔记」时);
 *       3) 写资产文件(粘贴/拖入的图片)。
 *   - Markdown 是权威;语义索引在**工作区自己**的 `<工作区>/.dsh-notes/index.json`
 *     (v0.3.0 起跟着工作区走,机器本地只剩派生缓存与"见过哪些工作区"),可重建(rescan)。
 *   - 内容操作继续用既有文件工具(read/write/edit/glob/grep/bash);
 *     本插件只额外提供一个 `knowledge` 工具(登记/注销/归类/分类树/未归类/重扫)。
 *
 * 装配:NoteService(索引+IO+监视)→ 同源路由(/dsh-notes/*)+ knowledge 工具。
 *
 * @module dsh-notes
 */

import z from '@deepseek-ai/schemastery'

import { installRoutes } from './routes.js'
import { NoteService } from './service.js'
import { installTool } from './tool.js'

/** 插件名(diagnostics;cordis 约定)。 */
export const name = 'dsh-notes'

/**
 * 必需的 Host 服务。
 *
 * `fs` 是唯一的文件通道(带版本号与文件策略);`tools` 用于注册 `knowledge`;
 * `sessions` 用于把会话解析成工作区根;`sandboxPolicy` 用于把**用户自己的**沙箱模式
 * 交给 `fs.writeText` —— 不给策略时会被按默认边界拒绝(实测
 * `FS_SANDBOX_DENIED: file access denied under workspace-write mode`)。
 * 可选的 `webServer` / `connection` 走 `ctx.inject([...])`,以便没有 web 载体时
 * 插件仍能装载(索引与工具仍可用)。
 */
export const inject = ['fs', 'tools', 'sessions', 'sandboxPolicy']

/** 配置(profile 的 cordis.patch.yml 可逐项覆盖)。 */
export const Config = z.object({
  /** 笔记根目录:相对工作区根。默认 `notes`。 */
  notesDir: z.string().default('notes'),
  /** 粘贴/拖入图片的托管目录:相对工作区根,内部按 noteId 分子目录。 */
  assetsDir: z.string().default('.dsh-assets'),
  /** 索引目录:留空 = `$DSH_HOME/knowledge`。**只影响机器本地那一份**(扫描缓存 / 已知工作区表 / `home` 形态的整体索引)。 */
  storeDir: z.string().default(''),
  /**
   * 插件的**语义数据**(分类树 / 笔记归属 / 忽略 / 置顶 / 回收站)放在哪。
   *
   * - `workspace`(默认):`<工作区>/.dsh-notes/` —— **跟着工作区走**。备份工作区、或把它搬到
   *   别的机器/别的路径,装上同一个插件就能原样读出来(旧的整体索引在首次打开该工作区时自动迁进来)。
   * - `home`:旧行为,全部塞在 `$DSH_HOME/knowledge/registry.json`。用于只读/共享仓库,或应急回退。
   */
  storeScope: z.union(['workspace', 'home']).default('workspace'),
  /** 「未归类」扫描的最大深度。 */
  unfiledDepth: z.natural().default(3),
  /** 「未归类」一次最多返回的条数(超出显式截断)。 */
  unfiledMax: z.natural().default(200),
  /**
   * 分类缓存的保鲜期(毫秒):取树时若缓存比它旧,**后台**重扫一次。
   *
   * 走一遍目录在 /mnt/<盘> 这类盘上按秒计,所以既不能挂在每次取树上(会卡界面),
   * 也不能只靠文件监视(本机 WSL/drvfs 实测监视回调不触发)。TTL + 客户端 4s 轮询
   * 保证「外部改动最多 TTL+4s 后出现在界面上」。
   */
  scanTtlMs: z.natural().default(8000),
  /** 自动保存的静默毫秒数;0 = 关闭自动保存。 */
  autosaveMs: z.natural().default(800),
  /** 粘贴图片策略:`copy`(复制进托管目录)或 `link`(保持原路径)。 */
  pasteImage: z.union(['copy', 'link']).default('copy'),
  /**
   * 走一遍**整个工作区**找候选 md(纳入管理面板用)的最大深度 / 文件数 / 保鲜期。
   *
   * 这一遍比 notesDir 那一遍贵得多(实测本机 1268 目录),所以 TTL 长、且只在
   * 打开面板或显式重扫时才同步跑;`tree()` 只读缓存。
   */
  scanDepth: z.natural().default(8),
  scanMaxFiles: z.natural().default(5000),
  scanMaxDirs: z.natural().default(3000),
  /**
   * 一次「走目录」的时间预算(毫秒)。到点就收手并把队列前沿留在内存里,
   * 下次调用接着走 —— 前端会一直拉到走完为止(面板显示进度)。
   */
  walkBudgetMs: z.natural().default(4000),
  workspaceScanTtlMs: z.natural().default(60000),
  /**
   * 进入「还没有笔记根目录」的工作区时自动创建它(默认关)。
   *
   * 默认不擅自往用户目录里写东西:界面上给空态卡片,由用户点「创建」。
   * 想要零摩擦的人可以把它打开。
   */
  createNotesDirOnOpen: z.boolean().default(false),
  /** 是否启用文件监视(外部改名/删除对账)。 */
  watch: z.boolean().default(true),
  /**
   * 是否启用**历史快照**(agent 改坏了能回到改之前)。
   *
   * 快照写在 `<工作区>/.dsh-notes/.history/`(跟着工作区走、不进 git status、不被扫描);
   * 关掉它 = 完全不做任何额外读写,笔记功能一字不变。
   */
  history: z.boolean().default(true),
  /** 每篇笔记保留多少条历史(超出从最旧裁,永远保留最新一条)。 */
  historyMaxPerNote: z.natural().default(50),
})

/**
 * 写前快照的期限(毫秒)。
 *
 * 快照跑在 agent 的 `write`/`edit` **之前**,所以它有义务"慢也不能拖慢写入":
 * 到点就放弃这次快照(下一轮扫描还会兜底),绝不让一次慢读把工具调用卡住。
 */
const HISTORY_HOOK_TIMEOUT_MS = 1500

/**
 * 给一个 promise 加期限,**永不 reject**(超时/失败都只是"这次没做")。
 *
 * 不用 `Promise.race` 是因为那个会在超时后留下未处理的 rejection;这里把原始 promise
 * 的两种结果都接住,超时只是提前 resolve,后台那一次快照该完成还是会完成。
 */
function withDeadline(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    promise.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      () => {
        clearTimeout(timer)
        resolve()
      },
    )
  })
}

/**
 * 装载插件。
 * @param ctx - 插件上下文。
 * @param config - 已校验的配置。
 */
export function apply(ctx, config) {
  const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-notes') : undefined
  const service = new NoteService(ctx, config)

  installTool(ctx, service)
  installRoutes(ctx, service)
  /**
   * agent 的 `write`/`edit` 在**真正写盘之前**留一份历史快照。
   *
   * 为什么必须是这个事件:`tools/execute` 是环绕分发的 waterfall
   * (`ctx.waterfall(carrier, 'tools/execute', exec, () => dispatchToolBody(exec))`),
   * 我们的监听者在 `next()` 之前跑,读到的正是"即将被覆盖掉的内容"。
   * 插件级(未打 scope 标签)的监听者按 `dsh-scope` 的规则**全局放行**,所以主 agent、
   * 子 agent、workflow 的调用都收得到。
   *
   * 三条纪律(这条路径直通 agent 的写入,不能出错):
   *   1. 不碰 `exec`(只读 `name`/`arguments`/`agent`);
   *   2. **无论快照成功、失败还是超时,都必须 `return next()`** —— 在 `next()` 之前抛错会被
   *      `dispatchScheduledExecution` 的 catch 变成工具失败,等于**打断 agent 的写入**;
   *   3. 快照是"锦上添花":写不进去只 warn,笔记该改还是改。
   */
  ctx.on('tools/execute', async (exec, next) => {
    try {
      await withDeadline(service.captureBeforeToolWrite(exec), HISTORY_HOOK_TIMEOUT_MS)
    } catch (error) {
      logger?.warn?.('[dsh-notes] 写前快照失败(不影响写入):%s', error?.message ?? error)
    }
    return next()
  })
  ctx.effect(() => () => service.dispose(), 'dsh-notes: service lifetime')

  logger?.info?.(
    '[dsh-notes] 装载:notesDir=%s assetsDir=%s autosaveMs=%s watch=%s storeScope=%s machineStore=%s',
    config.notesDir,
    config.assetsDir,
    config.autosaveMs,
    config.watch,
    service.storeScope(),
    service.homeRoot(),
  )
}
