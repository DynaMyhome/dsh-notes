/** 构建产物:由 scripts/build.mjs 生成,请勿手改。源码在 src/client/。 */
window.__ModuleLoader__.load({
  id: 'dsh-notes',
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/main.tsx
var main_exports = {};
__export(main_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(main_exports);

// src/client/NotesPane.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var TREE_MIN = 160;
var TREE_MAX = 420;
var TREE_DEFAULT = 220;
function NotesPane(props) {
  const t = props.t;
  const [treeOpen, setTreeOpen] = (0, import_react.useState)(true);
  const [treeWidth, setTreeWidth] = (0, import_react.useState)(TREE_DEFAULT);
  const drag = (0, import_react.useRef)(null);
  const onPointerDown = (0, import_react.useCallback)(
    (event) => {
      const target = event.currentTarget;
      target.setPointerCapture?.(event.pointerId);
      drag.current = { startX: event.clientX, startWidth: treeWidth };
      event.preventDefault();
    },
    [treeWidth]
  );
  const onPointerMove = (0, import_react.useCallback)((event) => {
    const state = drag.current;
    if (state === null) return;
    const next = Math.min(TREE_MAX, Math.max(TREE_MIN, state.startWidth + (event.clientX - state.startX)));
    setTreeWidth(next);
  }, []);
  const onPointerUp = (0, import_react.useCallback)((event) => {
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);
  const toggleLabel = treeOpen ? t("tree.collapse") : t("tree.expand");
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-notes-root", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-notes-header", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-notes-title", children: t("tab.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-notes-sub", children: t("p0.notice") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-notes-spacer" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: "dsh-notes-btn",
          title: toggleLabel,
          "aria-label": toggleLabel,
          "aria-expanded": treeOpen,
          onClick: () => setTreeOpen((open) => !open),
          children: treeOpen ? "\u2BC7" : "\u2BC8"
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-notes-body", children: [
      treeOpen ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("aside", { className: "dsh-notes-tree", style: { width: `${treeWidth}px` }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-notes-empty", children: t("tree.pending") }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "div",
          {
            className: "dsh-notes-resizer",
            role: "separator",
            "aria-orientation": "vertical",
            "aria-label": t("tree.resize"),
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel: onPointerUp
          }
        )
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: "dsh-notes-rail",
          title: toggleLabel,
          "aria-label": toggleLabel,
          onClick: () => setTreeOpen(true),
          children: "\u203A"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("section", { className: "dsh-notes-editor", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-notes-empty", children: t("editor.pending") }) })
    ] })
  ] });
}

// src/client/styles.ts
var CSS = [
  ".dsh-notes-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}",
  ".dsh-notes-header{display:flex;align-items:center;gap:6px;flex:0 0 auto;height:30px;padding:0 8px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill)}",
  ".dsh-notes-title{font-size:12px;font-weight:600;white-space:nowrap}",
  ".dsh-notes-sub{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".dsh-notes-spacer{flex:1 1 auto}",
  ".dsh-notes-btn{appearance:none;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:4px;padding:1px 5px;font:inherit;font-size:12px;line-height:1.6;cursor:pointer;white-space:nowrap}",
  ".dsh-notes-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}",
  '.dsh-notes-btn[aria-expanded="true"]{color:var(--dsw-alias-label-primary)}',
  ".dsh-notes-body{display:flex;flex:1 1 auto;min-height:0}",
  ".dsh-notes-tree{flex:0 0 auto;min-width:0;overflow:auto;background:var(--dsw-specific-sidebar-fill);border-right:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column}",
  ".dsh-notes-resizer{flex:0 0 auto;width:4px;cursor:col-resize;background:transparent}",
  ".dsh-notes-resizer:hover{background:var(--dsw-alias-border-l2)}",
  ".dsh-notes-rail{flex:0 0 auto;width:18px;appearance:none;border:0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;font:inherit}",
  ".dsh-notes-rail:hover{color:var(--dsw-alias-label-primary)}",
  ".dsh-notes-editor{flex:1 1 auto;min-width:0;overflow:auto;display:flex;flex-direction:column}",
  ".dsh-notes-empty{display:flex;align-items:center;justify-content:center;flex:1 1 auto;padding:16px;text-align:center;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}"
].join("\n");

// src/client/main.tsx
var PKG = "dsh-notes";
var ID = "dsh-notes";
var KIND = "notes";
var NS = "dshNotes";
var ZH = {
  "tab.title": "\u7B14\u8BB0",
  "tab.guide": "\u6253\u5F00\u7B14\u8BB0\u533A\u57DF:\u5DE6\u4FA7\u7B14\u8BB0\u6811(\u5206\u7C7B / \u672A\u5F52\u7C7B),\u53F3\u4FA7 Markdown \u7F16\u8F91\u5668\u3002",
  "p0.notice": "\u9AA8\u67B6",
  "tree.collapse": "\u6536\u8D77\u7B14\u8BB0\u6811",
  "tree.expand": "\u5C55\u5F00\u7B14\u8BB0\u6811",
  "tree.resize": "\u62D6\u52A8\u8C03\u6574\u7B14\u8BB0\u6811\u5BBD\u5EA6",
  "tree.pending": "\u7B14\u8BB0\u6811\u5C06\u5728 P1 \u63A5\u5165(\u7D22\u5F15\u4E0E\u5DE5\u4F5C\u533A\u7ED1\u5B9A)\u3002",
  "editor.pending": "\u7F16\u8F91\u5668\u5C06\u5728 P2 \u63A5\u5165(CodeMirror 6)\u3002"
};
var EN = {
  "tab.title": "Notes",
  "tab.guide": "Open the notes area: a notes tree (collections / unfiled) beside a Markdown editor.",
  "p0.notice": "skeleton",
  "tree.collapse": "Collapse notes tree",
  "tree.expand": "Expand notes tree",
  "tree.resize": "Drag to resize the notes tree",
  "tree.pending": "The notes tree arrives in P1 (index + workspace binding).",
  "editor.pending": "The editor arrives in P2 (CodeMirror 6)."
};
function apply(ctx) {
  ctx.effect(
    () => ctx.locale.register(NS, { zh: ZH, en: EN }),
    "dsh-notes: dictionaries"
  );
  ctx.effect(() => {
    if (typeof document === "undefined") return () => {
    };
    const tag = document.createElement("style");
    tag.dataset.plugin = PKG;
    tag.textContent = CSS;
    document.head.appendChild(tag);
    return () => {
      if (tag.parentNode !== null) tag.parentNode.removeChild(tag);
    };
  }, "dsh-notes: styles");
  const t = ctx.locale.bind(NS);
  ctx.effect(
    () => ctx.sidebarRightTabs.register({
      id: ID,
      kind: KIND,
      title: () => t("tab.title"),
      guide: [
        {
          id: PKG,
          order: 40,
          title: () => t("tab.title"),
          description: () => t("tab.guide")
        }
      ]
    }),
    "dsh-notes: tab type"
  );
  ctx.slots.inject(
    "sidebar.right.pane.tab",
    () => ctx.slots.register(
      {
        name: "sidebar.right.pane.tab",
        key: ID,
        locale: NS
      },
      NotesPane
    )
  );
}
var inject = ["slots", "locale", "sidebarRightTabs"];

    return module.exports;
  },
});
