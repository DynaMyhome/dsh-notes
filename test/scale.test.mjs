import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 字号/图标缩放偏好的纯模型。
 *
 * 模型是 `.ts`,要靠 Node 的类型剥离(`--experimental-strip-types`)才 import 得进来 ——
 * 所以这里**没有该能力就跳过**(直接 `node --test test/*.test.mjs` 也不会红);
 * `npm test` 已经带上这个参数。
 */
let scale = null
try {
  scale = await import('../src/client/scale.ts')
} catch {
  scale = null
}

const maybe = scale === null ? test.skip : test

/** 内存假 storage(可注入故障)。 */
function fakeStorage(initial = {}, { throwOnGet = false, throwOnSet = false } = {}) {
  const data = { ...initial }
  return {
    data,
    getItem(key) {
      if (throwOnGet) throw new Error('getItem 坏了')
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null
    },
    setItem(key, value) {
      if (throwOnSet) throw new Error('setItem 坏了')
      data[key] = value
    },
  }
}

maybe('clampScale:越界夹取,坏值回落默认档', () => {
  assert.equal(scale.clampScale(1), 1)
  assert.equal(scale.clampScale(0.5), scale.SCALE_MIN, '低于下限夹到下限')
  assert.equal(scale.clampScale(2), scale.SCALE_MAX, '高于上限夹到上限')
  assert.equal(scale.clampScale(0.85), 0.85)
  assert.equal(scale.clampScale(1.5), 1.5)
  // 坏值:偏好是用户可写数据,读坏一个不能让面板崩
  for (const bad of [undefined, null, '', 'bogus', NaN, Infinity, -1, 0, {}]) {
    assert.equal(scale.clampScale(bad), scale.SCALE_DEFAULT, `坏值 ${String(bad)} 应回落默认档`)
  }
  // 字符串数字(从 localStorage 读回来的都是字符串)
  assert.equal(scale.clampScale('1.15'), 1.15)
  assert.equal(scale.clampScale('9'), scale.SCALE_MAX)
})

maybe('clampScale:两位小数,不产生浮点长尾', () => {
  assert.equal(scale.clampScale(1.23456), 1.23)
  assert.equal(scale.clampScale(0.987), 0.99)
  assert.equal(scale.clampScale(1.1 * 1.1), 1.21, '浮点长尾要收成两位小数')
})

maybe('预设:升序、含默认档、全在范围内', () => {
  const presets = [...scale.SCALE_PRESETS]
  assert.deepEqual(presets, [...presets].sort((a, b) => a - b), '预设必须升序(浮层按顺序排)')
  assert.equal(presets.includes(scale.SCALE_DEFAULT), true, '必须有一档 = 默认档(能一键还原观感)')
  for (const value of presets) {
    assert.equal(value >= scale.SCALE_MIN && value <= scale.SCALE_MAX, true, `${value} 越界`)
    assert.equal(scale.clampScale(value), value, `${value} 不该被夹`)
  }
})

maybe('readScale:没有 key / 无 storage → 默认档', () => {
  assert.equal(scale.readScale(fakeStorage()), scale.SCALE_DEFAULT)
  assert.equal(scale.readScale(null), scale.SCALE_DEFAULT)
  assert.equal(scale.readScale(undefined ?? null), scale.SCALE_DEFAULT)
})

maybe('readScale:读回已存的值并夹取;storage 抛错不影响', () => {
  assert.equal(scale.readScale(fakeStorage({ [scale.SCALE_KEY]: '1.3' })), 1.3)
  assert.equal(scale.readScale(fakeStorage({ [scale.SCALE_KEY]: '99' })), scale.SCALE_MAX)
  assert.equal(scale.readScale(fakeStorage({ [scale.SCALE_KEY]: 'x' })), scale.SCALE_DEFAULT)
  assert.equal(scale.readScale(fakeStorage({}, { throwOnGet: true })), scale.SCALE_DEFAULT, 'getItem 抛错要兜住')
})

maybe('writeScale:写入夹取后的值;setItem 抛错也不抛', () => {
  const storage = fakeStorage()
  assert.equal(scale.writeScale(1.15, storage), 1.15)
  assert.equal(storage.data[scale.SCALE_KEY], '1.15')
  assert.equal(scale.writeScale(3, storage), scale.SCALE_MAX)
  assert.equal(storage.data[scale.SCALE_KEY], '1.5')
  assert.doesNotThrow(() => scale.writeScale(1.2, fakeStorage({}, { throwOnSet: true })))
  assert.equal(scale.writeScale(1.2, null), 1.2)
})

maybe('往返:写进去再读出来是同一个数', () => {
  const storage = fakeStorage()
  for (const value of [...scale.SCALE_PRESETS, scale.SCALE_MIN, 1.07]) {
    scale.writeScale(value, storage)
    assert.equal(scale.readScale(storage), scale.clampScale(value))
  }
})

maybe('scaleVars:给出根节点要用的自定义属性(已夹取)', () => {
  assert.deepEqual(scale.scaleVars(1.3), { '--dsh-notes-scale': '1.3' })
  assert.deepEqual(scale.scaleVars(9), { '--dsh-notes-scale': String(scale.SCALE_MAX) })
  assert.deepEqual(scale.scaleVars('bad'), { '--dsh-notes-scale': String(scale.SCALE_DEFAULT) })
})

maybe('cssSize:设计值 → 系数 + 全局增量的绝对表达式(样式表与行内样式共用)', () => {
  assert.equal(scale.cssSize(13), 'calc(13px * var(--dsh-notes-scale, 1) + var(--dsh-content-font-delta, 0px))')
  assert.equal(scale.cssSize(9.5).includes('9.5px'), true)
  // 两个变量缺一不可:少了增量就不会跟随设置的全局字号
  assert.equal(scale.cssSize(1).includes('--dsh-notes-scale'), true)
  assert.equal(scale.cssSize(1).includes('--dsh-content-font-delta'), true)
})
