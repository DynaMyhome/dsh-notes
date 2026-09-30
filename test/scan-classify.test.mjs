import { test } from 'node:test'
import assert from 'node:assert/strict'

import { globMatch, globToRegExp } from '../lib/notes.js'
import { NoteRegistry } from '../lib/registry.js'

/**
 * 三类分类的**纯**部分:glob 匹配 + 「杂项」标记。
 *
 * 走目录/读 frontmatter 的部分在 service-scan.test.mjs(真文件系统)。
 */

test('globMatch:`**` 跨目录、`*` 不跨、`?` 单字符', () => {
  const cases = [
    // [pattern, path, 期望]
    ['docs/**', 'docs/a.md', true],
    ['docs/**', 'docs/x/b.md', true],
    ['docs/**', 'docs', false], // 目录自身要写 `docs` 或 `docs/**`
    ['**/x.md', 'x.md', true],
    ['**/x.md', 'a/b/x.md', true],
    ['**/x.md', 'a/b/y.md', false],
    ['**/*.draft.md', 'deep/a/b.draft.md', true],
    ['*.md', 'a.md', true],
    ['*.md', 'a/b.md', false],
    ['src/*.js', 'src/a.js', true],
    ['src/*.js', 'src/x/a.js', false],
    ['a?c.md', 'abc.md', true],
    ['a?c.md', 'ac.md', false],
    ['docs/legacy', 'docs/legacy', true],
    ['docs/legacy', 'docs/legacy/x.md', false],
    ['', 'any.md', false],
    ['notes/**', 'docs/a.md', false],
  ]
  for (const [pattern, path, want] of cases) {
    assert.equal(globMatch(pattern, path), want, `${pattern} vs ${path}`)
  }
})

test('globToRegExp:正则元字符按字面量', () => {
  const re = globToRegExp('a+b(c).md')
  assert.equal(re.test('a+b(c).md'), true)
  assert.equal(re.test('aab(c).md'), false) // `+` 不该被当量词
})

test('registry:忽略项(精确路径 + glob)与撤销', () => {
  const registry = new NoteRegistry()
  registry.workspace('ws', { root: '/ws', name: 'ws', notesRoot: '/ws/notes' })

  assert.equal(registry.isIgnored('ws', 'docs/readme.md'), false)

  registry.setIgnored('ws', { paths: ['docs/readme.md'], globs: ['archive/**'] })
  assert.equal(registry.isIgnored('ws', 'docs/readme.md'), true)
  assert.equal(registry.isIgnored('ws', 'archive/old.md'), true)
  assert.equal(registry.isIgnored('ws', 'archive/deep/old.md'), true)
  assert.equal(registry.isIgnored('ws', 'notes/a.md'), false)

  // 撤销单个路径 + 单个 glob
  registry.setIgnored('ws', { paths: ['docs/readme.md'] }, { on: false })
  assert.equal(registry.isIgnored('ws', 'docs/readme.md'), false)
  assert.equal(registry.isIgnored('ws', 'archive/old.md'), true)

  registry.setIgnored('ws', { globs: ['archive/**'] }, { on: false })
  assert.equal(registry.isIgnored('ws', 'archive/old.md'), false)

  // 重复标记幂等
  registry.setIgnored('ws', { paths: ['a.md', 'a.md'] })
  assert.deepEqual(registry.state.workspaces.ws.ignored, ['a.md'])

  // 老索引(没有这两个字段)也能读
  const restored = new NoteRegistry({
    schemaVersion: 1,
    notes: {},
    workspaces: { ws: { root: '/ws', name: 'ws', notesRoot: '/ws/notes', collections: {}, refs: {}, pins: [], recent: [] } },
  })
  restored.workspace('ws')
  assert.equal(restored.isIgnored('ws', 'x.md'), false)
  assert.deepEqual(restored.setIgnored('ws', { paths: ['x.md'] }).ignored, ['x.md'])
})
