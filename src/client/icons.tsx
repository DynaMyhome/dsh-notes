/**
 * 极简线性图标(内联 SVG,`stroke: currentColor`,14px)。
 *
 * 不引任何图标库:插件自带,不 `require` 宿主 UI 包(见 AGENTS.md 硬规则),
 * 也避免 emoji —— emoji 在文件树里既花又跟主题无关。
 * 尺寸/描边统一:viewBox 16、stroke-width 1.5、round cap/join、`shape-rendering` 默认。
 */

import React from 'react'

/** 图标公共 props。 */
export interface IconProps {
  /** 边长(px),默认 14。 */
  size?: number
  /** 附加 class。 */
  className?: string
}

/** 统一的 svg 外壳。 */
function Svg({ size = 14, className, children }: IconProps & { children: React.ReactNode }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
      style={{ flex: '0 0 auto', display: 'block' }}
    >
      {children}
    </svg>
  )
}

/** 分类(文件夹)。 */
export function IconCollection(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M2 4.6c0-.6.4-1 1-1h2.6l1.2 1.4H13c.6 0 1 .4 1 1v5.4c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z" />
    </Svg>
  )
}

/** 笔记(markdown 文档:页 + 两道线)。 */
export function IconNote(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M4 1.8h5.2L13 5.6v8.6c0 .5-.4.9-.9.9H4c-.5 0-.9-.4-.9-.9V2.7c0-.5.4-.9.9-.9z" />
      <path d="M9 2v3.6h3.7" />
      <path d="M5.6 9.2h4.8M5.6 11.6h3.2" />
    </Svg>
  )
}

/** 未归类(收件箱)。 */
export function IconInbox(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M2 9.2 3.9 3h8.2L14 9.2v3.3c0 .5-.4.9-.9.9H2.9c-.5 0-.9-.4-.9-.9z" />
      <path d="M2 9.2h3.2l.9 1.6h3.8l.9-1.6H14" />
    </Svg>
  )
}

/** 展开箭头(▸),用 rotate 表示展开态。 */
export function IconChevron({ size = 12, className, open = false }: IconProps & { open?: boolean }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
      style={{ flex: '0 0 auto', display: 'block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s ease' }}
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  )
}

/** 新建笔记。 */
export function IconNewNote(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M4 1.8h5L12.6 5.2v3.1" />
      <path d="M8.8 2v3.2h3.4" />
      <path d="M4 1.8c-.5 0-.9.4-.9.9v10.5c0 .5.4.9.9.9h3.2" />
      <path d="M12 9.4v4.4M9.8 11.6h4.4" />
    </Svg>
  )
}

/** 新建分类。 */
export function IconNewFolder(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M1.8 4.6c0-.6.4-1 1-1h2.6l1.2 1.4h4.6" />
      <path d="M1.8 4.6v6.8c0 .6.4 1 1 1h5" />
      <path d="M12 9.6v4.2M9.9 11.7h4.2" />
    </Svg>
  )
}

/** 重新扫描。 */
export function IconRefresh(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M13.2 7.2A5.2 5.2 0 1 0 12 11.6" />
      <path d="M13.6 3.2v4h-4" />
    </Svg>
  )
}

/** 收起树(PanelLeftClose 的极简版)。 */
export function IconCollapse(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <rect x="2" y="2.8" width="12" height="10.4" rx="1.4" />
      <path d="M6 2.8v10.4" />
      <path d="M12 8H8.6M10.2 6.2 8.6 8l1.6 1.8" />
    </Svg>
  )
}

/** 展开树。 */
export function IconExpand(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <rect x="2" y="2.8" width="12" height="10.4" rx="1.4" />
      <path d="M6 2.8v10.4" />
      <path d="M8.6 8H12M10.4 6.2 12 8l-1.6 1.8" />
    </Svg>
  )
}

/** 星标(置顶)。 */
export function IconStar(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M8 2.2 9.7 6h3.9l-3.1 2.4 1.2 3.9L8 10.1 4.3 12.3l1.2-3.9L2.4 6h3.9z" />
    </Svg>
  )
}

/** 外部工作区(↗ 的线性版)。 */
export function IconExternal(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M6.4 3.2H3.4c-.5 0-.9.4-.9.9v8.5c0 .5.4.9.9.9h8.5c.5 0 .9-.4.9-.9V9.6" />
      <path d="M9.6 2.5h3.9v3.9" />
      <path d="M13.2 3.1 7.6 8.7" />
    </Svg>
  )
}

/** 编辑器工具栏图标:粗体 / 斜体 / 高亮 / 标题 / 列表 / 引用 / 行内码 / 链接。 */
export function IconBold(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M4.6 2.8h4a2.6 2.6 0 0 1 0 5.2h-4zM4.6 8h4.6a2.6 2.6 0 0 1 0 5.2H4.6z" />
    </Svg>
  )
}

/** 斜体。 */
export function IconItalic(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M9.6 2.8H6.2M9.8 13.2H6.4M9.4 2.8 6.6 13.2" />
    </Svg>
  )
}

/** 高亮。 */
export function IconHighlight(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M3 13.2h10" />
      <path d="M5.4 10.6 4 9.2c-.4-.4-.4-1 0-1.4l3.7-3.7c.4-.4 1-.4 1.4 0l2.8 2.8c.4.4.4 1 0 1.4l-3.7 3.7c-.4.4-1 .4-1.4 0z" />
      <path d="M8.9 4.2 11.8 7" />
    </Svg>
  )
}

/** 标题 H。 */
export function IconHeading(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M3.2 3.4v9.2M8.8 3.4v9.2M3.2 8h5.6" />
      <path d="M11.4 7.4h2.2v5.2" />
    </Svg>
  )
}

/** 列表。 */
export function IconList(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M5.6 4.2h8M5.6 8h8M5.6 11.8h8" />
      <path d="M2.8 4.2h.01M2.8 8h.01M2.8 11.8h.01" />
    </Svg>
  )
}

/** 引用。 */
export function IconQuote(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M2.8 4.6v6.8" />
      <path d="M6.2 4.6h7M6.2 8h5M6.2 11.4h7" />
    </Svg>
  )
}

/** 行内代码。 */
export function IconCode(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M6 4.4 2.6 8 6 11.6M10 4.4 13.4 8 10 11.6" />
    </Svg>
  )
}

/** 链接 / 图片。 */
export function IconImage(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1.4" />
      <path d="M2.6 11.2 6 8.2l2.4 2.2 2-1.8 3 2.6" />
      <path d="M6.2 6.6h.01" />
    </Svg>
  )
}

/** 保存状态(对勾)。 */
export function IconCheck(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M3.2 8.4 6.4 11.6 12.8 5" />
    </Svg>
  )
}

/** 警告(冲突)。 */
export function IconWarn(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M8 2.6 14.2 13H1.8z" />
      <path d="M8 6.6v3M8 11.4h.01" />
    </Svg>
  )
}
