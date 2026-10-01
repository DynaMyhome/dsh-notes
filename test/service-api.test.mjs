import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { NoteService } from '../lib/service.js'
import { Config } from '../lib/index.js'

/**
 * 插件入口 / 路由 / 工具的**接口面守卫**。
 *
 * 为什么需要:`node --check` 只查语法,单测也从不 import `lib/index.js` ——
 * 于是把 `NoteService#storeFile()` 改名成 `storeFileFor()` 之后,整个插件在装载时抛
 * `TypeError: service.storeFile is not a function`、Host 半整行 inactive、**所有路由 404**,
 * 而 184 条单测照样全绿(2026-10-03 真实踩到)。这条用例把"引用了一个不存在的方法"
 * 变成测试期就能看见的红。
 */

const CALLERS = ['lib/index.js', 'lib/routes.js', 'lib/tool.js']

test('入口/路由/工具引用的 service 方法都真实存在(改名不再静默 404)', async () => {
  const proto = NoteService.prototype
  const missing = []
  for (const file of CALLERS) {
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(/\bservice\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = match[1]
      if (name in proto) continue
      missing.push(`${file}: service.${name}()`)
    }
  }
  assert.deepEqual([...new Set(missing)], [], '这些方法在 NoteService 上不存在')
})

test('service.js 内部 this.<方法>() 的调用也都在原型上(顺手挡同一类改名事故)', async () => {
  const proto = NoteService.prototype
  const source = await readFile('lib/service.js', 'utf8')
  const missing = []
  for (const match of source.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1]
    if (name in proto) continue
    if (['constructor', 'abort', 'toJSON'].includes(name)) continue
    missing.push(`this.${name}()`)
  }
  assert.deepEqual([...new Set(missing)], [], '这些 this.x() 在 NoteService 上不存在')
})

test('配置表能接受默认值:storeScope 默认 workspace,只有显式 home 才回退', () => {
  const parsed = Config({})
  assert.equal(parsed.storeScope, 'workspace')
  assert.equal(parsed.notesDir, 'notes')
  assert.equal(Config({ storeScope: 'home' }).storeScope, 'home')
})

test('插件的公开导出面(apply/Config)存在 —— 载体加载的第一道门', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(typeof mod.apply, 'function', '没有 apply,插件装不上')
  assert.notEqual(mod.Config, undefined, '没有 Config,profile 无法配置')
  assert.equal(typeof mod.inject, 'object', 'inject 声明要与载体能力对齐')
})
