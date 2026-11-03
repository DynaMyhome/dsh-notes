/**
 * 图片 widget 的 DOM 外壳(**两处渲染点共用**)。
 *
 * 图片有两个渲染点:主装饰层(`decorate.ts` 的 `ImageWidget`,带 `from/to` 点击还原)
 * 与回退装饰层(`setup.ts` 里的同款 widget,树装饰构建失败时兜底)。以前两边各写一遍
 * `<img>` + 图题,于是"给图片预留尺寸"这种事就得改两处、漏一处就退化。
 *
 * 这里只负责 DOM 与尺寸缓存,不 import `decorate.ts` / `setup.ts`
 * (模块环会以 `Cannot access '<x>' before initialization` 的形式炸面板,
 * `media.ts` 就是为这件事单独成模块的)。
 */

import { imageSizes } from '../image-size'
import { renderCell } from './cell-render'
import { parseInlineMarkdown } from './inline-parse'

/**
 * 建一个行内图片节点:`<span.dsh-cm-image><img><span.dsh-cm-image-caption>图题</span></span>`。
 *
 * **尺寸要预留**(用户实测:滚动时内容会突然往下跳一截):`<img>` 只有在位图到位后才有
 * 高度,而图片行可以高到 `max-height:320px` —— 重建 widget 时先 `h=0`、再涨回去,
 * CM6 的行高测量就跟着抖两下。所以命中 `imageSizes` 的图片**一开始就把 `width`/`height`
 * 写到 `<img>` 上**(带这两个属性时,位图未到也已经占好最终盒子;CSS 的
 * `max-width:100%` / `max-height:320px` 照常夹取),并在 `load` 时把量到的固有尺寸
 * 记回去给下一次用。
 *
 * @param url - 已经解析好的 `<img src>`(见 `media.ts`)。
 * @param alt - 原始 alt 文本(无障碍用原文;显示的是渲染过的图题)。
 */
export function imageNode(url: string, alt: string): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = 'dsh-cm-image'
  const img = document.createElement('img')
  const known = imageSizes.sizeOf(url)
  if (known !== null) {
    // 注意写的是**属性**(不是 style):CSS 里的 max-width/max-height 仍然生效(实测
    // `width=800 height=1600` → 盒子 460×320,位图未到也已是最终尺寸)。
    img.width = known.w
    img.height = known.h
  }
  img.src = url
  // `img.alt` 保留**原文**(无障碍/纯文本场景要的是原始说明,不是渲染结果)
  img.alt = alt
  img.loading = 'lazy'
  img.addEventListener(
    'load',
    () => {
      const w = img.naturalWidth
      const h = img.naturalHeight
      if (!(w > 0) || !(h > 0)) return
      imageSizes.remember(url, w, h)
      // 之前没记过 → 现在才知道;记过但和这次不一致(图被换过)→ 就地改正。
      // 都是"只跳这一次",之后所有 widget 都直接命中缓存。
      if (known === null || known.w !== w || known.h !== h) {
        img.width = w
        img.height = h
      }
    },
    { once: true },
  )
  const caption = document.createElement('span')
  caption.className = 'dsh-cm-image-caption'
  // 图题(alt 文本)里常有公式 —— 论文图注的典型写法是
  // `![图 4 纳米孔源 + 运放 $A$ + 单位增益 buffer $A_1$](…)`,所以走行内渲染。
  // 双链按"不存在"处理(空 knownTitles):图题里的 `[[…]]` 没有实际意义。
  caption.append(renderCell(alt, parseInlineMarkdown))
  wrap.append(img, caption)
  return wrap
}
