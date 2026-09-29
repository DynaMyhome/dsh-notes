/**
 * dsh-notes 客户端样式。
 *
 * 只用官方主题 token(`--dsw-alias-*` / `--dsw-specific-sidebar-fill`),
 * 不写死颜色 —— 明暗主题跟随宿主。
 */
export const CSS = [
  '.dsh-notes-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}',
  '.dsh-notes-header{display:flex;align-items:center;gap:6px;flex:0 0 auto;height:30px;padding:0 8px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill)}',
  '.dsh-notes-title{font-size:12px;font-weight:600;white-space:nowrap}',
  '.dsh-notes-sub{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-notes-spacer{flex:1 1 auto}',
  '.dsh-notes-btn{appearance:none;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:4px;padding:1px 5px;font:inherit;font-size:12px;line-height:1.6;cursor:pointer;white-space:nowrap}',
  '.dsh-notes-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}',
  '.dsh-notes-btn[aria-expanded="true"]{color:var(--dsw-alias-label-primary)}',
  '.dsh-notes-body{display:flex;flex:1 1 auto;min-height:0}',
  '.dsh-notes-tree{flex:0 0 auto;min-width:0;overflow:auto;background:var(--dsw-specific-sidebar-fill);border-right:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column}',
  '.dsh-notes-resizer{flex:0 0 auto;width:4px;cursor:col-resize;background:transparent}',
  '.dsh-notes-resizer:hover{background:var(--dsw-alias-border-l2)}',
  '.dsh-notes-rail{flex:0 0 auto;width:18px;appearance:none;border:0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;font:inherit}',
  '.dsh-notes-rail:hover{color:var(--dsw-alias-label-primary)}',
  '.dsh-notes-editor{flex:1 1 auto;min-width:0;overflow:auto;display:flex;flex-direction:column}',
  '.dsh-notes-empty{display:flex;align-items:center;justify-content:center;flex:1 1 auto;padding:16px;text-align:center;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}',
].join('\n')
