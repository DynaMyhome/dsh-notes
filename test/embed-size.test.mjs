import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 网页演示的高度记忆(纯模型 + 可注入 storage)。
 *
 * 三条要点:命中后的高度、非法值的回落、超出上限从最旧裁 —— 任何一条坏了,
 * 用户重开笔记都会回到默认高度(观感问题,不报错),所以必须有靶子。
 */
let mod = null
let model = null
try {
  mod = await import('../src/client/editor/embed-size.ts')
  model = await import('../src/client/editor/embed-model.ts')
} catch {
  mod = null
  model = null
}

const skip = mod === null ? '当前 Node 没有类型剥离能力(用 npm test 跑)' : false

/** 一个最小的假 localStorage。 */
function fakeStorage(seed = {}) {
  const data = new Map(Object.entries(seed))
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  }
}

test('embed 高度:写入后能读回,并按绝对路径区分', { skip }, () => {
  const storage = fakeStorage()
  const store = mod.createEmbedHeightStore(storage)
  assert.equal(store.heightOf('D:/ws/a.html'), null)
  store.remember('D:/ws/a.html', 720)
  assert.equal(store.heightOf('D:/ws/a.html'), 720)
  assert.equal(store.heightOf('D:/ws/b.html'), null)
  assert.equal(storage.data.has(mod.EMBED_SIZE_KEY), true)
})

test('embed 高度:非法值按默认值落盘,夹到区间内', { skip }, () => {
  const store = mod.createEmbedHeightStore(fakeStorage())
  store.remember('a.html', 'not-a-number')
  assert.equal(store.heightOf('a.html'), model.DEFAULT_EMBED_HEIGHT)
  store.remember('b.html', 1)
  assert.equal(store.heightOf('b.html'), model.EMBED_MIN_HEIGHT)
  store.remember('c.html', 99999)
  assert.equal(store.heightOf('c.html'), model.EMBED_MAX_HEIGHT)
})

test('embed 高度:坏 JSON 静默回落,不抛', { skip }, () => {
  const storage = fakeStorage({ [mod.EMBED_SIZE_KEY]: '{oops' })
  const store = mod.createEmbedHeightStore(storage)
  assert.equal(store.heightOf('x.html'), null)
  store.remember('x.html', 600)
  assert.equal(store.heightOf('x.html'), 600)
})

test('embed 高度:超出上限从最旧裁', { skip }, () => {
  const store = mod.createEmbedHeightStore(fakeStorage())
  const total = mod.EMBED_SIZE_MAX_ENTRIES + 5
  for (let index = 0; index < total; index += 1) store.remember(`f${index}.html`, 400 + index)
  assert.equal(store.heightOf('f0.html'), null, '最旧的应被裁掉')
  assert.equal(store.heightOf(`f${total - 1}.html`), 400 + (total - 1))
})

test('embed 高度:remember(null) 删除该条', { skip }, () => {
  const store = mod.createEmbedHeightStore(fakeStorage())
  store.remember('a.html', 700)
  store.remember('a.html', null)
  assert.equal(store.heightOf('a.html'), null)
})
