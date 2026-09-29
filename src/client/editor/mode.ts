/**
 * 编辑模式开关(模块级单例)。
 *
 * - `preview`(默认):Typora 式 —— **标记一律隐藏**(`#`、`>`、`-`、`**`、`|` 都看不见),
 *   文字照样直接编辑;光标进入也不还原成源码。
 * - `source`:源码模式 —— 完全不生成装饰,看到的就是磁盘上的纯 markdown。
 *
 * 放模块级而不是 React state:装饰层(决策层/StateField)都在编辑器的扩展里,
 * 切模式时由外壳重建编辑器,读这个标志即可。
 */

/** 当前是否源码模式。 */
let sourceMode = false

/** 读模式。 */
export function isSourceMode(): boolean {
  return sourceMode
}

/** 设模式(切完由外壳重建编辑器使装饰生效)。 */
export function setSourceMode(value: boolean): void {
  sourceMode = value
}
