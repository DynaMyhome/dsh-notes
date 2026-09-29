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
var import_react2 = require("react");

// src/client/api.ts
var PREFIX = "/dsh-notes";
var RouteError = class extends Error {
  code;
  currentVersion;
  currentText;
  constructor(message, code, extra = {}) {
    super(message);
    this.name = "RouteError";
    this.code = code;
    this.currentVersion = extra.currentVersion;
    this.currentText = extra.currentText;
  }
};
async function unwrap(response) {
  let envelope = null;
  try {
    envelope = await response.json();
  } catch {
    throw new RouteError(`\u8DEF\u7531\u8FD4\u56DE\u4E86\u975E JSON(HTTP ${response.status})`, "BAD_RESPONSE");
  }
  if (envelope === null || envelope.ok !== true) {
    throw new RouteError(
      String(envelope?.error ?? `\u8DEF\u7531\u5931\u8D25(HTTP ${response.status})`),
      String(envelope?.code ?? "ERROR"),
      { currentVersion: envelope?.currentVersion, currentText: envelope?.currentText }
    );
  }
  return envelope.value;
}
async function fetchTree(sessionId, force = false) {
  const query = new URLSearchParams({ sessionId });
  if (force) query.set("force", "1");
  const response = await fetch(`${PREFIX}/tree?${query.toString()}`, { credentials: "same-origin" });
  return await unwrap(response);
}
async function call(action, payload) {
  const response = await fetch(`${PREFIX}/${action}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return await unwrap(response);
}

// src/client/TreePane.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
function TreePane(props) {
  const { t, tree, loading, error, selectedId } = props;
  const [collapsed, setCollapsed] = (0, import_react.useState)(() => /* @__PURE__ */ new Set());
  const rows = (0, import_react.useMemo)(() => {
    if (tree === null) return [];
    const out = [];
    const childrenOf = /* @__PURE__ */ new Map();
    for (const node of tree.collections) {
      const list = childrenOf.get(node.parentId) ?? [];
      list.push(node.id);
      childrenOf.set(node.parentId, list);
    }
    const notesOf = /* @__PURE__ */ new Map();
    for (const note of tree.notes) {
      const list = notesOf.get(note.collectionId) ?? [];
      list.push(note);
      notesOf.set(note.collectionId, list);
    }
    const walk = (parentId, depth) => {
      for (const nodeId of childrenOf.get(parentId) ?? []) {
        const node = tree.collections.find((item) => item.id === nodeId);
        if (node === void 0) continue;
        const kids = (childrenOf.get(node.id) ?? []).length + (notesOf.get(node.id) ?? []).length;
        const isCollapsed = collapsed.has(node.id);
        out.push({
          key: `c:${node.id}`,
          kind: "collection",
          depth,
          label: node.name,
          count: node.count,
          hasChildren: kids > 0,
          collapsed: isCollapsed
        });
        if (isCollapsed) continue;
        walk(node.id, depth + 1);
      }
      for (const note of notesOf.get(parentId) ?? []) {
        out.push({
          key: `n:${note.id}`,
          kind: "note",
          depth,
          label: note.title,
          selected: note.id === selectedId,
          badge: note.pinned ? "\u2605" : void 0,
          target: note
        });
      }
    };
    walk(null, 0);
    for (const ref of tree.refs) {
      out.push({
        key: `r:${ref.noteId}`,
        kind: "ref",
        depth: 0,
        label: ref.title,
        badge: `\u2197 ${ref.workspaceName}`,
        target: ref
      });
    }
    if (tree.unfiled.length > 0) {
      out.push({
        key: "unfiled",
        kind: "collection",
        depth: 0,
        label: t("tree.unfiled"),
        count: tree.unfiled.length,
        hasChildren: true,
        collapsed: collapsed.has("__unfiled")
      });
      if (!collapsed.has("__unfiled")) {
        for (const file of tree.unfiled) {
          out.push({
            key: `u:${file.path}`,
            kind: "unfiled",
            depth: 1,
            label: file.title,
            badge: tree.unfiledTruncated ? "\u2026" : void 0,
            target: file
          });
        }
      }
    }
    return out;
  }, [tree, collapsed, selectedId, t]);
  const toggle = (key) => {
    setCollapsed((current) => {
      const next = new Set(current);
      const id = key.startsWith("c:") ? key.slice(2) : "__unfiled";
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-notes-tree-inner", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-notes-tree-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-notes-tree-title", title: tree?.workspace.root ?? "", children: tree?.workspace.name ?? t("tree.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-notes-spacer" }),
      loading ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-notes-dim", children: "\u2026" }) : null,
      props.toolbar !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-notes-toolbar", children: props.toolbar }) : null
    ] }),
    props.header,
    error !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-notes-error", children: error }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-notes-tree-body", children: rows.length === 0 && !loading ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-notes-empty", children: t("tree.empty") }) : rows.map((row) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "div",
      {
        className: [
          "dsh-notes-row",
          row.selected ? "dsh-notes-row-selected" : "",
          row.kind === "ref" ? "dsh-notes-row-ref" : ""
        ].filter(Boolean).join(" "),
        style: { paddingLeft: `${6 + row.depth * 12}px` },
        role: "treeitem",
        "aria-selected": row.selected === true,
        onClick: () => {
          if (row.kind === "collection") toggle(row.key);
          else if (row.kind === "note" && row.target !== void 0) props.onSelectNote(row.target);
          else if (row.kind === "ref" && row.target !== void 0) props.onSelectRef(row.target);
          else if (row.kind === "unfiled" && row.target !== void 0) props.onFileAction(row.target);
        },
        children: [
          row.hasChildren === true ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-notes-caret", children: row.collapsed === true ? "\u25B8" : "\u25BE" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-notes-caret" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-notes-row-label", title: row.label, children: row.label }),
          row.count !== void 0 && row.count > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-notes-count", children: row.count }) : null,
          row.badge !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-notes-badge", children: row.badge }) : null
        ]
      },
      row.key
    )) }),
    tree !== null && tree.stats.unfiled === 0 && tree.stats.notes === 0 && !loading ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-notes-hint", children: t("tree.hint") }) : null
  ] });
}

// src/client/NotesPane.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var TREE_MIN = 160;
var TREE_MAX = 420;
var TREE_DEFAULT = 220;
function NotesPane(props) {
  const t = props.t;
  const sessionId = props.sessionId ?? "";
  const [treeOpen, setTreeOpen] = (0, import_react2.useState)(true);
  const [treeWidth, setTreeWidth] = (0, import_react2.useState)(TREE_DEFAULT);
  const [tree, setTree] = (0, import_react2.useState)(null);
  const [loading, setLoading] = (0, import_react2.useState)(false);
  const [error, setError] = (0, import_react2.useState)(null);
  const [status, setStatus] = (0, import_react2.useState)(null);
  const [selected, setSelected] = (0, import_react2.useState)(null);
  const [selectedRef, setSelectedRef] = (0, import_react2.useState)(null);
  const [compose, setCompose] = (0, import_react2.useState)(null);
  const [draft, setDraft] = (0, import_react2.useState)("");
  const [busy, setBusy] = (0, import_react2.useState)(false);
  const drag = (0, import_react2.useRef)(null);
  const inputRef = (0, import_react2.useRef)(null);
  const refresh = (0, import_react2.useCallback)(
    async (force = false) => {
      if (sessionId === "") return;
      setLoading(true);
      try {
        const next = await fetchTree(sessionId, force);
        setTree(next);
        setError(null);
        setSelected((current) => {
          if (current === null) return current;
          return next.notes.find((note) => note.id === current.id) ?? null;
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoading(false);
      }
    },
    [sessionId]
  );
  (0, import_react2.useEffect)(() => {
    void refresh();
  }, [refresh]);
  (0, import_react2.useEffect)(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  (0, import_react2.useEffect)(() => {
    if (compose !== null && inputRef.current !== null) {
      inputRef.current.value = "";
      inputRef.current.focus();
    }
  }, [compose]);
  (0, import_react2.useEffect)(() => {
    if (compose === null) return void 0;
    const onPointerDown2 = (event) => {
      const target = event.target;
      if (target !== null && target.closest(".dsh-notes-compose") !== null) return;
      setCompose(null);
      setDraft("");
    };
    document.addEventListener("pointerdown", onPointerDown2, true);
    return () => document.removeEventListener("pointerdown", onPointerDown2, true);
  }, [compose]);
  const run = (0, import_react2.useCallback)(
    async (action, payload, done) => {
      if (busy) return;
      if (sessionId === "") {
        setError(t("status.noSession"));
        return;
      }
      setBusy(true);
      try {
        const value = await call(action, { sessionId, ...payload });
        done?.(value);
        await refresh(true);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, sessionId, t]
  );
  const submitCompose = (0, import_react2.useCallback)(async () => {
    const domValue = document.querySelector(".dsh-notes-input")?.value;
    const text = String(domValue ?? inputRef.current?.value ?? draft).trim();
    if (text === "" || compose === null) {
      setCompose(null);
      setDraft("");
      return;
    }
    if (compose === "note") {
      await run("create", { title: text, collectionId: selected?.collectionId ?? null }, (note) => {
        setSelected(note);
        setStatus(t("status.created"));
      });
    } else {
      await run("collection", { op: "create", name: text, parentId: null }, () => setStatus(t("status.collectionCreated")));
    }
    setCompose(null);
    setDraft("");
  }, [compose, draft, run, selected, t]);
  const onPointerDown = (0, import_react2.useCallback)(
    (event) => {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = { startX: event.clientX, startWidth: treeWidth };
      event.preventDefault();
    },
    [treeWidth]
  );
  const onPointerMove = (0, import_react2.useCallback)((event) => {
    const state = drag.current;
    if (state === null) return;
    setTreeWidth(Math.min(TREE_MAX, Math.max(TREE_MIN, state.startWidth + (event.clientX - state.startX))));
  }, []);
  const onPointerUp = (0, import_react2.useCallback)((event) => {
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);
  const onFileAction = (0, import_react2.useCallback)(
    (file) => {
      void run("register", { path: file.path }, () => setStatus(t("status.registered")));
    },
    [run, t]
  );
  const toggleLabel = treeOpen ? t("tree.collapse") : t("tree.expand");
  const toolbar = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "button",
      {
        type: "button",
        className: "dsh-notes-btn",
        title: t("action.newNote"),
        "aria-label": t("action.newNote"),
        disabled: busy,
        onClick: () => {
          setCompose((current) => current === "note" ? null : "note");
          setDraft("");
        },
        children: "\uFF0B"
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "button",
      {
        type: "button",
        className: "dsh-notes-btn",
        title: t("action.newCollection"),
        "aria-label": t("action.newCollection"),
        disabled: busy,
        onClick: () => {
          setCompose((current) => current === "collection" ? null : "collection");
          setDraft("");
        },
        children: "\u229E"
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "button",
      {
        type: "button",
        className: "dsh-notes-btn",
        title: t("action.rescan"),
        "aria-label": t("action.rescan"),
        disabled: busy || loading,
        onClick: () => {
          void refresh(true).then(() => setStatus(t("status.rescanned")));
        },
        children: "\u27F3"
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
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
  ] });
  const composeRow = compose === null ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsh-notes-compose", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "input",
      {
        ref: inputRef,
        className: "dsh-notes-input",
        defaultValue: "",
        placeholder: compose === "note" ? t("compose.note") : t("compose.collection"),
        onKeyDown: (event) => {
          if (event.key === "Enter") void submitCompose();
          if (event.key === "Escape") {
            setCompose(null);
            setDraft("");
          }
        }
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dsh-notes-btn", onClick: () => void submitCompose(), children: t("compose.ok") })
  ] });
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsh-notes-root", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsh-notes-header", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsh-notes-title", children: t("tab.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsh-notes-sub", children: sessionId === "" ? t("status.noSession") : tree === null ? t("tree.loading") : t("tree.summary").replace("{n}", String(tree.stats.notes)) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsh-notes-spacer" })
    ] }),
    status !== null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dsh-notes-status", onAnimationEnd: () => setStatus(null), children: status }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsh-notes-body", children: [
      treeOpen ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("aside", { className: "dsh-notes-tree", style: { width: `${treeWidth}px` }, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          TreePane,
          {
            t,
            tree,
            loading,
            error,
            selectedId: selected?.id ?? null,
            toolbar,
            header: composeRow,
            onSelectNote: (note) => {
              setSelected(note);
              setSelectedRef(null);
            },
            onSelectRef: (ref) => {
              setSelectedRef(ref);
              setSelected(null);
            },
            onFileAction
          }
        ) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
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
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsh-notes-rail", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "button",
          {
            type: "button",
            className: "dsh-notes-btn",
            title: t("action.newNote"),
            "aria-label": t("action.newNote"),
            onClick: () => {
              setTreeOpen(true);
              setCompose("note");
              setDraft("");
            },
            children: "\uFF0B"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "button",
          {
            type: "button",
            className: "dsh-notes-btn",
            title: t("action.newCollection"),
            "aria-label": t("action.newCollection"),
            onClick: () => {
              setTreeOpen(true);
              setCompose("collection");
              setDraft("");
            },
            children: "\u229E"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "button",
          {
            type: "button",
            className: "dsh-notes-btn",
            title: t("action.rescan"),
            "aria-label": t("action.rescan"),
            disabled: busy || loading,
            onClick: () => {
              void refresh(true).then(() => setStatus(t("status.rescanned")));
            },
            children: "\u27F3"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "button",
          {
            type: "button",
            className: "dsh-notes-btn",
            title: toggleLabel,
            "aria-label": toggleLabel,
            "aria-expanded": false,
            onClick: () => setTreeOpen(true),
            children: "\u25B8"
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("section", { className: "dsh-notes-editor", children: selectedRef !== null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsh-notes-placeholder", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dsh-notes-placeholder-title", children: selectedRef.title }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dsh-notes-dim", children: t("editor.refFrom").replace("{name}", selectedRef.workspaceName) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dsh-notes-dim dsh-notes-mono", children: selectedRef.relPath })
      ] }) : selected !== null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsh-notes-placeholder", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dsh-notes-placeholder-title", children: selected.title }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dsh-notes-dim dsh-notes-mono", children: selected.relPath }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dsh-notes-dim", children: t("editor.pending") })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dsh-notes-empty", children: t("editor.noSelection") }) })
    ] })
  ] });
}

// src/client/styles.ts
var CSS = [
  /* 外壳 */
  ".dsh-notes-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}",
  ".dsh-notes-header{display:flex;align-items:center;gap:4px;flex:0 0 auto;height:30px;padding:0 8px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill)}",
  ".dsh-notes-title{font-size:12px;font-weight:600;white-space:nowrap}",
  ".dsh-notes-sub{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".dsh-notes-spacer{flex:1 1 auto}",
  ".dsh-notes-btn{appearance:none;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:5px;padding:2px 6px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;white-space:nowrap}",
  ".dsh-notes-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}",
  ".dsh-notes-btn[disabled]{opacity:.45;cursor:default}",
  ".dsh-notes-body{display:flex;flex:1 1 auto;min-height:0}",
  /* 树列 */
  ".dsh-notes-tree{flex:0 0 auto;min-width:0;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-specific-sidebar-fill);border-right:1px solid var(--dsw-alias-border-l1)}",
  ".dsh-notes-tree-inner{display:flex;flex-direction:column;min-height:0;flex:1 1 auto}",
  ".dsh-notes-tree-head{display:flex;align-items:center;gap:4px;flex:0 0 auto;min-height:30px;padding:0 6px 0 8px;font-size:12px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1)}",
  ".dsh-notes-tree-title{font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".dsh-notes-tree-body{flex:1 1 auto;min-height:0;overflow:auto;padding:3px 0}",
  ".dsh-notes-row{display:flex;align-items:center;gap:4px;height:26px;padding-right:6px;font-size:13px;cursor:pointer;white-space:nowrap;user-select:none}",
  ".dsh-notes-row:hover{background:var(--dsw-alias-bg-layer-2)}",
  ".dsh-notes-row-selected{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}",
  ".dsh-notes-row-ref .dsh-notes-row-label{color:var(--dsw-alias-label-secondary)}",
  ".dsh-notes-caret{flex:0 0 auto;width:12px;font-size:11px;color:var(--dsw-alias-label-secondary);text-align:center}",
  ".dsh-notes-row-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}",
  ".dsh-notes-count{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-secondary)}",
  ".dsh-notes-badge{flex:0 0 auto;max-width:120px;overflow:hidden;text-overflow:ellipsis;font-size:11px;padding:0 5px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;color:var(--dsw-alias-label-secondary)}",
  ".dsh-notes-hint{padding:7px 10px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1)}",
  /* 输入条 / 状态 */
  ".dsh-notes-compose{display:flex;align-items:center;gap:4px;padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
  ".dsh-notes-input{flex:1 1 auto;min-width:0;box-sizing:border-box;padding:3px 7px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}",
  ".dsh-notes-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
  ".dsh-notes-status{padding:3px 10px;font-size:11px;color:var(--dsw-alias-state-success-primary);border-bottom:1px solid var(--dsw-alias-border-l1);animation:dsh-notes-status-fade 2.4s forwards}",
  "@keyframes dsh-notes-status-fade{0%,70%{opacity:1}100%{opacity:0}}",
  ".dsh-notes-error{padding:4px 10px;font-size:11px;line-height:1.6;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}",
  /* 分隔条 / 收起条 */
  ".dsh-notes-resizer{flex:0 0 auto;width:4px;cursor:col-resize;background:transparent}",
  ".dsh-notes-resizer:hover{background:var(--dsw-alias-border-l2)}",
  ".dsh-notes-rail{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:4px;width:30px;padding:4px 0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill)}",
  ".dsh-notes-rail .dsh-notes-btn{min-width:24px;padding:3px 0;font-size:17px;line-height:1;text-align:center}",
  ".dsh-notes-toolbar{display:flex;align-items:center;gap:2px;flex:0 0 auto}",
  ".dsh-notes-toolbar .dsh-notes-btn{min-width:24px;padding:2px 0;font-size:16px;line-height:1.2;text-align:center}",
  /* 编辑区 */
  ".dsh-notes-editor{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;overflow:auto}",
  ".dsh-notes-empty{display:flex;align-items:center;justify-content:center;flex:1 1 auto;padding:16px;text-align:center;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary)}",
  ".dsh-notes-placeholder{display:flex;flex-direction:column;gap:6px;padding:14px 16px}",
  ".dsh-notes-placeholder-title{font-size:15px;font-weight:600}",
  ".dsh-notes-dim{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary)}",
  ".dsh-notes-mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);word-break:break-all}"
].join("\n");

// src/client/main.tsx
var PKG = "dsh-notes";
var ID = "dsh-notes";
var KIND = "notes";
var NS = "dshNotes";
var ZH = {
  "tab.title": "\u7B14\u8BB0",
  "tab.guide": "\u6253\u5F00\u7B14\u8BB0\u533A\u57DF:\u5DE6\u4FA7\u7B14\u8BB0\u6811(\u5206\u7C7B / \u672A\u5F52\u7C7B),\u53F3\u4FA7 Markdown \u7F16\u8F91\u5668\u3002",
  "tree.collapse": "\u6536\u8D77\u7B14\u8BB0\u6811",
  "tree.expand": "\u5C55\u5F00\u7B14\u8BB0\u6811",
  "tree.resize": "\u62D6\u52A8\u8C03\u6574\u7B14\u8BB0\u6811\u5BBD\u5EA6",
  "tree.title": "\u7B14\u8BB0\u6811",
  "tree.loading": "\u8BFB\u53D6\u4E2D\u2026",
  "tree.summary": "{n} \u7BC7\u7B14\u8BB0",
  "tree.empty": "\u8FD9\u4E2A\u5DE5\u4F5C\u533A\u8FD8\u6CA1\u6709\u7B14\u8BB0\u3002\u6807\u9898\u680F \uFF0B \u65B0\u5EFA,\u6216\u8BA9 Agent \u5199\u4E00\u7BC7 md \u518D\u767B\u8BB0\u3002",
  "tree.hint": "\u300C\u672A\u5F52\u7C7B\u6587\u4EF6\u300D\u662F\u7B14\u8BB0\u6839\u4E0B\u5B58\u5728\u3001\u4F46\u8FD8\u6CA1\u7EB3\u5165\u7B14\u8BB0\u6811\u7684 md:\u70B9\u4E00\u4E0B\u5373\u53EF\u7EB3\u5165\u3002",
  "tree.unfiled": "\u672A\u5F52\u7C7B\u6587\u4EF6",
  "action.newNote": "\u65B0\u5EFA\u7B14\u8BB0",
  "action.newCollection": "\u65B0\u5EFA\u5206\u7C7B",
  "action.rescan": "\u91CD\u65B0\u626B\u63CF(\u6309 dsh-note-id \u91CD\u5EFA\u6620\u5C04)",
  "compose.note": "\u7B14\u8BB0\u6807\u9898,\u56DE\u8F66\u521B\u5EFA",
  "compose.collection": "\u5206\u7C7B\u540D,\u56DE\u8F66\u521B\u5EFA",
  "compose.ok": "\u5EFA",
  "status.created": "\u5DF2\u65B0\u5EFA\u5E76\u767B\u8BB0",
  "status.collectionCreated": "\u5DF2\u65B0\u5EFA\u5206\u7C7B",
  "status.registered": "\u5DF2\u7EB3\u5165\u7B14\u8BB0\u6811",
  "status.rescanned": "\u5DF2\u91CD\u65B0\u626B\u63CF",
  "status.noSession": "\u6CA1\u6709\u4F1A\u8BDD\u4E0A\u4E0B\u6587,\u65E0\u6CD5\u5B9A\u4F4D\u5DE5\u4F5C\u533A",
  "editor.pending": "\u7F16\u8F91\u5668\u5728 P2 \u63A5\u5165(CodeMirror 6);\u73B0\u5728\u8FD9\u91CC\u663E\u793A\u9009\u4E2D\u7B14\u8BB0\u7684\u8DEF\u5F84\u3002",
  "editor.noSelection": "\u5728\u5DE6\u4FA7\u9009\u4E00\u7BC7\u7B14\u8BB0\u3002",
  "editor.refFrom": "\u6765\u81EA\u5176\u5B83\u5DE5\u4F5C\u533A:{name}(\u6620\u5C04,\u4E0D\u662F\u526F\u672C)"
};
var EN = {
  "tab.title": "Notes",
  "tab.guide": "Open the notes area: a notes tree (collections / unfiled) beside a Markdown editor.",
  "tree.collapse": "Collapse notes tree",
  "tree.expand": "Expand notes tree",
  "tree.resize": "Drag to resize the notes tree",
  "tree.title": "Notes tree",
  "tree.loading": "Loading\u2026",
  "tree.summary": "{n} notes",
  "tree.empty": "No notes in this workspace yet. Use + in the header, or have the agent write a .md and register it.",
  "tree.hint": "\u201CUnfiled files\u201D are .md under the notes root that are not in the tree yet \u2014 click one to file it.",
  "tree.unfiled": "Unfiled files",
  "action.newNote": "New note",
  "action.newCollection": "New collection",
  "action.rescan": "Rescan (rebuild the mapping from dsh-note-id)",
  "compose.note": "Note title, Enter to create",
  "compose.collection": "Collection name, Enter to create",
  "compose.ok": "OK",
  "status.created": "Created and registered",
  "status.collectionCreated": "Collection created",
  "status.registered": "Added to the notes tree",
  "status.rescanned": "Rescanned",
  "status.noSession": "No session context \u2014 cannot resolve a workspace",
  "editor.pending": "The editor arrives in P2 (CodeMirror 6); for now this shows the selected note path.",
  "editor.noSelection": "Pick a note on the left.",
  "editor.refFrom": "From another workspace: {name} (a mapping, not a copy)"
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
