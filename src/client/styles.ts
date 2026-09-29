/**
 * dsh-notes 客户端样式。
 *
 * 只用官方主题 token(`--dsw-alias-*` / `--dsw-specific-sidebar-fill`),
 * 不写死颜色 —— 明暗主题跟随宿主。
 */
export const CSS = [
  /* 外壳 */
  '.dsh-notes-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}',
  '.dsh-notes-header{display:flex;align-items:center;gap:4px;flex:0 0 auto;height:30px;padding:0 8px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill)}',
  '.dsh-notes-title{font-size:12px;font-weight:600;white-space:nowrap}',
  '.dsh-notes-sub{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-notes-spacer{flex:1 1 auto}',
  '.dsh-notes-btn{appearance:none;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:5px;padding:2px 6px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;white-space:nowrap}',
  '.dsh-notes-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}',
  '.dsh-notes-btn[disabled]{opacity:.45;cursor:default}',
  '.dsh-notes-body{display:flex;flex:1 1 auto;min-height:0}',

  /* 树列 */
  '.dsh-notes-tree{flex:0 0 auto;min-width:0;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-specific-sidebar-fill);border-right:1px solid var(--dsw-alias-border-l1)}',
  '.dsh-notes-tree-inner{display:flex;flex-direction:column;min-height:0;flex:1 1 auto}',
  '.dsh-notes-tree-head{display:flex;align-items:center;gap:4px;flex:0 0 auto;min-height:30px;padding:0 6px 0 8px;font-size:12px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1)}',
  '.dsh-notes-tree-title{font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-notes-tree-body{flex:1 1 auto;min-height:0;overflow:auto;padding:3px 0}',
  '.dsh-notes-row{display:flex;align-items:center;gap:4px;height:26px;padding-right:6px;font-size:13px;cursor:pointer;white-space:nowrap;user-select:none}',
  '.dsh-notes-row:hover{background:var(--dsw-alias-bg-layer-2)}',
  '.dsh-notes-row-selected{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}',
  '.dsh-notes-row-ref .dsh-notes-row-label{color:var(--dsw-alias-label-secondary)}',
  /* 分类 vs 笔记:一眼可分 —— 分类加粗带文件夹;笔记常规字重、次要色 */
  '.dsh-notes-row-collection .dsh-notes-row-label{font-weight:600;color:var(--dsw-alias-label-primary)}',
  '.dsh-notes-row-note .dsh-notes-row-label,.dsh-notes-row-unfiled .dsh-notes-row-label{color:var(--dsw-alias-label-secondary)}',
  '.dsh-notes-row-note.dsh-notes-row-selected .dsh-notes-row-label{color:var(--dsw-alias-label-primary)}',
  '.dsh-notes-row-drop{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}',
  '.dsh-notes-drop-root{box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}',
  '.dsh-notes-glyph{flex:0 0 auto;font-size:11px;line-height:1;opacity:.9}',
  '.dsh-notes-caret{flex:0 0 auto;width:12px;font-size:11px;color:var(--dsw-alias-label-secondary);text-align:center}',
  '.dsh-notes-row-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-notes-count{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-secondary)}',
  '.dsh-notes-badge{flex:0 0 auto;max-width:120px;overflow:hidden;text-overflow:ellipsis;font-size:11px;padding:0 5px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;color:var(--dsw-alias-label-secondary)}',
  '.dsh-notes-hint{padding:7px 10px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1)}',

  /* 输入条 / 状态 */
  '.dsh-notes-compose{display:flex;align-items:center;gap:4px;padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
  '.dsh-notes-input{flex:1 1 auto;min-width:0;box-sizing:border-box;padding:3px 7px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
  '.dsh-notes-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
  '.dsh-notes-status{padding:3px 10px;font-size:11px;color:var(--dsw-alias-state-success-primary);border-bottom:1px solid var(--dsw-alias-border-l1);animation:dsh-notes-status-fade 2.4s forwards}',
  '@keyframes dsh-notes-status-fade{0%,70%{opacity:1}100%{opacity:0}}',
  '.dsh-notes-error{padding:4px 10px;font-size:11px;line-height:1.6;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}',

  /* 分隔条 / 收起条 */
  '.dsh-notes-resizer{flex:0 0 auto;width:4px;cursor:col-resize;background:transparent}',
  '.dsh-notes-resizer:hover{background:var(--dsw-alias-border-l2)}',
  '.dsh-notes-rail{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:4px;width:30px;padding:4px 0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill)}',
  '.dsh-notes-rail .dsh-notes-btn{min-width:24px;padding:3px 0;font-size:17px;line-height:1;text-align:center}',
  '.dsh-notes-toolbar{display:flex;align-items:center;gap:2px;flex:0 0 auto}',
  '.dsh-notes-toolbar .dsh-notes-btn{min-width:24px;padding:2px 0;font-size:16px;line-height:1.2;text-align:center}',

  /* 编辑区 */
  '.dsh-notes-editor{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;overflow:auto}',
  '.dsh-notes-empty{display:flex;align-items:center;justify-content:center;flex:1 1 auto;padding:16px;text-align:center;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary)}',
  '.dsh-notes-placeholder{display:flex;flex-direction:column;gap:6px;padding:14px 16px}',
  '.dsh-notes-placeholder-title{font-size:15px;font-weight:600}',
  '.dsh-notes-dim{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
  '.dsh-notes-mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);word-break:break-all}',
].join('\n')
