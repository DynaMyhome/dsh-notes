/**
 * 平台兼容性的靶子用例 —— **Linux / Windows / macOS 上跑的是同一份**。
 *
 * 为什么要单独有这一份:插件在 WSL/Linux 上开发,而 `node:path` 的 `join()` 在那边
 * 天然产出 `/`;一旦路径层混进未归一的原生 join,Linux 全绿、Windows 大面积失配
 * (实测 2026-10-02:Windows node 上 12 条红,全部是 `C:/…` vs `C:\…`)。
 *
 * 这里把两件事钉成可执行的约定:
 *   1. **插件内部只有一种路径写法**:一律 `/` 分隔(`lib/notes.js` 的 `toPosix`)。
 *      所以下面的断言用 **Win32 输入的字符串**去喂纯函数 —— 就算在 Linux 上跑,
 *      谁能漏出 `\` 也会立刻红(不依赖"本机是 Windows")。
 *   2. 三个平台**真实存在**的差异各自有靶子:盘符大小写不敏感、跨盘不相对化、
 *      Windows 保留设备名与尾随点、ext4 单个文件组件的字节上限。
 *
 * 诚实边界:macOS 没有真机(大小写不敏感 + Unicode 归一化两处只能按文档与
 * 代码级推理覆盖,见 README 的「平台支持」一节)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  baseName,
  dirOf,
  isAbsolutePath,
  isWindowsReservedName,
  normalizePath,
  relativePath,
  relativeToWorkspace,
  sanitizeFileName,
  toPosix,
  workspaceKeyOf,
} from '../lib/notes.js'
import {
  cacheFileFor,
  homeStoreRoot,
  rootsFile,
  storeFileFor,
  trashIndexFileFor,
  trashRootFor,
  workspaceStoreFile,
  workspaceStoreRoot,
} from '../lib/store.js'
import { crumbsWithin, pickValueOf, relativeToRoot } from '../src/client/browse-path.ts'

const WIN_ROOT = 'C:\\ws'
const WIN_HOME = 'C:\\Users\\u'
const WIN_DSH_HOME = 'C:\\Users\\u\\.dsh'

/** 插件约定的"没有第二种写法":任何返回给上层的路径都不许出现反斜杠。 */
function assertPosixOnly(label, value) {
  assert.equal(typeof value, 'string', `${label} 应该是字符串`)
  assert.equal(value.includes('\\'), false, `${label} 不该出现反斜杠:${JSON.stringify(value)}`)
}

test('路径归一:反斜杠 / UNC / 尾斜杠 / 空值', () => {
  assert.equal(toPosix('C:\\ws\\notes'), 'C:/ws/notes')
  assert.equal(toPosix('\\\\srv\\share\\x.md'), '//srv/share/x.md')
  assert.equal(normalizePath('C:/ws/'), 'C:/ws')
  assert.equal(normalizePath('C:\\ws\\\\'), 'C:/ws')
  assert.equal(normalizePath('/'), '/', '根不能被削成空串')
  assert.equal(normalizePath(''), '/')
  assert.equal(normalizePath(null), '/')
})

test('isAbsolutePath:盘符 / POSIX / UNC 是绝对;相对与盘符相对不是', () => {
  assert.equal(isAbsolutePath('C:\\ws'), true)
  assert.equal(isAbsolutePath('c:/ws'), true)
  assert.equal(isAbsolutePath('/ws'), true)
  assert.equal(isAbsolutePath('//srv/share'), true, 'UNC 以 / 开头,也算绝对')
  assert.equal(isAbsolutePath('notes/a.md'), false)
  assert.equal(isAbsolutePath('C:ws'), false, '盘符相对路径(C:ws)不是绝对路径')
})

test('baseName / dirOf 在 Win32 路径上照样只看最后一段', () => {
  assert.equal(baseName('C:\\ws\\notes\\甲.md'), '甲.md')
  assert.equal(dirOf('C:\\ws\\notes\\甲.md'), 'C:/ws/notes')
  assert.equal(dirOf('C:\\ws\\甲.md'), 'C:/ws')
  assert.equal(dirOf('/ws/甲.md'), '/ws')
})

test('工作区键只看归一后的根:分隔符写法不同 = 同一个工作区', () => {
  assert.equal(workspaceKeyOf('C:\\ws'), workspaceKeyOf('C:/ws'))
  assert.equal(workspaceKeyOf('C:/ws/'), workspaceKeyOf('C:\\ws'))
  assert.notEqual(workspaceKeyOf('C:/ws'), workspaceKeyOf('C:/ws2'))
})

test('relativePath:同盘相对、跨盘退化成绝对、盘符大小写不敏感', () => {
  assert.equal(relativePath('C:/ws', 'C:/ws/notes/甲.md'), 'notes/甲.md')
  assert.equal(relativePath('C:/ws/notes', 'C:/ws/assets/a.png'), '../assets/a.png')
  assert.equal(relativePath('C:\\ws', 'C:/ws/note.md'), 'note.md', '反斜杠写法也要能相对化')
  assert.equal(relativePath('c:/ws', 'C:/ws/note.md'), 'note.md', '盘符大小写不敏感')
  assert.equal(relativePath('C:/ws', 'D:/other/a.md'), 'D:/other/a.md', '跨盘不相对化,直接给绝对路径')
  assert.equal(relativePath('/ws', '/ws/a/b.md'), 'a/b.md')
})

test('relativeToWorkspace:越界拒绝、根给空串、盘符大小写不敏感、POSIX 仍区分大小写', () => {
  assert.deepEqual(relativeToWorkspace(WIN_ROOT, 'C:/ws/notes/甲.md'), { ok: true, rel: 'notes/甲.md' })
  assert.deepEqual(relativeToWorkspace(WIN_ROOT, 'C:\\ws\\notes\\甲.md'), { ok: true, rel: 'notes/甲.md' })
  assert.deepEqual(relativeToWorkspace('c:\\ws', 'C:/ws/x.md'), { ok: true, rel: 'x.md' }, 'Windows 路径大小写不敏感')
  assert.deepEqual(relativeToWorkspace('C:/ws', 'C:/ws'), { ok: true, rel: '' }, '工作区根本身 = 空相对路径')
  assert.deepEqual(relativeToWorkspace('C:/ws', 'C:/ws2/x.md'), { ok: false }, '前缀相同但不是子目录')
  assert.deepEqual(relativeToWorkspace('/ws', 'C:/ws/x.md'), { ok: false }, '一个是盘符一个是 POSIX 根')
  assert.deepEqual(relativeToWorkspace('/ws', '/WS/x.md'), { ok: false }, 'POSIX 区分大小写(有意为之)')
})

test('store 层:Win32 根下**每个**派生路径都是 `/`(这是"只有一种写法"的锁)', () => {
  const roots = {
    workspaceStoreRoot: workspaceStoreRoot(WIN_ROOT),
    workspaceStoreFile: workspaceStoreFile(WIN_ROOT),
    trashRootFor: trashRootFor('workspace', {}, WIN_ROOT, {}, WIN_HOME),
    trashIndexFileFor: trashIndexFileFor('workspace', {}, WIN_ROOT, {}, WIN_HOME),
    storeFileFor: storeFileFor('workspace', {}, WIN_ROOT, {}, WIN_HOME),
    homeStoreRoot: homeStoreRoot({}, { DSH_HOME: WIN_DSH_HOME }, WIN_HOME),
    homeStoreRootDefault: homeStoreRoot({}, {}, WIN_HOME),
    homeStoreRootConfigured: homeStoreRoot({ storeDir: 'D:\\store' }, {}, WIN_HOME),
    rootsFile: rootsFile({}, { DSH_HOME: WIN_DSH_HOME }, WIN_HOME),
    cacheFileFor: cacheFileFor({}, 'abc123', { DSH_HOME: WIN_DSH_HOME }, WIN_HOME),
  }
  for (const [label, value] of Object.entries(roots)) assertPosixOnly(label, value)

  assert.equal(roots.workspaceStoreRoot, 'C:/ws/.dsh-notes')
  assert.equal(roots.workspaceStoreFile, 'C:/ws/.dsh-notes/index.json')
  assert.equal(roots.trashRootFor, 'C:/ws/.dsh-notes/.trash')
  assert.equal(roots.trashIndexFileFor, 'C:/ws/.dsh-notes/.trash/trash.json')
  assert.equal(roots.storeFileFor, 'C:/ws/.dsh-notes/index.json')
  assert.equal(roots.homeStoreRoot, 'C:/Users/u/.dsh/knowledge')
  assert.equal(roots.homeStoreRootDefault, 'C:/Users/u/.dsh/knowledge', '$DSH_HOME 缺席时回落 ~/.dsh')
  assert.equal(roots.homeStoreRootConfigured, 'D:/store', 'Config.storeDir 也要归一')
  assert.equal(roots.rootsFile, 'C:/Users/u/.dsh/knowledge/workspaces.json')
  assert.equal(roots.cacheFileFor, 'C:/Users/u/.dsh/knowledge/index/abc123.json')
  assert.equal(roots.trashIndexFileFor.startsWith(`${roots.trashRootFor}/`), true, '回收站索引要在回收站目录里')
})

test('home 形态(storeScope=home)同样只产出 `/`', () => {
  const home = {
    root: trashRootFor('home', {}, WIN_ROOT, { DSH_HOME: WIN_DSH_HOME }, WIN_HOME),
    index: trashIndexFileFor('home', {}, WIN_ROOT, { DSH_HOME: WIN_DSH_HOME }, WIN_HOME),
    store: storeFileFor('home', {}, WIN_ROOT, { DSH_HOME: WIN_DSH_HOME }, WIN_HOME),
  }
  for (const [label, value] of Object.entries(home)) assertPosixOnly(label, value)
  assert.equal(home.root, 'C:/Users/u/.dsh/knowledge/trash')
  assert.equal(home.store, 'C:/Users/u/.dsh/knowledge/registry.json')
})

test('Windows 保留设备名:`CON` / `con.md` / `COM1` / `LPT9` 都要让开', () => {
  // 判定本身:第一个点之前的基名,大小写不敏感
  for (const name of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'LPT9', 'CON.md', 'com1.txt']) {
    assert.equal(isWindowsReservedName(name), true, `${name} 应该被判为保留名`)
  }
  for (const name of ['CONSOLE', 'COM10', 'LPT0', 'my-con', '笔记', 'con-']) {
    assert.equal(isWindowsReservedName(name), false, `${name} 不该被判为保留名`)
  }

  assert.equal(sanitizeFileName('CON'), 'CON-')
  assert.equal(sanitizeFileName('con'), 'con-')
  assert.equal(sanitizeFileName('NUL'), 'NUL-')
  assert.equal(sanitizeFileName('COM1'), 'COM1-')
  assert.equal(sanitizeFileName('LPT9'), 'LPT9-')
  assert.equal(sanitizeFileName('CON.md'), 'CON-.md')
  assert.equal(sanitizeFileName('com1.txt'), 'com1-.txt')
  assert.equal(sanitizeFileName('CONSOLE'), 'CONSOLE', '不是保留名就别动它')
  assert.equal(sanitizeFileName('COM10'), 'COM10')

  // 真正的锁:加上缺省后缀之后,落在磁盘上的名字在任何平台都不再是保留名
  for (const name of ['CON', 'con', 'NUL', 'COM1', 'LPT9', 'CON.md', 'com1.txt']) {
    assert.equal(isWindowsReservedName(`${sanitizeFileName(name)}.md`), false, `${name} → 磁盘名仍被保留`)
  }
})

test('文件名:非法字符 / 尾随点与空格 / 长度上限(三平台共同的约束)', () => {
  assert.equal(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j', '`\\ / : * ? " < > |` 全换掉')
  assert.equal(sanitizeFileName('foo.'), 'foo', '尾随点:Windows 会静默截断,直接削掉')
  assert.equal(sanitizeFileName('foo '), 'foo')
  assert.equal(sanitizeFileName('  .foo.  '), 'foo')
  assert.equal(sanitizeFileName(''), 'untitled')
  assert.equal(sanitizeFileName('   '), 'untitled')
  assert.equal(sanitizeFileName('a\u0000b'), 'a-b', '控制符也要换掉(NTFS 直接拒绝)')

  const ascii = sanitizeFileName('x'.repeat(200))
  assert.equal(ascii.length, 80)
  const cjk = sanitizeFileName('笔'.repeat(200))
  assert.equal(cjk.length, 80)
  assert.equal(Buffer.byteLength(`${cjk}.md`, 'utf8') <= 255, true, 'ext4 单个组件上限 255 字节')
})

test('客户端目录浏览器:Win32 盘符大小写不敏感,越界仍然拒绝', () => {
  assert.deepEqual(relativeToRoot(WIN_ROOT, 'C:/ws/notes'), { ok: true, rel: 'notes' })
  assert.deepEqual(relativeToRoot('c:\\ws', 'C:/ws/notes'), { ok: true, rel: 'notes' })
  assert.deepEqual(relativeToRoot(WIN_ROOT, 'C:\\ws'), { ok: true, rel: '' })
  assert.deepEqual(relativeToRoot(WIN_ROOT, 'C:/ws2/notes'), { ok: false })
  assert.deepEqual(relativeToRoot(WIN_ROOT, '/ws/notes'), { ok: false })
  assert.equal(pickValueOf(WIN_ROOT, 'c:/ws/notes'), 'notes')
  assert.equal(pickValueOf(WIN_ROOT, 'C:/elsewhere'), null)
})

test('面包屑:根那一层按"互相都能相对化"匹配,大小写写法不同也能对上', () => {
  const crumbs = [
    { name: 'C:', path: 'C:\\', hidden: false },
    { name: 'ws', path: 'C:\\ws', hidden: false },
    { name: 'notes', path: 'C:\\ws\\notes', hidden: false },
  ]
  const kept = crumbsWithin('c:\\ws', crumbs)
  assert.equal(kept.length, 2, '应该从工作区根那一层开始')
  assert.equal(kept[0].path, 'C:\\ws')
  assert.deepEqual(crumbsWithin('C:/ws', crumbs).length, 2, '同一种写法当然也对')

  // 当前目录在工作区外 → 整条不给
  assert.deepEqual(crumbsWithin(WIN_ROOT, [{ name: 'x', path: 'C:\\other', hidden: false }]), [])
  // 官方给的链里没有工作区根(理论上不该发生)→ 空,而不是瞎画
  assert.deepEqual(crumbsWithin(WIN_ROOT, [{ name: 'notes', path: 'C:\\ws\\notes', hidden: false }]), [])
})
