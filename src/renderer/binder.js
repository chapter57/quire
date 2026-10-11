// The binder: the project's tree of folders, texts and research files.
import { el, htmlToText, fmt } from "./lib/util.js";
import * as S from "./store.js";

const api = window.quire;

export const ICONS = {
  folder: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.2c0-.7.5-1.2 1.2-1.2h3.4l1.4 1.5h5.8c.7 0 1.2.5 1.2 1.2v6.6c0 .7-.5 1.2-1.2 1.2H2.7c-.7 0-1.2-.5-1.2-1.2z"/></svg>',
  text: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M5.5 7h5M5.5 9.5h5M5.5 12h3" class="ln"/></svg>',
  stack: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3.5h6l3 3v8h-9z"/><path d="M2.5 1.5h6M2.5 1.5v11" class="ln"/></svg>',
  draft: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h8l3 3v8h-11z"/><path d="M4.5 7h7M4.5 9.5h7M4.5 12h4" class="ln"/></svg>',
  research: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5h5v10H2zM9 3.5h5v10H9z"/></svg>',
  trash: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 4.5h9l-.8 9.5H4.3z"/><path d="M2 4.5h12M6 4.5V2.5h4v2" class="ln"/></svg>',
  image: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3h13v10h-13z"/><path d="M2 12l4-4 3 3 2-2 3 3" class="ln"/></svg>',
  pdf: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M5 11.5h6" class="ln"/></svg>',
  media: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3h13v10h-13z"/><path d="M6.5 5.5v5l4-2.5z"/></svg>',
  file: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.5h6l3 3v10h-9z"/></svg>',
};

export function iconFor(n) {
  if (n.role) return ICONS[n.role] || ICONS.folder;
  if (n.type === "folder") return ICONS.folder;
  if (n.type === "file") {
    const m = n.mime || "";
    if (m.startsWith("image/")) return ICONS.image;
    if (m === "application/pdf") return ICONS.pdf;
    if (m.startsWith("audio/") || m.startsWith("video/")) return ICONS.media;
    return ICONS.file;
  }
  return n.children && n.children.length ? ICONS.stack : ICONS.text;
}

export function labelOf(n) {
  return n.label ? S.store.data.labels.find((l) => l.id === n.label) || null : null;
}

export function statusOf(n) {
  return n.status ? S.store.data.statuses.find((s) => s.id === n.status) || null : null;
}

export class Binder {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.selected = null;
    this.renaming = null;
    this.query = "";
    this.search = el("input.binder-search", {
      type: "search", placeholder: "Search project", spellcheck: false, "aria-label": "Search project",
      oninput: () => { this.query = this.search.value.trim(); this.render(); },
      onkeydown: (e) => {
        if (e.key === "Escape") { this.search.value = ""; this.query = ""; this.render(); this.tree.focus(); }
        if (e.key === "ArrowDown") { e.preventDefault(); const first = this.tree.querySelector(".row"); if (first) { this.select(first.dataset.id, true); this.tree.focus(); } }
      },
    });
    this.tree = el("div.binder-tree", { tabindex: 0, role: "tree", "aria-label": "Binder" });
    this.foot = el("div.binder-foot",
      el("button.icon-btn", { title: "New text (⌘N)", onclick: () => app.command("new-text") }, iconSpan(ICONS.text), el("span", "+")),
      el("button.icon-btn", { title: "New folder", onclick: () => app.command("new-folder") }, iconSpan(ICONS.folder), el("span", "+")),
      el("span.grow"),
      el("button.icon-btn", { title: "Import research files", onclick: () => app.command("import-research") }, iconSpan(ICONS.research), el("span", "+")),
    );
    root.append(el("div.binder-head", this.search), this.tree, this.foot);
    this.bind();
  }

  get expanded() { return new Set(S.store.data.ui.expanded); }

  setExpanded(id, on) {
    const set = this.expanded;
    if (on) set.add(id); else set.delete(id);
    S.store.data.ui.expanded = [...set];
    S.markProject();
  }

  reveal(id) {
    let changed = false;
    const set = this.expanded;
    for (const p of S.pathOf(id).slice(0, -1)) if (!set.has(p.id)) { set.add(p.id); changed = true; }
    if (changed) { S.store.data.ui.expanded = [...set]; S.markProject(); }
  }

  select(id, open = true) {
    this.selected = id;
    this.reveal(id);
    this.render();
    if (open) this.app.openNode(id);
    const row = this.tree.querySelector('.row[data-id="' + id + '"]');
    if (row) row.scrollIntoView({ block: "nearest" });
  }

  focusSearch() {
    this.search.focus();
    this.search.select();
  }

  // ---------- drawing ----------

  render() {
    if (this.renaming) return;
    const frag = document.createDocumentFragment();
    if (this.query) frag.append(this.renderResults());
    else {
      const exp = this.expanded;
      const draw = (nodes, depth) => {
        for (const n of nodes) {
          frag.append(this.row(n, depth, exp));
          if (n.children && n.children.length && exp.has(n.id)) draw(n.children, depth + 1);
        }
      };
      draw(S.roots(), 0);
    }
    this.tree.replaceChildren(frag);
  }

  row(n, depth, exp) {
    const has = n.children && n.children.length > 0;
    const label = labelOf(n);
    const cls = ["row"];
    if (n.id === this.selected) cls.push("selected");
    if (n.role) cls.push("root");
    if (!n.include && !n.role) cls.push("excluded");
    return el("div." + cls.join("."), {
      dataset: { id: n.id },
      role: "treeitem",
      "aria-selected": String(n.id === this.selected),
      "aria-expanded": has ? String(exp.has(n.id)) : undefined,
      draggable: !n.role,
      style: { paddingLeft: 6 + depth * 14 + "px" },
    },
    el("span.twisty" + (has ? "" : ".none") + (exp.has(n.id) ? ".open" : ""), { "aria-hidden": "true" }),
    iconSpan(iconFor(n), n.type === "folder" || n.role ? "folder" : n.type),
    el("span.title", n.title || "Untitled"),
    label ? el("span.dot", { style: { background: label.color }, title: label.name }) : null,
    );
  }

  renderResults() {
    const q = this.query.toLowerCase();
    const box = el("div.results");
    let count = 0;
    S.walk((n) => {
      if (n.role) return;
      const hits = [];
      if ((n.title || "").toLowerCase().includes(q)) hits.push(null);
      const syn = n.synopsis || "";
      if (syn.toLowerCase().includes(q)) hits.push(snippet(syn, q));
      if (n.type !== "file") {
        const text = htmlToText(S.getDoc(n.id)).replace(/\s+/g, " ");
        const at = text.toLowerCase().indexOf(q);
        if (at >= 0) {
          let k = 0, i = at;
          while (i >= 0) { k++; i = text.toLowerCase().indexOf(q, i + q.length); }
          hits.push(snippet(text, q) + (k > 1 ? "  (" + fmt(k) + " matches)" : ""));
        }
      }
      if (!hits.length) return;
      count++;
      const path = S.pathOf(n.id).slice(0, -1).map((p) => p.title).join(" › ");
      box.append(el("div.row.result" + (n.id === this.selected ? ".selected" : ""), { dataset: { id: n.id } },
        iconSpan(iconFor(n)),
        el("div.result-body",
          el("span.title", highlight(n.title || "Untitled", q)),
          el("span.path", path),
          hits.filter(Boolean).slice(0, 1).map((h) => el("span.snippet", highlight(h, q))),
        )));
    });
    box.prepend(el("div.results-head", count ? fmt(count) + (count === 1 ? " document" : " documents") : "No matches"));
    return box;
  }

  // ---------- interaction ----------

  bind() {
    const t = this.tree;
    t.addEventListener("click", (e) => {
      const row = e.target.closest(".row");
      if (!row) return;
      const id = row.dataset.id;
      if (e.target.closest(".twisty") && !e.target.closest(".twisty.none")) {
        this.setExpanded(id, !this.expanded.has(id));
        this.render();
        return;
      }
      this.select(id);
      if (this.query) this.app.findInEditor(this.query);
    });
    t.addEventListener("dblclick", (e) => {
      const row = e.target.closest(".row");
      if (row && !this.query && !S.isRoot(S.find(row.dataset.id))) this.rename(row.dataset.id);
    });
    t.addEventListener("keydown", (e) => this.keydown(e));
    t.addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".row");
      if (!row) return;
      e.preventDefault();
      this.select(row.dataset.id);
      this.contextMenu(row.dataset.id);
    });

    // Dragging rows to reorder them, and research files in from the desktop.
    let dragId = null;
    t.addEventListener("dragstart", (e) => {
      const row = e.target.closest(".row");
      if (!row || this.query) return;
      dragId = row.dataset.id;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/x-quire-node", dragId);
      row.classList.add("dragging");
    });
    t.addEventListener("dragend", () => { dragId = null; clearDrop(t); t.querySelectorAll(".dragging").forEach((r) => r.classList.remove("dragging")); });
    t.addEventListener("dragover", (e) => {
      const row = e.target.closest(".row");
      clearDrop(t);
      const id = dragId || (this.app.cardDrag && this.app.cardDrag.id);
      if (!row || !id) return;
      const where = dropZone(e, row, S.find(row.dataset.id));
      if (!S.canMove(id, row.dataset.id, where)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      row.classList.add("drop-" + where);
    });
    t.addEventListener("dragleave", (e) => { if (!t.contains(e.relatedTarget)) clearDrop(t); });
    t.addEventListener("drop", (e) => {
      const row = e.target.closest(".row");
      const id = dragId || (this.app.cardDrag && this.app.cardDrag.id);
      clearDrop(t);
      if (!row || !id) return;
      e.preventDefault();
      const where = dropZone(e, row, S.find(row.dataset.id));
      if (where === "inside") this.setExpanded(row.dataset.id, true);
      if (S.find(row.dataset.id).role === "trash" && where === "inside") S.moveToTrash(id);
      else S.move(id, row.dataset.id, where);
      this.select(id, false);
    });
  }

  visibleIds() {
    return [...this.tree.querySelectorAll(".row")].map((r) => r.dataset.id);
  }

  keydown(e) {
    if (this.renaming) return;
    const ids = this.visibleIds();
    const i = ids.indexOf(this.selected);
    const n = S.find(this.selected);
    const mod = e.metaKey || e.ctrlKey;
    // Cmd+Ctrl+Up/Down (Ctrl+Shift on Windows and Linux) moves the item, like Scrivener.
    const moveKey = (e.metaKey && e.ctrlKey) || (e.ctrlKey && e.shiftKey && !e.metaKey);
    if (moveKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && n && !n.role) {
      e.preventDefault();
      const sibs = S.parentOf(n.id).children, k = sibs.indexOf(n);
      if (e.key === "ArrowUp" && k > 0) S.move(n.id, sibs[k - 1].id, "before");
      if (e.key === "ArrowDown" && k < sibs.length - 1) S.move(n.id, sibs[k + 1].id, "after");
      this.select(n.id, false);
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); if (i < ids.length - 1) this.select(ids[i + 1]); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (i > 0) this.select(ids[i - 1]); else if (i === 0) this.focusSearch(); }
    else if (e.key === "ArrowRight" && n && n.children && n.children.length) {
      e.preventDefault();
      if (!this.expanded.has(n.id)) { this.setExpanded(n.id, true); this.render(); } else this.select(n.children[0].id);
    } else if (e.key === "ArrowLeft" && n) {
      e.preventDefault();
      if (this.expanded.has(n.id) && n.children.length) { this.setExpanded(n.id, false); this.render(); }
      else if (S.parentOf(n.id)) this.select(S.parentOf(n.id).id);
    } else if ((e.key === "Enter" || e.key === "F2") && n && !n.role && !this.query) {
      e.preventDefault();
      this.rename(n.id);
    } else if ((e.key === "Backspace" || e.key === "Delete") && mod && n) {
      e.preventDefault();
      this.app.command("trash");
    } else if (e.key === " " && n) {
      e.preventDefault();
      this.app.focusEditor();
    }
  }

  rename(id) {
    const row = this.tree.querySelector('.row[data-id="' + id + '"]');
    const n = S.find(id);
    if (!row || !n || n.role) return;
    const title = row.querySelector(".title");
    const input = el("input.rename", { value: n.title, spellcheck: false, "aria-label": "Title" });
    this.renaming = id;
    title.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      this.renaming = null;
      if (save && input.value.trim() && input.value !== n.title) S.update(id, { title: input.value.trim() });
      this.render();
      this.tree.focus();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  }

  async contextMenu(id) {
    const n = S.find(id);
    if (!n) return;
    const d = S.store.data;
    const items = [];
    const trashed = S.inTrash(id);
    if (n.role === "trash") {
      items.push({ id: "empty-trash", label: "Empty Trash…", enabled: n.children.length > 0 });
    } else {
      items.push({ id: "new-text", label: "New Text" }, { id: "new-folder", label: "New Folder" });
      if (n.role === "research" || S.rootOf(id).role === "research") items.push({ id: "import-research", label: "Import Research Files…" });
      items.push({ type: "separator" });
      if (!n.role) {
        items.push({ id: "rename", label: "Rename" }, { id: "duplicate", label: "Duplicate" });
        items.push({
          label: "Label",
          submenu: [{ id: "label:", label: "No Label", checked: !n.label }, { type: "separator" },
            ...d.labels.map((l) => ({ id: "label:" + l.id, label: l.name, checked: n.label === l.id }))],
        });
        items.push({
          label: "Status",
          submenu: [{ id: "status:", label: "No Status", checked: !n.status }, { type: "separator" },
            ...d.statuses.map((s) => ({ id: "status:" + s.id, label: s.name, checked: n.status === s.id }))],
        });
        items.push({ id: "include", label: "Include in Compile", checked: !!n.include });
        if (n.type === "text") items.push({ id: "snapshot", label: "Take Snapshot" });
        items.push({ type: "separator" });
        items.push(trashed ? { id: "restore", label: "Put Back" } : { id: "trash", label: "Move to Trash" });
      }
      items.push({ type: "separator" }, { id: "expand-all", label: "Expand All" }, { id: "collapse-all", label: "Collapse All" });
    }
    const choice = await api.popup(items);
    if (!choice) return;
    if (choice.startsWith("label:")) S.update(id, { label: choice.slice(6) || null });
    else if (choice.startsWith("status:")) S.update(id, { status: choice.slice(7) || null });
    else if (choice === "include") S.update(id, { include: !n.include });
    else if (choice === "rename") this.rename(id);
    else if (choice === "restore") { S.restoreFromTrash(id); this.select(id, false); }
    else if (choice === "expand-all") { const all = []; S.walk((x) => { if (x.children && x.children.length) all.push(x.id); }); S.store.data.ui.expanded = all; S.markProject(); this.render(); }
    else if (choice === "collapse-all") { S.store.data.ui.expanded = []; S.markProject(); this.render(); }
    else this.app.command(choice);
  }
}

function iconSpan(svg, kind) {
  const s = el("span.icon" + (kind ? "." + kind : ""));
  s.innerHTML = svg;
  return s;
}
export { iconSpan };

function dropZone(e, row, n) {
  const r = row.getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height;
  if (n.role) return "inside";
  if (n.type === "file") return y < 0.5 ? "before" : "after";
  if (y < 0.28) return "before";
  if (y > 0.72) return n.type === "folder" && n.children.length ? "inside" : "after";
  return "inside";
}

function clearDrop(t) {
  t.querySelectorAll(".drop-before, .drop-after, .drop-inside").forEach((r) => r.classList.remove("drop-before", "drop-after", "drop-inside"));
}

function snippet(text, q) {
  const at = text.toLowerCase().indexOf(q);
  if (at < 0) return text.slice(0, 80);
  const start = Math.max(0, at - 30);
  return (start > 0 ? "…" : "") + text.slice(start, at + q.length + 50).trim() + (at + q.length + 50 < text.length ? "…" : "");
}

function highlight(text, q) {
  const frag = document.createDocumentFragment();
  const low = text.toLowerCase();
  let i = 0;
  for (let at = low.indexOf(q); at >= 0 && q; at = low.indexOf(q, i)) {
    frag.append(text.slice(i, at), el("mark", text.slice(at, at + q.length)));
    i = at + q.length;
  }
  frag.append(text.slice(i));
  return frag;
}
