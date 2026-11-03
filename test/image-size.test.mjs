import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 图片尺寸缓存(滚动跳动修复的关键件)。
 *
 * 为什么必须有靶子:图片行可以高到 `max-height:320px`,而 `<img>` 只有位图到位后才有
 * 高度 —— 记不住固有尺寸,重建 widget 时 CM6 的行高就会先缩后涨(用户实测"内容突然
 * 往下挪一截")。这里钉住三件事:命中、校验、跨会话(刷新页面)的持久化与上限。
 */
let mod = null
try {
  mod = await import('../src/client/image-size.ts')
} catch {
  mod = null
}

const maybe = mod === null ? test.skip : test

/** 假 storage(内存 Map),顺带暴露 dump 便于断言落盘内容。 */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, value)
    },
    dump: () => Object.fromEntries(map),
  }
}

maybe('记住之后能命中,并且写进了 storage(刷新页面还在)', () => {
  const storage = fakeStorage()
  const store = mod.createImageSizeStore(storage)
  assert.equal(store.sizeOf('api/file?path=a.png'), null)

  store.remember('api/file?path=a.png', 800, 1600)
  assert.deepEqual(store.sizeOf('api/file?path=a.png'), { w: 800, h: 1600 })

  const persisted = JSON.parse(storage.dump()[mod.SIZE_KEY])
  assert.deepEqual(persisted['api/file?path=a.png'], { w: 800, h: 1600 })

  // 新开一个(等价于刷新页面)也读得到
  const reopened = mod.createImageSizeStore(storage)
  assert.deepEqual(reopened.sizeOf('api/file?path=a.png'), { w: 800, h: 1600 })
})

maybe('非法尺寸一律不收(坏数据不能把盒子撑爆/撑塌)', () => {
  const store = mod.createImageSizeStore(fakeStorage())
  const url = 'u'
  for (const bad of [
    [0, 100],
    [100, 0],
    [-5, 100],
    [Number.NaN, 100],
    [Number.POSITIVE_INFINITY, 100],
    ['abc', '100'],
    [999999, 10], // 超过单边上限(20000)
    [10, 999999],
  ]) {
    store.remember(url, bad[0], bad[1])
    assert.equal(store.sizeOf(url), null, `不该收下 ${JSON.stringify(bad)}`)
  }
  // 合法值:字符串数字也认,小数取整
  store.remember(url, '800.6', '1600')
  assert.deepEqual(store.sizeOf(url), { w: 801, h: 1600 })
  // 空 url 忽略
  store.remember('', 10, 10)
  assert.equal(store.sizeOf(''), null)
})

maybe('超出上限从最旧裁,最新的永远留着', () => {
  const storage = fakeStorage()
  const store = mod.createImageSizeStore(storage)
  const total = mod.MAX_ENTRIES + 25
  for (let index = 0; index < total; index += 1) store.remember(`img-${index}`, 10, 20)

  assert.equal(store.sizeOf(`img-${total - 1}`) !== null, true, '最新那条必须在')
  assert.equal(store.sizeOf('img-0'), null, '最旧那条应该已经被裁掉')
  const persisted = JSON.parse(storage.dump()[mod.SIZE_KEY])
  assert.equal(Object.keys(persisted).length, mod.MAX_ENTRIES)

  // 重复 remember 同一张图会把它刷成"最新"(裁的时候才不会被先丢)
  const reopened = mod.createImageSizeStore(fakeStorage())
  for (let index = 0; index < mod.MAX_ENTRIES; index += 1) reopened.remember(`x-${index}`, 10, 20)
  reopened.remember('x-0', 30, 40)
  reopened.remember('x-new', 10, 20)
  assert.deepEqual(reopened.sizeOf('x-0'), { w: 30, h: 40 })
})

maybe('坏 JSON / 没有 storage / storage 抛错都不炸', () => {
  const broken = fakeStorage({ [mod.SIZE_KEY]: '{ 这不是 json' })
  const store = mod.createImageSizeStore(broken)
  assert.equal(store.sizeOf('u'), null)
  store.remember('u', 10, 20)
  assert.deepEqual(store.sizeOf('u'), { w: 10, h: 20 })

  const memoryOnly = mod.createImageSizeStore(null)
  memoryOnly.remember('v', 1, 2)
  assert.deepEqual(memoryOnly.sizeOf('v'), { w: 1, h: 2 })

  const hostile = {
    getItem: () => {
      throw new Error('隐私模式')
    },
    setItem: () => {
      throw new Error('隐私模式')
    },
  }
  const safe = mod.createImageSizeStore(hostile)
  safe.remember('w', 3, 4)
  assert.deepEqual(safe.sizeOf('w'), { w: 3, h: 4 })
})
