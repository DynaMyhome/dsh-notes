import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 网页演示(`embed` 围栏)的**纯逻辑**。
 *
 * 这一层必须完全可测:块级 iframe 在 Node 里没法验,但"认不认这段围栏、路径解析成什么、
 * URL 拼得对不对"全在这里 —— 出问题时要能一条规则一个用例地红,而不是靠截图猜。
 */
let mod = null
try {
  mod = await import('../src/client/editor/embed-model.ts')
} catch {
  mod = null
}

const skip = mod === null ? '当前 Node 没有类型剥离能力(用 npm test 跑)' : false

/** 拼一个围栏(避免测试里反引号转义看花眼)。 */
function fence(info, body = '') {
  return ['```' + info, body, '```'].filter((line, index) => index !== 1 || body !== '').join('\n')
}

test('embed 围栏:info 串里的路径', { skip }, () => {
  const parsed = mod.parseEmbedFence(fence('embed ../.dsh-assets/n1/demo.html'))
  assert.deepEqual(parsed, { ok: true, path: '../.dsh-assets/n1/demo.html', title: null, height: null })
  assert.equal(mod.isEmbedFence(fence('embed x.html')), true)
  assert.equal(mod.isEmbedFence(fence('html x.html')), false)
  assert.equal(mod.isEmbedFence(fence('', 'x')), false)
})

test('embed 围栏:路径写在正文首行,`~~~` 等价', () => {
  const tilde = ['~~~embed', '../demo.html', '~~~'].join('\n')
  assert.deepEqual(mod.parseEmbedFence(tilde), { ok: true, path: '../demo.html', title: null, height: null })
})

test('embed 围栏:title / height / path 配置行', () => {
  const source = ['```embed', 'path: ../demo.html', 'title: 三电平 SAR 的 ΔV 与全部码区间', 'height: 640', '```'].join('\n')
  assert.deepEqual(mod.parseEmbedFence(source), {
    ok: true,
    path: '../demo.html',
    title: '三电平 SAR 的 ΔV 与全部码区间',
    height: 640,
  })
})

test('embed 围栏:height 接受 px 并夹到区间内', () => {
  const withPx = ['```embed x.html', 'height: 480px', '```'].join('\n')
  assert.equal(mod.parseEmbedFence(withPx).height, 480)
  const tooSmall = ['```embed x.html', 'height: 20', '```'].join('\n')
  assert.equal(mod.parseEmbedFence(tooSmall).height, mod.EMBED_MIN_HEIGHT)
  const tooBig = ['```embed x.html', 'height: 99999', '```'].join('\n')
  assert.equal(mod.parseEmbedFence(tooBig).height, mod.EMBED_MAX_HEIGHT)
  assert.equal(mod.clampEmbedHeight('abc'), mod.DEFAULT_EMBED_HEIGHT)
})

test('embed 围栏:坏配置 / 缺路径 / 未知键 / 重复路径', () => {
  assert.equal(mod.parseEmbedFence(['```embed', '```'].join('\n')).problem, 'no-path')
  assert.equal(mod.parseEmbedFence(['```embed', 'width: 300', '```'].join('\n')).problem, 'bad-config')
  assert.equal(mod.parseEmbedFence(['```embed', 'height: 很高', '```'].join('\n')).problem, 'bad-config')
  const duplicate = ['```embed a.html', 'path: b.html', '```'].join('\n')
  assert.equal(mod.parseEmbedFence(duplicate).problem, 'bad-config')
  // Windows 盘符里的 `:` 不是配置键,必须当路径
  const drive = ['```embed', 'D:\\ws\\notes\\demo.html', '```'].join('\n')
  assert.equal(mod.parseEmbedFence(drive).ok, true)
  assert.equal(mod.parseEmbedFence(drive).path, 'D:\\ws\\notes\\demo.html')
})

test('planEmbed:相对路径按笔记目录展开、`..` 归一', () => {
  const source = fence('embed ../.dsh-assets/n1/demo.html')
  const plan = mod.planEmbed(source, 'D:/ws/notes/foo.md')
  assert.equal(plan.ok, true)
  assert.equal(plan.absolutePath, 'D:/ws/.dsh-assets/n1/demo.html')
  assert.equal(plan.title, 'demo.html')
  assert.equal(plan.height, null)
})

test('planEmbed:绝对路径原样、标题用 title 覆盖', () => {
  const source = ['```embed C:/ws/demo.html', 'title: 演示', '```'].join('\n')
  const plan = mod.planEmbed(source, 'C:/ws/notes/foo.md')
  assert.equal(plan.ok, true)
  assert.equal(plan.absolutePath, 'C:/ws/demo.html')
  assert.equal(plan.title, '演示')
})

test('planEmbed:远程地址 / 非 html / 无路径 / 没打开笔记', () => {
  assert.equal(mod.planEmbed(fence('embed https://example.com/a.html'), 'C:/ws/n.md').problem, 'remote')
  assert.equal(mod.planEmbed(fence('embed //example.com/a.html'), 'C:/ws/n.md').problem, 'remote')
  assert.equal(mod.planEmbed(fence('embed data:text/html,x'), 'C:/ws/n.md').problem, 'remote')
  assert.equal(mod.planEmbed(fence('embed file:///C:/ws/a.html'), 'C:/ws/n.md').problem, 'remote')
  assert.equal(mod.planEmbed(fence('embed ../demo.txt'), 'C:/ws/n.md').problem, 'not-html')
  assert.equal(mod.planEmbed(fence('embed ../demo.md'), 'C:/ws/n.md').problem, 'not-html')
  assert.equal(mod.planEmbed(fence('embed ../demo.html'), null).problem, 'no-document')
})

test('embedSrc:编码路径、workspaceKey 为空时省略', () => {
  const path = 'D:/项目/ws/.dsh-assets/n1/demo.html'
  const without = mod.embedSrc({ sessionId: 's-1', workspaceKey: null, documentPath: null }, path)
  assert.equal(without, `/dsh-notes/embed?sessionId=s-1&path=${encodeURIComponent(path)}`)
  const withKey = mod.embedSrc({ sessionId: 's-1', workspaceKey: 'k9', documentPath: null }, path)
  assert.equal(withKey, `/dsh-notes/embed?sessionId=s-1&path=${encodeURIComponent(path)}&workspaceKey=k9`)
})

test('withReloadNonce:保留原参数并追加 r=', () => {
  const src = '/dsh-notes/embed?sessionId=s-1&path=x.html'
  const next = mod.withReloadNonce(src, 123)
  assert.equal(next.startsWith('/dsh-notes/embed?'), true)
  assert.equal(next.includes('sessionId=s-1'), true)
  assert.equal(next.includes('r=123'), true)
})

test('basenameOf:两种分隔符', () => {
  assert.equal(mod.basenameOf('D:/ws/.dsh-assets/n1/demo.html'), 'demo.html')
  assert.equal(mod.basenameOf('D:\\ws\\demo.html'), 'demo.html')
  assert.equal(mod.basenameOf('demo.html'), 'demo.html')
})
