#!/usr/bin/env node
/**
 * dsh-notes Client 构建:`src/client` → `lib/client.js`。
 *
 * 产物格式 = DSH 客户端模块加载器的**懒工厂**:
 *
 *   window.__ModuleLoader__.load({ id, factory(require) { … } })
 *
 * 因此把 esbuild 的 CJS 输出包进 factory 里执行 —— 模块顶层代码(常量、样式表)
 * 只在 factory 被 materialize 时运行,不在脚本执行时产生副作用。
 * `react` / `react/jsx-runtime` 来自浏览器模块表(baseline),保持 external。
 *
 * 用法:`npm run build`(需要本目录 node_modules 里的 esbuild;只用于构建,
 * 运行期不需要 —— profile 加载的是构建好的 lib/client.js)。
 */

import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const banner = '/** 构建产物:由 scripts/build.mjs 生成,请勿手改。源码在 src/client/。 */'

/** 与 package.json 的 name 一致 —— 加载器用它对账。 */
const ID = 'dsh-notes'

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/client/main.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  // 编辑器依赖装在 scripts/(工具链自留地),所以要显式告诉 esbuild 去哪找;
  // 往 dsh-notes/node_modules 里装会破坏它指向 profile 的软链(见 AGENTS.md)。
  nodePaths: ['scripts/node_modules'],
  write: false,
  logLevel: 'warning',
  legalComments: 'none',
  sourcemap: false,
  // 编辑器(CodeMirror 6)内联进同一个 bundle:先把体验做通,
  // 之后若要拆 `require.async` 惰性分片(参考官方 documentpreview 的 client.pdf.js)再说。
  minify: true,
})

const body = result.outputFiles[0].text
const wrapped = `${banner}
window.__ModuleLoader__.load({
  id: '${ID}',
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
${body}
    return module.exports;
  },
});
`

const outfile = resolve(root, 'lib/client.js')
await mkdir(dirname(outfile), { recursive: true })
await writeFile(outfile, wrapped, 'utf8')

console.log(`dsh-notes: 写入 lib/client.js(${Buffer.byteLength(wrapped, 'utf8')} 字节)`)
