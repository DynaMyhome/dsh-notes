/**
 * 依赖环检查(开发工具,不参与构建)。
 *
 * `decorate.ts` 与 `setup.ts` 曾经互相 import:结果运行时 `Cannot access '<x>'
 * before initialization`,整个笔记面板渲染失败(实测踩到,最外层只留一个空 div)。
 * 改完客户端代码后跑一下,确认 `cycles: 0`:
 *
 *   node scripts/build-graph.mjs
 */
import { build } from 'esbuild'
const result = await build({
  absWorkingDir: process.cwd(),
  entryPoints: ['src/client/main.tsx'],
  bundle: true, format: 'esm', platform: 'browser', target: ['es2022'],
  jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
  nodePaths: ['scripts/node_modules'], write: false, metafile: true, logLevel: 'silent',
})
const inputs = result.metafile.inputs
const graph = Object.fromEntries(Object.entries(inputs).map(([f, v]) => [f, v.imports.map((i) => i.path)]))
// 只打印 src/client 下的相对依赖,找环
const files = Object.keys(graph).filter((f) => f.startsWith('src/client'))
const cycles = []
const visit = (node, stack) => {
  if (stack.includes(node)) { cycles.push([...stack.slice(stack.indexOf(node)), node]); return }
  for (const next of graph[node] ?? []) {
    if (next.startsWith('src/client')) visit(next, [...stack, node])
  }
}
for (const f of files) visit(f, [])
const seen = new Set()
for (const c of cycles) { const key = [...c].sort().join('>'); if (seen.has(key)) continue; seen.add(key); console.log('CYCLE:', c.join(' → ')) }
console.log('files:', files.length, 'cycles:', seen.size)
