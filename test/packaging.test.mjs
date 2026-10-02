/**
 * 打包/导入自查 —— 防止「本机能跑、别人从零装完是整行 inactive」再发生。
 *
 * 背景(2026-10-02 实测):插件以 `link:` 装进 profile 后,Node 从**插件的真实路径**
 * 解析裸导入。host 只会为**声明在 peerDependencies 里**的 @deepseek-ai/dsh* 包
 * 在该位置提供运行时那一份;没声明的包 → import 抛错 → 模块求值失败 →
 * app-boot 静默跳过整个 bundle(条目 enabled=true 但 fiberPhase=null,界面上就是
 * 插件"装了却不存在")。所以:**凡是在 lib/ 或 src/ 里 import 的 @deepseek-ai 包,
 * 都必须声明**,且 peer 范围要写成区间 —— 官方 peer compatibility gate 只看
 * `@deepseek-ai/dsh*` 前缀,**写死版本换个 dsh 版本就会静默跳过**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const declared = new Set([
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
])

/** 只认行首的静态 import/export 与 import('…')，避免把注释里的示例当成依赖。 */
const IMPORT_RE = /^\s*(?:import|export)\s[^;'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm
const DYN_RE = /^\s*(?:const|let|var)?[^\n]*\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm

function scan(dir) {
  const found = new Set()
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(?:m?js|tsx?)$/.test(e.name)) continue
      const text = fs.readFileSync(p, 'utf8')
      for (const re of [IMPORT_RE, DYN_RE]) {
        re.lastIndex = 0
        for (const m of text.matchAll(re)) {
          const spec = m[1] ?? m[2]
          if (!spec || spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('data:')) continue
          found.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
        }
      }
    }
  }
  for (const d of ['lib', 'src']) {
    const p = path.join(root, d)
    if (fs.existsSync(p)) walk(p)
  }
  return found
}

test('凡 import 的 @deepseek-ai 包都必须在 package.json 里声明', () => {
  const missing = [...scan(root)].filter((s) => s.startsWith('@deepseek-ai/') && !declared.has(s)).sort()
  assert.deepEqual(missing, [], `漏声明的包(link: 安装时会 import 失败,整个 bundle 被静默跳过): ${missing.join(', ')}`)
})

test('@deepseek-ai/dsh* 的 peer 必须是区间,不能写死版本', () => {
  const pinned = Object.entries(pkg.peerDependencies ?? {})
    .filter(([k, v]) => k.startsWith('@deepseek-ai/dsh') && /^\d+\.\d+\.\d+/.test(String(v).trim()))
    .map(([k, v]) => `${k}@${v}`)
  assert.deepEqual(pinned, [], `写死版本会在其它 dsh 版本上被 peer gate 静默跳过,请写成如 ">=0.1.0-rc.7 <0.3.0": ${pinned.join(', ')}`)
})

test('发布所需的标准文件齐全', () => {
  for (const f of ['LICENSE', 'CHANGELOG.md', '.gitattributes', 'cordis.patch.yml', 'README.md']) {
    assert.ok(fs.existsSync(path.join(root, f)), `缺文件: ${f}`)
  }
})
