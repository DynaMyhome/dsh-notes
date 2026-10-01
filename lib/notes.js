/**
 * 纯函数层:路径 / frontmatter / wikilink / 标题。
 *
 * 不依赖 ctx,也不碰磁盘 —— 全部可单测。约定:
 *   - 对外路径一律先 `toPosix()`(`\` → `/`),再按 `/` 分段处理;
 *   - 磁盘上的原生路径只在 ctx.fs 那一层出现。
 *
 * @module dsh-notes/notes
 */

import { createHash, randomUUID } from 'node:crypto'

/** frontmatter 里的身份键:已登记笔记的稳定标识(跨改名/移动)。 */
export const NOTE_ID_KEY = 'dsh-note-id'

/** 视为笔记的文件后缀。 */
export const MARKDOWN_RE = /\.(md|markdown)$/i

/** 一次扫描默认跳过的目录名。 */
export const SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian', '.dsh-assets', '.trash'])

/** `\` → `/`。 */
export function toPosix(value) {
  return String(value ?? '').replace(/\\/g, '/')
}

/** 去掉结尾斜杠(根除外)。 */
export function normalizePath(value) {
  const text = toPosix(value).replace(/\/+$/, '')
  return text === '' ? '/' : text
}

/** 是否绝对路径(POSIX / Windows 盘符 / UNC)。 */
export function isAbsolutePath(value) {
  const text = toPosix(value)
  return text.startsWith('/') || /^[a-zA-Z]:\//.test(text)
}

/** 工作区键:根路径的短哈希(索引按工作区分树)。 */
export function workspaceKeyOf(root) {
  return createHash('sha1').update(normalizePath(root)).digest('hex').slice(0, 12)
}

/** 新笔记 id(ULID 风格前缀 + uuid 去横线)。 */
export function mintNoteId() {
  return `n_${randomUUID().replace(/-/g, '').slice(0, 20)}`
}

/** 新分类 id。 */
export function mintCollectionId() {
  return `c_${randomUUID().replace(/-/g, '').slice(0, 20)}`
}

/** 目录部分(规范化后)。 */
export function dirOf(value) {
  const text = normalizePath(value)
  const index = text.lastIndexOf('/')
  if (index < 0) return ''
  return index === 0 ? '/' : text.slice(0, index)
}

/** 末段文件名。 */
export function baseName(value) {
  const text = normalizePath(value)
  const index = text.lastIndexOf('/')
  return index < 0 ? text : text.slice(index + 1)
}

/** 去掉 markdown 后缀。 */
export function stripExt(name) {
  return String(name ?? '').replace(MARKDOWN_RE, '')
}

/** 拼接(规范化后)。 */
export function joinPath(dir, name) {
  const parent = normalizePath(dir)
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

/** 是否 markdown 文件。 */
export function looksLikeMarkdown(value) {
  return MARKDOWN_RE.test(toPosix(value))
}

/**
 * 文档相对链接(给 md 里的图片用):`toPath` 相对 `fromDir`。
 *
 * 盘符段大小写不敏感(Windows),其余段区分大小写;不同盘符时返回绝对路径。
 * @param fromDir - 引用方所在目录(绝对,规范化)。
 * @param toPath - 目标路径(绝对,规范化)。
 * @returns 以 `../` 开头的相对路径,或目标绝对路径。
 */
export function relativePath(fromDir, toPath) {
  const from = normalizePath(fromDir).split('/')
  const to = normalizePath(toPath).split('/')
  const sameDrive =
    from.length > 0 && to.length > 0 && /^[a-zA-Z]:$/.test(from[0]) && /^[a-zA-Z]:$/.test(to[0])
      ? from[0].toLowerCase() === to[0].toLowerCase()
      : /^[a-zA-Z]:$/.test(from[0] ?? '') === /^[a-zA-Z]:$/.test(to[0] ?? '')
  if (!sameDrive) return normalizePath(toPath)
  let index = 0
  while (index < from.length && index < to.length) {
    const left = /^[a-zA-Z]:$/.test(from[index]) ? from[index].toLowerCase() : from[index]
    const right = /^[a-zA-Z]:$/.test(to[index]) ? to[index].toLowerCase() : to[index]
    if (left !== right) break
    index += 1
  }
  const up = from.length - index
  const rest = to.slice(index).join('/')
  if (up === 0) return rest === '' ? '.' : rest
  return `${'../'.repeat(up)}${rest}`
}

/**
 * 文档开头 frontmatter(`---` … `---`)的范围。
 *
 * 只认**文件最开头**的那一段(和 `readNoteId` 同一套判断)。`to` 落在收尾 `---`
 * 的最后一个字符之后(不含换行),方便整块替换成 widget 时把换行留给下一行。
 * @param text - 文件全文。
 * @returns `{ from, to, body }`,没有 frontmatter 时 null。
 */
export function frontmatterRange(text) {
  const source = String(text ?? '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)
  if (match === null) return null
  return { from: 0, to: match[0].length, body: match[1] }
}

/**
 * 读 frontmatter 里的笔记 id。
 * @param text - 文件全文。
 * @returns id,或 null(无 frontmatter / 无该键)。
 */
export function readNoteId(text) {
  const source = String(text ?? '')
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)
  if (block === null) return null
  for (const line of block[1].split(/\r?\n/)) {
    const match = /^dsh-note-id\s*:(.*)$/.exec(line.trim())
    if (match === null) continue
    const value = match[1].trim().replace(/^["']|["']$/g, '')
    return value === '' ? null : value
  }
  return null
}

/**
 * 注入/替换 frontmatter 里的笔记 id(其余内容原样保留)。
 * @param text - 文件全文。
 * @param id - 要写入的 id。
 * @returns 新全文(LF 换行)。
 */
export function mintFrontmatter(text, id) {
  const source = String(text ?? '')
  const line = `${NOTE_ID_KEY}: ${id}`
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)
  if (block !== null) {
    const body = block[1]
    const nextBody = /^dsh-note-id\s*:/m.test(body)
      ? body.replace(/^dsh-note-id\s*:.*$/m, line)
      : `${body}\n${line}`
    return `---\n${nextBody}\n---${source.slice(block[0].length)}`
  }
  const separator = source === '' || source.startsWith('\n') ? '' : '\n'
  return `---\n${line}\n---\n${separator}${source}`
}

/**
 * 解析 `[[wikilink]]`(支持 `[[目标#标题|别名]]`)。
 * @param text - 文件全文。
 * @returns 链接数组(去重前)。
 */
export function parseWikiLinks(text) {
  const links = []
  const re = /\[\[([^[\]\n]{1,300})\]\]/g
  let match
  while ((match = re.exec(String(text ?? ''))) !== null) {
    const inner = match[1]
    const pipe = inner.indexOf('|')
    const body = pipe === -1 ? inner : inner.slice(0, pipe)
    const alias = pipe === -1 ? '' : inner.slice(pipe + 1)
    const hash = body.indexOf('#')
    links.push({
      raw: match[0],
      target: (hash === -1 ? body : body.slice(0, hash)).trim(),
      heading: hash === -1 ? '' : body.slice(hash + 1).trim(),
      alias: alias.trim(),
    })
  }
  return links
}

/**
 * 笔记标题 = **文件名**(不含后缀),与正文里的 H1 **无关**。
 *
 * Obsidian 模型:文件名是身份,正文随便写。这样树上的名字、`[[链接]]` 的目标、
 * 磁盘上的文件三者永远一致;改标题 = 改文件名(显式动作)。
 * 以前的实现取「frontmatter 之后第一个 ATX 标题,否则文件名」,结果树里显示的名字
 * 和文件名是两套,实测出现过「树上写 A、文件叫 B」的困惑。
 * @param path - 文件路径。
 * @returns 标题文本。
 */
export function titleOf(path) {
  return stripExt(baseName(path)) || 'untitled'
}

/**
 * 由标题生成安全文件名(不含后缀)。
 * @param title - 用户/模型给的标题。
 * @returns 可作文件名的字符串。
 */
export function sanitizeFileName(title) {
  const cleaned = String(title ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim()
  const capped = cleaned.length > 80 ? cleaned.slice(0, 80).trim() : cleaned
  return capped === '' ? 'untitled' : capped
}

/**
 * glob → 正则(只支持 `*` / `**` / `?`,够用于「杂项」忽略列表)。
 *
 * - `**` 跨目录:`docs/**` 命中 `docs/a.md` 与 `docs/x/b.md`;`**​/x.md` 命中任意深度的 x.md;
 * - `*` 不跨目录;`?` 单字符;其余字符按字面量,正则元字符全部转义。
 * @param pattern - glob(先 `toPosix`/去尾斜杠)。
 * @returns 正则;空模式返回 null。
 */
export function globToRegExp(pattern) {
  const text = normalizePath(String(pattern ?? '').trim())
  if (text === '') return null
  let source = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '*') {
      if (text[index + 1] === '*') {
        index += 1
        // `**/` 吃掉一层目录(可以为 0 层),这样 `**/x.md` 也命中根下的 x.md
        if (text[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    source += /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char
  }
  return new RegExp(`^${source}$`)
}

/**
 * 路径是否命中 glob。
 * @param pattern - glob。
 * @param relPath - 工作区相对路径。
 * @returns 命中为 true。
 */
export function globMatch(pattern, relPath) {
  const matcher = globToRegExp(pattern)
  if (matcher === null) return false
  return matcher.test(normalizePath(relPath))
}

/** 允许落盘的图片后缀白名单(其余一律按 png 处理,避免把任意文件塞进资产目录)。 */
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.svg'])

/**
 * 资产文件名:可读前缀 + 时间 + 随机段 + 后缀。
 * @param extension - 后缀(含点,如 `.png`);不在白名单内则回落 `.png`。
 * @param now - 时间戳(毫秒)。
 * @returns 文件名。
 */
export function assetFileName(extension, now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const rand = randomUUID().slice(0, 6)
  const wanted = String(extension ?? '').toLowerCase()
  const suffix = IMAGE_EXTENSIONS.has(wanted) ? wanted : '.png'
  return `image-${stamp}-${rand}${suffix}`
}

/* -------------------------------------------------------------------- */
/* 修改时间                                                              */
/* -------------------------------------------------------------------- */

/**
 * 从 provider 的文件版本号里取出**修改时间**(毫秒)。
 *
 * **为什么需要它**:官方 `fs` 接口面**不暴露 mtime** —— `FsDirEntry` 只有
 * `{ name, type, target, version?, size? }`(`@deepseek-ai/dsh-fs` 的 types.d.ts),
 * `FsInfo`/`WorkspaceFileStat` 同样只有不透明的 `version`。而"纳入管理 → 最近"
 * 要按修改时间排序,拿不到就只能退化成按路径排。
 *
 * 本机 provider(`@deepseek-ai/dsh-fs-local`)的 `versionOf()` 是
 * `` `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}` `` —— mtime 就在第 4 段。
 *
 * ⚠️ 官方文档说这个 token 是**不透明**的("consumers MUST NOT interpret this token"),
 * 所以这里**只做严格形状校验 + 失败回落 0**,绝不假设其它格式:
 *   - 5 段全数字 → 第 4 段按纳秒换算毫秒;
 *   - 单段纯数字 → 按毫秒(部分 provider / 单测替身就是这么给的);
 *   - 其它任何形状 → 0(调用方回落成路径序)。
 * **升级 DSH 或换 fs provider 之后要复核这条**(见 AGENTS.md「升级后复核」)。
 *
 * @param version - provider 给的版本号(可能是 `undefined`)。
 * @returns 毫秒时间戳;认不出来时为 0。
 */
export function mtimeOfVersion(version) {
  const text = String(version ?? '').trim()
  if (!/^\d+(:\d+)*$/.test(text)) return 0
  const parts = text.split(':')
  if (parts.length === 1) {
    const value = Number(parts[0])
    return Number.isFinite(value) && value > 0 ? value : 0
  }
  if (parts.length !== 5) return 0
  const nanos = Number(parts[3])
  if (!Number.isFinite(nanos) || nanos <= 0) return 0
  return Math.round(nanos / 1e6)
}

/* -------------------------------------------------------------------- */
/* 行尾风格                                                              */
/* -------------------------------------------------------------------- */

/** 判定行尾风格时采样的字节数(与 `@deepseek-ai/dsh-fs-local` 的 `detectLineEndings` 一致)。 */
export const EOL_SAMPLE_BYTES = 4096

/**
 * 把任意行尾风格归一成 LF(编辑器里的形态)。
 * @param text - 任意文本。
 * @returns `\r\n` 全部变成 `\n`(孤立的 `\r` 不动,与 fs-local 同规则)。
 */
export function normalizeEol(text) {
  return String(text ?? '').replace(/\r\n/g, '\n')
}

/**
 * 采样一段文本,判断原文件的**行尾风格**。
 *
 * 与 `@deepseek-ai/dsh-fs-local` 的 `detectLineEndings()` 同规则(CRLF 占多数 → CRLF),
 * 这样插件保存的文件与官方 `editText` 写回的文件风格一致。
 * @param sample - 文件开头的一段原文(建议前 4096 字节)。
 * @returns `'CRLF'` 或 `'LF'`。
 */
export function detectEol(sample) {
  const text = String(sample ?? '')
  const crlf = text.split('\r\n').length - 1
  const lf = text.split('\n').length - 1 - crlf
  return crlf > lf ? 'CRLF' : 'LF'
}

/**
 * 把(LF 归一后的)文本转回原文件的行尾风格,准备写盘。
 *
 * 先归一再展开,避免把已经是 `\r\n` 的地方变成 `\r\r\n`(与 fs-local 的
 * `restoreLineEndings()` 同款)。`'LF'` 时原样返回。
 * @param text - 编辑器给出的文本(CM6 里恒为 LF)。
 * @param eol - {@link detectEol} 的结果。
 * @returns 用于写盘的文本。
 */
export function applyEol(text, eol) {
  const value = String(text ?? '')
  if (eol !== 'CRLF') return value
  return value.replace(/\r\n/g, '\n').split('\n').join('\r\n')
}

/**
 * 工作区相对化:把绝对路径换算成工作区相对路径。
 *
 * 目录选择器给的是**绝对路径**,而索引里的 `scanRoots` 存的是工作区相对路径,
 * 选进来的目录必须落在工作区内(否则扫描范围就跑到工作区外面去了)。
 * @param root - 工作区根(绝对路径)。
 * @param absolute - 待换算的绝对路径(允许带结尾斜杠)。
 * @returns `{ ok: true, rel }`;越界时为 `{ ok: false }`(工作区根本身 → `rel: ''`)。
 */
export function relativeToWorkspace(root, absolute) {
  const base = normalizePath(String(root ?? ''))
  const target = normalizePath(String(absolute ?? ''))
  if (base === '' || base === '/' || target === '') return { ok: false }
  // Windows 盘符大小写不敏感;POSIX 敏感。只在"两边都像盘符路径"时忽略大小写。
  const bothDrive = /^[a-zA-Z]:\//.test(base) && /^[a-zA-Z]:\//.test(target)
  const left = bothDrive ? base.toLowerCase() : base
  const right = bothDrive ? target.toLowerCase() : target
  if (right === left) return { ok: true, rel: '' }
  if (!right.startsWith(`${left}/`)) return { ok: false }
  return { ok: true, rel: toPosix(target.slice(base.length + 1)).replace(/\/+$/, '') }
}
