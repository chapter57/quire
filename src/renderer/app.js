// Quire's page: starts up, wires the binder, panes and inspector together,
// and carries out every command from the menus and toolbar.
import { el, fmt, sanitizeHtml, plainToHtml, markdownToHtml } from "./lib/util.js";
import { htmlToBlocks, assemble, toDocx, toMarkdown, toText, toHtml } from "./lib/compile.js";
import * as S from "./store.js";
import { Binder, iconFor, iconSpan } from "./binder.js";
import { Pane } from "./pane.js";
import { Inspector, snapshotDialog } from "./inspector.js";

const api = window.quire;
const $ = (sel) => document.querySelector(sel);

// ---------- preferences (this computer only) ----------

const PREF_DEFAULTS = { theme: "system", textSize: 18, typewriter: false, binderWidth: 250, inspectorWidth: 290, showBinder: true, showInspector: true };

function loadPrefs() {
  try { return Object.assign({}, PREF_DEFAULTS, JSON.parse(localStorage.getItem("quire.prefs") || "{}")); }
  catch { return { ...PREF_DEFAULTS }; }
}

const app = {
  prefs: loadPrefs(),
  panes: [],
  active: null,
  inspecting: null,
  cardDrag: null,
  binder: null,
  inspector: null,
};
window.__quireApp = app; // for the end-to-end tests

function savePrefs() {
  try { localStorage.setItem("quire.prefs", JSON.stringify(app.prefs)); } catch { /* not essential */ }
}

function applyPrefs() {
  const p = app.prefs;
  const root = document.documentElement;
  if (p.theme === "system") root.removeAttribute("data-theme"); else root.dataset.theme = p.theme;
  api.setTheme(p.theme);
  root.style.setProperty("--text-size", p.textSize + "px");
  root.style.setProperty("--binder-w", p.binderWidth + "px");
  root.style.setProperty("--inspector-w", p.inspectorWidth + "px");
  document.body.classList.toggle("no-binder", !p.showBinder);
  document.body.classList.toggle("no-inspector", !p.showInspector);
  document.body.classList.toggle("typewriter", !!p.typewriter);
  for (const page of document.querySelectorAll(".page")) page.classList.toggle("typewriter", !!p.typewriter);
}

// ---------- start ----------

async function start() {
  applyPrefs();
  api.on("menu", (cmd) => app.command(cmd));
  api.on("app:project-opened", () => location.reload());
  api.on("app:flush-and-close", async () => {
    try { if (S.store.data) { for (const p of app.panes) p.flushEdits(); app.inspector && app.inspector.saveNotes.flush(); await S.flush(); } }
    finally { api.closedReady(); }
  });
  api.on("app:fullscreen", (on) => { if (!on && document.body.classList.contains("composing")) setComposition(false, true); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("composing") && !document.querySelector("dialog[open]")) setComposition(false);
  });
  for (const b of document.querySelectorAll(".dlg-close")) b.addEventListener("click", () => b.closest("dialog").close());

  const state = await api.state();
  if (state.platform === "darwin") document.body.classList.add("mac");
  if (state.project) {
    await S.load(state.project);
    showApp();
  } else {
    showWelcome(state.recent || []);
  }
}

function showWelcome(recent) {
  $("#welcome").hidden = false;
  api.setTitle("Quire", false);
  const list = $("#recent");
  list.replaceChildren(...(recent.length ? recent.map((r) => el("li", el("button.recent-item", { title: r.dir, onclick: () => api.openProject(r.dir) },
    el("span.recent-name", r.name), el("span.recent-path", r.dir)))) : [el("li.empty", "Nothing yet.")]));
  $("#open-btn").onclick = () => api.openProject();
  $("#new-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api.newProject({ title: (f.get("title") || "").trim() || "Untitled", author: (f.get("author") || "").trim(), kind: f.get("kind") });
    } catch (err) {
      toast(cleanError(err));
    }
  };
  $("#new-title").focus();
}

function showApp() {
  $("#app").hidden = false;
  document.body.classList.add("has-project");
  const d = S.store.data;
  $("#project-name").textContent = d.title || S.store.name;

  app.binder = new Binder($("#binder"), app);
  app.inspector = new Inspector($("#inspector"), app);
  const a = new Pane(app, "a");
  app.panes = [a];
  $("#main").append(a.root);
  app.active = a;
  a.root.classList.add("active");

  wireToolbar();
  wireResizers();
  S.onChange(onStoreChange);

  const start = (d.ui.selected && S.find(d.ui.selected)) ? d.ui.selected : S.draft().id;
  a.view = ["editor", "corkboard", "outliner"].includes(d.ui.view) ? d.ui.view : "editor";
  app.binder.select(start);
  updateSeg();
  updateCounts();
  showSaveState();
  setTimeout(() => app.focusEditor(), 50);
}

// ---------- reacting to changes ----------

function onStoreChange(what, id, source) {
  if (what === "save") return showSaveState();
  if (what === "tree") {
    app.binder.render();
    for (const p of app.panes) syncPane(p, source);
    if (app.inspecting && !S.find(app.inspecting)) app.inspect(S.draft().id);
    else app.inspector.refreshMeta();
    updateTitle();
    updateCounts();
  } else if (what === "meta") {
    app.binder.render();
    if (source !== app.inspector) app.inspector.refreshMeta();
    for (const p of app.panes) if (p !== source && p.view !== "editor") p.render();
  } else if (what === "text") {
    for (const p of app.panes) p.refreshText(id, source);
    app.inspector.refreshMeta();
    updateCounts();
  } else if (what === "project") {
    app.binder.render();
    app.inspector.render();
    for (const p of app.panes) p.render();
  }
}

function syncPane(p, source) {
  if (!p.node) { p.show(S.draft().id); return; }
  if (p.view === "editor") {
    const ids = p.node.type === "file" ? "" : S.textsUnder(p.node).map((t) => t.id).join(",");
    const shown = [...p.body.querySelectorAll(".sec")].map((s) => s.dataset.id).join(",");
    if (ids !== shown) p.render();
    else {
      for (const s of p.body.querySelectorAll(".sec")) {
        const n = S.find(s.dataset.id);
        const t = s.querySelector(".sec-title");
        if (n && t) t.textContent = n.title || "Untitled";
      }
      p.renderCrumbs();
    }
  } else if (p !== source) {
    p.render();
  } else {
    p.renderCrumbs();
  }
}

app.refreshAll = () => {
  for (const p of app.panes) p.render();
  app.binder.render();
  app.inspector.render();
  updateCounts();
};

// ---------- navigation ----------

app.openNode = (id, view) => {
  const n = S.find(id);
  if (!n) return;
  const p = app.active;
  p.show(id, view);
  S.store.data.ui.selected = id;
  S.store.data.ui.view = p.view;
  S.markProject();
  if (app.binder.selected !== id) { app.binder.selected = id; app.binder.render(); }
  app.inspect(id, false);
  updateSeg();
  updateTitle();
};

app.inspect = (id, highlight = true) => {
  if (!S.find(id)) return;
  app.inspecting = id;
  app.inspector.show(id);
  if (highlight && app.binder.selected !== id) {
    app.binder.selected = id;
    app.binder.reveal(id);
    app.binder.render();
  }
  for (const p of app.panes) {
    if (p.view === "editor") continue;
    for (const x of p.body.querySelectorAll("[data-id].selected")) x.classList.remove("selected");
    const hit = p.body.querySelector('.card[data-id="' + id + '"], tr[data-id="' + id + '"]');
    if (hit) hit.classList.add("selected");
  }
  updateCounts();
};

app.setActivePane = (p) => {
  if (app.active === p) return;
  app.active = p;
  for (const x of app.panes) x.root.classList.toggle("active", x === p);
  if (p.nodeId && app.binder.selected !== p.nodeId) { app.binder.selected = p.nodeId; app.binder.render(); }
  updateSeg();
};

app.focusEditor = () => app.active && app.active.focusEditor();
app.findInEditor = (q) => app.active && setTimeout(() => app.active.find(q), 30);

function updateSeg() {
  for (const b of document.querySelectorAll(".seg button")) b.setAttribute("aria-selected", String(app.active && b.dataset.view === app.active.view));
  document.body.dataset.view = app.active ? app.active.view : "editor";
}

function updateTitle() {
  const n = app.active && app.active.node;
  api.setTitle((S.store.data.title || S.store.name) + (n && !n.role ? " — " + n.title : ""), S.hasUnsaved());
}

// ---------- counts and status ----------

function bar(pct) {
  return el("span.mini-bar", el("span", { style: { width: Math.min(100, pct) + "%" } }));
}

let countsQueued = false;
function updateCounts(soon) {
  if (soon) {
    if (countsQueued) return;
    countsQueued = true;
    setTimeout(() => { countsQueued = false; updateCounts(); }, 400);
    return;
  }
  if (!S.store.data) return;
  const n = app.active && app.active.node;
  const doc = $("#st-doc");
  if (n && n.type !== "file") {
    const words = S.wordsUnder(n);
    const target = n.type === "text" && !(n.children && n.children.length) ? n.target : 0;
    doc.replaceChildren(el("span.k", n.role ? n.title : "Words"), " ", fmt(words), ...(target ? [" / ", fmt(target), " ", bar((words / target) * 100)] : []));
  } else doc.replaceChildren();

  const t = S.store.data.targets;
  const sessWords = S.sessionWords();
  const sessTarget = S.sessionTarget();
  const sess = $("#st-session");
  sess.replaceChildren(el("span.k", "Session"), " ", fmt(sessWords), ...(sessTarget ? [" / ", fmt(sessTarget), " ", bar((sessWords / sessTarget) * 100)] : []));
  sess.classList.toggle("met", !!sessTarget && sessWords >= sessTarget);

  const total = S.draftWords();
  const dr = $("#st-draft");
  dr.replaceChildren(el("span.k", "Manuscript"), " ", fmt(total), ...(t.project ? [" / ", fmt(t.project), " ", bar((total / t.project) * 100)] : []));
  if (t.deadline) dr.append(el("span.k.days", " · " + S.daysLeft() + " days left"));

  const comp = $("#comp-words");
  if (comp) comp.textContent = n ? fmt(S.wordsUnder(n)) + " words" + (sessTarget ? " · session " + fmt(sessWords) + " / " + fmt(sessTarget) : "") : "";
}
app.updateCounts = updateCounts;

function showSaveState() {
  const s = $("#st-save");
  if (!s) return;
  if (S.store.lastError) { s.textContent = "Couldn't save: " + S.store.lastError; s.className = "st save error"; }
  else if (S.store.saving || S.hasUnsaved()) { s.textContent = "Saving…"; s.className = "st save busy"; }
  else { s.textContent = "Saved"; s.className = "st save"; }
  if (S.store.data) updateTitle();
}

let toastTimer = null;
function toast(msg, action) {
  const t = $("#toast");
  t.replaceChildren(el("span", msg), ...(action ? [el("button.toast-btn", { onclick: () => { action.run(); t.hidden = true; } }, action.label)] : []));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 8000 : 3500);
}

const cleanError = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

// ---------- toolbar and panels ----------

function wireToolbar() {
  for (const b of document.querySelectorAll("[data-cmd]")) {
    // Keep the editor's selection when a formatting button is pressed.
    if (b.classList.contains("fmt")) b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => app.command(b.dataset.cmd));
  }
  const style = $("#para-style");
  style.addEventListener("change", () => {
    const ed = app.active && app.active.lastEditable;
    if (ed) ed.focus();
    restoreSelection();
    app.command(style.value);
  });
  // Remember where the cursor was, so the style menu can act on it.
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    const ed = node && node.closest && node.closest(".editable");
    if (!ed) return;
    savedRange = sel.getRangeAt(0).cloneRange();
    for (const p of app.panes) if (p.root.contains(ed)) p.lastEditable = ed;
    let block = node.closest("h1, h2, h3, blockquote, p, li");
    const tag = block ? block.tagName.toLowerCase() : "p";
    style.value = { h1: "h1", h2: "h2", h3: "h3", blockquote: "quote" }[tag] || "body";
  });
}

let savedRange = null;
function restoreSelection() {
  if (!savedRange) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(savedRange);
}

function wireResizers() {
  for (const r of document.querySelectorAll(".resizer")) {
    r.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      r.setPointerCapture(e.pointerId);
      const which = r.dataset.for;
      const startX = e.clientX;
      const start = which === "binder" ? app.prefs.binderWidth : app.prefs.inspectorWidth;
      const moveFn = (ev) => {
        const dx = ev.clientX - startX;
        const w = Math.max(180, Math.min(520, start + (which === "binder" ? dx : -dx)));
        if (which === "binder") app.prefs.binderWidth = w; else app.prefs.inspectorWidth = w;
        applyPrefs();
      };
      const up = () => { r.removeEventListener("pointermove", moveFn); r.removeEventListener("pointerup", up); savePrefs(); };
      r.addEventListener("pointermove", moveFn);
      r.addEventListener("pointerup", up);
    });
  }
}

function setComposition(on, fromWindow) {
  const body = document.body;
  if (on === body.classList.contains("composing")) return;
  if (on && app.active.view !== "editor") app.command("view-editor");
  body.classList.toggle("composing", on);
  $("#comp-bar").hidden = !on;
  if (!fromWindow) api.setFullScreen(on);
  updateCounts();
  if (on) setTimeout(() => { const ed = app.active.lastEditable && app.active.root.contains(app.active.lastEditable) ? app.active.lastEditable : null; if (ed) ed.focus(); else app.focusEditor(); }, 60);
}

// ---------- commands ----------

const FORMAT = {
  bold: () => document.execCommand("bold"),
  italic: () => document.execCommand("italic"),
  underline: () => document.execCommand("underline"),
  strike: () => document.execCommand("strikeThrough"),
  body: () => document.execCommand("formatBlock", false, "p"),
  h1: () => document.execCommand("formatBlock", false, "h1"),
  h2: () => document.execCommand("formatBlock", false, "h2"),
  h3: () => document.execCommand("formatBlock", false, "h3"),
  quote: () => document.execCommand("formatBlock", false, "blockquote"),
  ul: () => document.execCommand("insertUnorderedList"),
  ol: () => document.execCommand("insertOrderedList"),
  "scene-break": () => document.execCommand("insertHorizontalRule"),
};

function newItemPlace() {
  // New items go after the selected item, or inside it when it's a folder.
  const sel = S.find(app.inspecting) || S.draft();
  if (S.inTrash(sel.id)) return { ref: S.draft(), where: "inside" };
  if (sel.role || (sel.type === "folder")) return { ref: sel, where: "inside" };
  return { ref: sel, where: "after" };
}

async function addItem(type) {
  const { ref, where } = newItemPlace();
  const n = S.makeNode(type, type === "folder" ? "New Folder" : "Untitled");
  S.insert(n, ref, where);
  if (where === "inside") app.binder.setExpanded(ref.id, true);
  const p = app.active;
  if (p.view !== "editor" && p.node && (p.node.id === ref.id || S.parentOf(n.id) === p.node)) {
    p.render();
    app.inspect(n.id);
  } else {
    app.binder.select(n.id);
  }
  app.binder.render();
  app.binder.rename(n.id);
}

app.takeSnapshot = async (id, name) => {
  for (const p of app.panes) p.flushEdits();
  const n = S.find(id);
  if (!n || n.type !== "text") return toast("Select a text to take a snapshot of it.");
  await api.takeSnapshot(id, name || "", S.getDoc(id));
  toast("Snapshot saved for “" + n.title + "”.");
  if (app.inspecting === id && app.inspector.tab === "snapshots") app.inspector.renderTab(n);
};

app.openSnapshot = (id, snap) => {
  for (const p of app.panes) p.flushEdits();
  snapshotDialog($("#dlg-snapshot"), id, snap, app);
};

app.command = async (cmd) => {
  if (!S.store.data) {
    if (cmd === "new-project") $("#new-title").focus();
    if (cmd.startsWith("theme-")) { app.prefs.theme = cmd.slice(6); savePrefs(); applyPrefs(); }
    return;
  }
  const p = app.active;
  try {
    if (FORMAT[cmd]) {
      const focus = document.activeElement;
      // In the synopsis, notes or a title field, formatting keys do nothing.
      if (focus && (focus.tagName === "INPUT" || focus.tagName === "TEXTAREA" || (focus.isContentEditable && !focus.classList.contains("editable")))) return;
      if (!focus || !focus.classList.contains("editable")) {
        const ed = p.lastEditable && p.root.contains(p.lastEditable) ? p.lastEditable : null;
        if (!ed) return;
        ed.focus();
        restoreSelection();
      }
      FORMAT[cmd]();
      return;
    }
    switch (cmd) {
      case "new-project": return api.newWindow();
      case "new-text": return addItem("text");
      case "new-folder": return addItem("folder");
      case "view-editor": case "view-corkboard": case "view-outliner": {
        p.setView(cmd.slice(5));
        S.store.data.ui.view = p.view;
        S.markProject();
        updateSeg();
        return;
      }
      case "toggle-binder": app.prefs.showBinder = !app.prefs.showBinder; savePrefs(); return applyPrefs();
      case "toggle-inspector": app.prefs.showInspector = !app.prefs.showInspector; savePrefs(); return applyPrefs();
      case "toggle-split": return toggleSplit();
      case "composition": return setComposition(!document.body.classList.contains("composing"));
      case "typewriter":
        app.prefs.typewriter = !app.prefs.typewriter; savePrefs(); applyPrefs();
        return toast("Typewriter scrolling " + (app.prefs.typewriter ? "on" : "off") + ".");
      case "text-bigger": app.prefs.textSize = Math.min(30, app.prefs.textSize + 1); savePrefs(); return applyPrefs();
      case "text-smaller": app.prefs.textSize = Math.max(12, app.prefs.textSize - 1); savePrefs(); return applyPrefs();
      case "theme-system": case "theme-light": case "theme-dark":
        app.prefs.theme = cmd.slice(6); savePrefs(); return applyPrefs();
      case "find": if (!app.prefs.showBinder) { app.prefs.showBinder = true; applyPrefs(); } return app.binder.focusSearch();
      case "snapshot": return app.takeSnapshot(app.inspecting);
      case "split": {
        const piece = p.splitAtCursor();
        if (piece) { app.binder.select(piece.id, false); p.render(); toast("Split into “" + piece.title + "”."); }
        else toast("Put the cursor in a text to split it.");
        return;
      }
      case "duplicate": {
        const c = await S.duplicate(app.inspecting);
        if (c) app.binder.select(c.id);
        return;
      }
      case "rename": return app.binder.rename(app.inspecting);
      case "trash": {
        const n = S.find(app.inspecting);
        if (!n || n.role) return;
        if (S.inTrash(n.id)) return toast("That's already in the Trash.");
        const ids = app.binder.visibleIds();
        const next = ids[ids.indexOf(n.id) + 1];
        const parent = S.parentOf(n.id);
        for (const x of app.panes) x.flushEdits();
        S.moveToTrash(n.id);
        const after = next && S.find(next) && !S.isAncestor(n.id, next) ? next : parent.id;
        app.binder.select(after);
        toast("Moved “" + n.title + "” to the Trash.", { label: "Undo", run: () => { S.restoreFromTrash(n.id); app.binder.select(n.id); } });
        return;
      }
      case "empty-trash": {
        const t = S.trash();
        if (!t.children.length) return toast("The Trash is empty.");
        const count = S.descendants(t).length;
        const ok = await api.confirm({ message: "Empty the Trash?", detail: "This deletes " + count + (count === 1 ? " item" : " items") + " and their snapshots for good.", ok: "Empty Trash", danger: true });
        if (!ok) return;
        for (const x of app.panes) x.flushEdits();
        await S.emptyTrash();
        app.binder.select(t.id);
        return;
      }
      case "go-up": {
        const parent = p.node && S.parentOf(p.node.id);
        if (parent) app.binder.select(parent.id);
        return;
      }
      case "import-research": {
        const files = await api.importResearch();
        if (!files.length) return;
        const sel = S.find(app.inspecting);
        const target = sel && S.rootOf(sel.id).role === "research" && sel.type === "folder" ? sel : S.research();
        let last = null;
        for (const f of files) last = S.insert(S.makeNode("file", f.title, { file: f.file, mime: f.mime, include: false }), target, "inside");
        app.binder.setExpanded(target.id, true);
        app.binder.select(last.id);
        return toast("Imported " + files.length + (files.length === 1 ? " file" : " files") + " into " + target.title + ".");
      }
      case "import-text": {
        const files = await api.importText();
        if (!files.length) return;
        let { ref, where } = newItemPlace();
        let last = null;
        for (const f of files) {
          const n = S.makeNode("text", f.title);
          S.insert(n, ref, where);
          S.setDoc(n.id, sanitizeHtml(f.markdown ? markdownToHtml(f.text) : plainToHtml(f.text)));
          ref = n; where = "after";
          last = n;
        }
        app.binder.select(last.id);
        return toast("Imported " + files.length + (files.length === 1 ? " file." : " files."));
      }
      case "reveal": return api.reveal();
      case "targets": return openTargets();
      case "compile": return openCompile();
      case "project-settings": return openSettings();
    }
  } catch (e) {
    console.error(e);
    toast(cleanError(e));
  }
};

function toggleSplit() {
  const main = $("#main");
  if (app.panes.length > 1) {
    const b = app.panes.pop();
    b.flushEdits();
    b.root.remove();
    main.classList.remove("split");
    app.setActivePane(app.panes[0]);
    app.panes[0].root.classList.add("active");
    return;
  }
  const b = new Pane(app, "b");
  app.panes.push(b);
  main.append(b.root);
  main.classList.add("split");
  b.show(app.active.nodeId, app.active.view);
  app.setActivePane(b);
  for (const x of app.panes) x.root.classList.toggle("active", x === b);
}

// ---------- dialogs ----------

function openTargets() {
  const dlg = $("#dlg-targets");
  const t = S.store.data.targets;
  const proj = $("#t-project"), dead = $("#t-deadline"), sess = $("#t-session"), auto = $("#t-auto");
  proj.value = t.project || "";
  dead.value = t.deadline || "";
  sess.value = t.session || "";
  auto.checked = !!t.autoSession;
  const summary = () => {
    sess.disabled = auto.checked;
    const target = parseInt(proj.value, 10) || 0;
    const now = S.draftWords();
    const parts = ["The manuscript has " + fmt(now) + " words."];
    if (target) parts.push(now >= target ? "You've reached the target." : fmt(target - now) + " to go.");
    if (auto.checked && target && dead.value) {
      const saved = { ...t };
      Object.assign(t, { project: target, deadline: dead.value, autoSession: true });
      const per = S.sessionTarget(), days = S.daysLeft();
      Object.assign(t, saved);
      parts.push(days ? "That's about " + fmt(per) + " words a day for " + days + (days === 1 ? " day." : " days.") : "The deadline has passed.");
    }
    $("#t-summary").textContent = parts.join(" ");
  };
  for (const i of [proj, dead, sess, auto]) i.oninput = summary;
  summary();
  $("#t-reset").onclick = () => {
    S.store.data.session = { date: S.store.data.session.date, start: S.draftWords() };
    S.markProject();
    updateCounts();
    toast("Session count reset.");
  };
  dlg.onclose = () => {
    if (dlg.returnValue !== "ok") return;
    Object.assign(t, {
      project: Math.max(0, parseInt(proj.value, 10) || 0),
      deadline: dead.value || "",
      session: Math.max(0, parseInt(sess.value, 10) || 0),
      autoSession: auto.checked,
    });
    S.markProject();
    updateCounts();
  };
  dlg.returnValue = "";
  dlg.showModal();
}

function openCompile() {
  for (const p of app.panes) p.flushEdits();
  const dlg = $("#dlg-compile");
  const d = S.store.data;
  const c = Object.assign({ format: "docx", titlePage: true, folderTitles: true, textTitles: false, separator: "#", chapterBreaks: true, font: "Georgia" }, d.compile);
  $("#c-format").value = c.format;
  $("#c-title").value = d.title || S.store.name;
  $("#c-author").value = d.author || "";
  $("#c-font").value = c.font;
  $("#c-titlepage").checked = c.titlePage;
  $("#c-folders").checked = c.folderTitles;
  $("#c-texts").checked = c.textTitles;
  $("#c-breaks").checked = c.chapterBreaks;
  $("#c-sep").value = c.separator;

  const tree = $("#c-tree");
  const count = () => { $("#c-count").textContent = fmt(S.draftWords()) + " words will be compiled."; };
  const draw = (nodes, depth) => nodes.filter((n) => n.type !== "file").flatMap((n) => [
    el("label.c-row", { style: { paddingLeft: depth * 16 + "px" } },
      el("input", { type: "checkbox", checked: !!n.include, onchange: (e) => { S.update(n.id, { include: e.target.checked }); count(); } }),
      iconSpan(iconFor(n)), el("span", n.title || "Untitled")),
    ...draw(n.children || [], depth + 1),
  ]);
  tree.replaceChildren(...draw(S.draft().children, 0));
  count();

  dlg.onclose = async () => {
    if (dlg.returnValue !== "ok") return;
    const opts = {
      format: $("#c-format").value,
      font: $("#c-font").value,
      titlePage: $("#c-titlepage").checked,
      folderTitles: $("#c-folders").checked,
      textTitles: $("#c-texts").checked,
      chapterBreaks: $("#c-breaks").checked,
      separator: $("#c-sep").value,
    };
    d.compile = opts;
    const title = $("#c-title").value.trim(), author = $("#c-author").value.trim();
    if (title !== d.title || author !== d.author) { d.title = title || d.title; d.author = author; $("#project-name").textContent = d.title; }
    S.markProject();
    try {
      const file = await compile(opts);
      if (file) toast("Compiled to " + file.split(/[\\/]/).pop() + ".", { label: "Show", run: () => api.showFile(file) });
    } catch (e) {
      console.error(e);
      toast("Couldn't compile: " + cleanError(e));
    }
  };
  dlg.returnValue = "";
  dlg.showModal();
}

export function compileBlocks(opts) {
  const d = S.store.data;
  const docs = {};
  const parser = new DOMParser();
  for (const t of S.textsUnder(S.draft())) {
    docs[t.id] = htmlToBlocks(parser.parseFromString("<body>" + S.getDoc(t.id), "text/html").body);
  }
  return assemble(S.draft(), docs, opts, { title: d.title, author: d.author });
}

async function compile(opts) {
  const d = S.store.data;
  const meta = { title: d.title, author: d.author, font: opts.font };
  const { blocks, separator } = compileBlocks(opts);
  const name = (d.title || S.store.name).replace(/[\\/:*?"<>|]/g, "-");
  switch (opts.format) {
    case "docx": return api.saveCompiled({ name, ext: "docx", data: toDocx(blocks, meta, separator) });
    case "md": return api.saveCompiled({ name, ext: "md", data: toMarkdown(blocks, separator) });
    case "txt": return api.saveCompiled({ name, ext: "txt", data: toText(blocks, separator) });
    case "html": return api.saveCompiled({ name, ext: "html", data: toHtml(blocks, meta, separator) });
    case "pdf": return api.savePdf({ name, html: toHtml(blocks, meta, separator) });
  }
  return null;
}
app.compileBlocks = compileBlocks;

function openSettings() {
  const dlg = $("#dlg-settings");
  const d = S.store.data;
  const labels = d.labels.map((l) => ({ ...l }));
  const statuses = d.statuses.map((s) => ({ ...s }));
  $("#p-title").value = d.title || "";
  $("#p-author").value = d.author || "";

  const drawLabels = () => $("#p-labels").replaceChildren(...labels.map((l, i) => el("li",
    el("input.color", { type: "color", value: l.color, "aria-label": "Colour", oninput: (e) => { l.color = e.target.value; } }),
    el("input", { type: "text", value: l.name, "aria-label": "Label name", oninput: (e) => { l.name = e.target.value; } }),
    el("button.icon-btn", { type: "button", title: "Remove", onclick: () => { labels.splice(i, 1); drawLabels(); } }, "×"))));
  const drawStatuses = () => $("#p-statuses").replaceChildren(...statuses.map((s, i) => el("li",
    el("input", { type: "text", value: s.name, "aria-label": "Status name", oninput: (e) => { s.name = e.target.value; } }),
    el("button.icon-btn", { type: "button", title: "Move up", disabled: i === 0, onclick: () => { statuses.splice(i - 1, 0, statuses.splice(i, 1)[0]); drawStatuses(); } }, "↑"),
    el("button.icon-btn", { type: "button", title: "Remove", onclick: () => { statuses.splice(i, 1); drawStatuses(); } }, "×"))));
  drawLabels();
  drawStatuses();
  $("#p-add-label").onclick = () => { labels.push({ id: "l-" + Date.now().toString(36), name: "New Label", color: "#888888" }); drawLabels(); };
  $("#p-add-status").onclick = () => { statuses.push({ id: "s-" + Date.now().toString(36), name: "New Status" }); drawStatuses(); };

  dlg.onclose = () => {
    if (dlg.returnValue !== "ok") return;
    d.title = $("#p-title").value.trim() || d.title;
    d.author = $("#p-author").value.trim();
    d.labels = labels.filter((l) => l.name.trim()).map((l) => ({ ...l, name: l.name.trim() }));
    d.statuses = statuses.filter((s) => s.name.trim()).map((s) => ({ ...s, name: s.name.trim() }));
    const lids = new Set(d.labels.map((l) => l.id)), sids = new Set(d.statuses.map((s) => s.id));
    S.walk((n) => {
      if (n.label && !lids.has(n.label)) n.label = null;
      if (n.status && !sids.has(n.status)) n.status = null;
    });
    $("#project-name").textContent = d.title;
    S.markProject();
    S.changed("project");
    updateTitle();
  };
  dlg.returnValue = "";
  dlg.showModal();
}

window.addEventListener("beforeunload", () => { for (const p of app.panes) p.flushEdits(); });

start().catch((e) => {
  console.error(e);
  document.body.replaceChildren(el("div.fatal", el("h1", "Quire couldn't open this project."), el("p", cleanError(e))));
});
