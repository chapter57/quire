// The open project: its binder tree, the text of every document, and saving.
// Everything else reads and changes the project through here, then calls
// changed() so the views can redraw.
import { newId, debounce, sanitizeHtml, htmlToText, countWords, todayKey } from "./lib/util.js";

const api = window.quire;

export const store = {
  dir: null,
  name: "",
  data: null,
  docs: new Map(),   // id -> html
  notes: new Map(),  // id -> text, loaded when first needed
  dirtyDocs: new Set(),
  dirtyNotes: new Set(),
  projectDirty: false,
  saving: 0,
  listeners: new Set(),
  wordCache: new Map(), // id -> { html, words }
};

// ---------- events ----------

export function onChange(fn) {
  store.listeners.add(fn);
  return () => store.listeners.delete(fn);
}

// what: "tree" (binder shape or titles), "meta" (synopsis, label...), "text", "project", "save"
export function changed(what, id, source) {
  for (const fn of store.listeners) fn(what, id, source);
}

// ---------- loading ----------

export async function load(project) {
  store.dir = project.dir;
  store.name = project.name;
  store.data = project.data;
  store.docs.clear();
  store.notes.clear();
  store.wordCache.clear();
  const d = store.data;
  d.labels = d.labels || [];
  d.statuses = d.statuses || [];
  d.targets = Object.assign({ project: 0, session: 0, deadline: "", autoSession: false }, d.targets);
  d.compile = Object.assign({}, d.compile);
  d.ui = Object.assign({ expanded: [], selected: null, view: "editor" }, d.ui);
  const ids = [];
  walk((n) => { if (n.type !== "file") ids.push(n.id); });
  const docs = await api.readDocs(ids);
  for (const id of ids) store.docs.set(id, sanitizeHtml(docs[id] || ""));
  // A new day starts a new writing session.
  const today = todayKey();
  if (!d.session || d.session.date !== today) {
    d.session = { date: today, start: draftWords() };
    markProject();
  }
}

// ---------- the tree ----------

export const roots = () => store.data.binder;
export const draft = () => roots().find((n) => n.role === "draft") || roots()[0];
export const research = () => roots().find((n) => n.role === "research");
export const trash = () => roots().find((n) => n.role === "trash");

export function walk(fn, nodes = roots(), parent = null, depth = 0) {
  for (const n of nodes) {
    if (fn(n, parent, depth) === false) return false;
    if (n.children && n.children.length && walk(fn, n.children, n, depth + 1) === false) return false;
  }
  return true;
}

const index = { version: -1, byId: new Map(), parent: new Map() };
let treeVersion = 0;

function reindex() {
  if (index.version === treeVersion) return;
  index.byId.clear();
  index.parent.clear();
  walk((n, p) => { index.byId.set(n.id, n); index.parent.set(n.id, p); });
  index.version = treeVersion;
}

export const find = (id) => { reindex(); return index.byId.get(id) || null; };
export const parentOf = (id) => { reindex(); return index.parent.get(id) || null; };

export function pathOf(id) {
  const out = [];
  for (let n = find(id); n; n = parentOf(n.id)) out.unshift(n);
  return out;
}

export const isRoot = (n) => !!(n && n.role);
export const rootOf = (id) => pathOf(id)[0] || null;
export const inTrash = (id) => { const r = rootOf(id); return !!(r && r.role === "trash"); };

export function isAncestor(maybeAncestor, id) {
  for (let p = parentOf(id); p; p = parentOf(p.id)) if (p.id === maybeAncestor) return true;
  return false;
}

export function descendants(n, includeSelf = false) {
  const out = includeSelf ? [n] : [];
  walk((c) => { out.push(c); }, n.children || []);
  return out;
}

// The documents shown together when a folder (or a text with children) is opened.
export function textsUnder(n) {
  return descendants(n, true).filter((c) => c.type === "text");
}

function siblingsOf(id) {
  const p = parentOf(id);
  return p ? p.children : roots();
}

function touchTree() {
  treeVersion++;
  markProject();
}

export function makeNode(type, title, extra) {
  const now = new Date().toISOString();
  return Object.assign({
    id: newId(), type, title, synopsis: "", label: null, status: null,
    include: true, target: 0, created: now, modified: now, children: [],
  }, extra || {});
}

// Adds a node next to (after) or inside a reference node.
export function insert(node, ref, where = "after") {
  const r = typeof ref === "string" ? find(ref) : ref;
  if (!r) draft().children.push(node);
  else if (where === "inside" || isRoot(r)) r.children.push(node);
  else {
    const sibs = siblingsOf(r.id);
    sibs.splice(sibs.indexOf(r) + (where === "before" ? 0 : 1), 0, node);
  }
  if (node.type !== "file" && !store.docs.has(node.id)) store.docs.set(node.id, "");
  touchTree();
  changed("tree", node.id);
  return node;
}

export function canMove(id, targetId, where) {
  const n = find(id), t = find(targetId);
  if (!n || !t || isRoot(n) || n === t) return false;
  if (isAncestor(id, targetId)) return false;
  if (isRoot(t) && where !== "inside") return false;
  if (where === "inside" && t.type === "file") return false;
  return true;
}

export function move(id, targetId, where) {
  if (!canMove(id, targetId, where)) return false;
  const n = find(id);
  const from = siblingsOf(id);
  from.splice(from.indexOf(n), 1);
  treeVersion++;
  const t = find(targetId);
  if (where === "inside") t.children.push(n);
  else {
    const sibs = siblingsOf(targetId);
    sibs.splice(sibs.indexOf(t) + (where === "before" ? 0 : 1), 0, n);
  }
  touchTree();
  changed("tree", id);
  return true;
}

export function moveToTrash(id) {
  const n = find(id);
  if (!n || isRoot(n) || inTrash(id)) return false;
  n.trashedFrom = parentOf(id) ? parentOf(id).id : null;
  return move(id, trash().id, "inside");
}

export function restoreFromTrash(id) {
  const n = find(id);
  if (!n) return false;
  const back = n.trashedFrom && find(n.trashedFrom) && !inTrash(n.trashedFrom) ? n.trashedFrom : draft().id;
  delete n.trashedFrom;
  return move(id, back, "inside");
}

export async function emptyTrash() {
  const t = trash();
  const gone = descendants(t);
  await api.purge(gone.map((n) => ({ id: n.id, type: n.type, file: n.file })));
  for (const n of gone) { store.docs.delete(n.id); store.notes.delete(n.id); store.dirtyDocs.delete(n.id); store.dirtyNotes.delete(n.id); }
  t.children = [];
  touchTree();
  changed("tree", t.id);
}

export async function duplicate(id) {
  const src = find(id);
  if (!src || isRoot(src)) return null;
  const copyOf = async (n) => {
    const c = JSON.parse(JSON.stringify(n));
    c.id = newId();
    c.created = c.modified = new Date().toISOString();
    if (n.type !== "file") {
      store.docs.set(c.id, store.docs.get(n.id) || "");
      store.dirtyDocs.add(c.id);
      const notes = await getNotes(n.id);
      if (notes) { store.notes.set(c.id, notes); store.dirtyNotes.add(c.id); }
    }
    c.children = [];
    for (const ch of n.children || []) c.children.push(await copyOf(ch));
    return c;
  };
  const copy = await copyOf(src);
  copy.title = src.title + " copy";
  insert(copy, src, "after");
  scheduleSave();
  return copy;
}

export function update(id, fields, source) {
  const n = find(id);
  if (!n) return;
  Object.assign(n, fields);
  n.modified = new Date().toISOString();
  markProject();
  changed("title" in fields ? "tree" : "meta", id, source);
}

// ---------- text ----------

export const getDoc = (id) => store.docs.get(id) || "";

export function setDoc(id, html, source) {
  if (store.docs.get(id) === html) return;
  store.docs.set(id, html);
  store.dirtyDocs.add(id);
  const n = find(id);
  if (n) n.modified = new Date().toISOString();
  scheduleSave();
  changed("text", id, source);
}

export async function getNotes(id) {
  if (!store.notes.has(id)) store.notes.set(id, await api.readNotes(id));
  return store.notes.get(id);
}

export function setNotes(id, text) {
  store.notes.set(id, text);
  store.dirtyNotes.add(id);
  scheduleSave();
}

export function wordsOf(id) {
  const html = store.docs.get(id) || "";
  const hit = store.wordCache.get(id);
  if (hit && hit.html === html) return hit.words;
  const words = countWords(htmlToText(html));
  store.wordCache.set(id, { html, words });
  return words;
}

// Words in a node and everything under it.
export function wordsUnder(n) {
  return textsUnder(n).reduce((s, c) => s + wordsOf(c.id), 0);
}

// Words that will be compiled.
export function draftWords() {
  let total = 0;
  const go = (nodes) => {
    for (const n of nodes) {
      if (!n.include) continue;
      if (n.type === "text") total += wordsOf(n.id);
      if (n.children) go(n.children);
    }
  };
  go(draft().children || []);
  return total;
}

export function sessionWords() {
  const s = store.data.session;
  return Math.max(0, draftWords() - (s ? s.start : 0));
}

export function sessionTarget() {
  const t = store.data.targets;
  if (t.autoSession && t.project && t.deadline) {
    const days = daysLeft();
    if (days > 0) {
      // What's left as of the start of today, spread over the days remaining.
      const left = Math.max(0, t.project - (store.data.session ? store.data.session.start : 0));
      return Math.ceil(left / days);
    }
  }
  return t.session || 0;
}

export function daysLeft() {
  const t = store.data.targets;
  if (!t.deadline) return 0;
  const end = new Date(t.deadline + "T23:59:59");
  const start = new Date(todayKey() + "T00:00:00");
  return Math.max(0, Math.ceil((end - start) / 86400000));
}

// ---------- saving ----------

export function markProject() {
  store.projectDirty = true;
  scheduleSave();
}

async function saveAll() {
  const docs = [...store.dirtyDocs];
  const notes = [...store.dirtyNotes];
  const project = store.projectDirty;
  store.dirtyDocs.clear();
  store.dirtyNotes.clear();
  store.projectDirty = false;
  if (!docs.length && !notes.length && !project) return;
  store.saving++;
  changed("save");
  try {
    for (const id of docs) if (store.docs.has(id)) await api.writeDoc(id, store.docs.get(id));
    for (const id of notes) if (store.notes.has(id)) await api.writeNotes(id, store.notes.get(id));
    if (project) await api.saveProject(store.data);
    store.lastError = null;
  } catch (e) {
    // Put the work back so the next save tries again.
    docs.forEach((id) => store.dirtyDocs.add(id));
    notes.forEach((id) => store.dirtyNotes.add(id));
    if (project) store.projectDirty = true;
    store.lastError = e.message || String(e);
    setTimeout(() => scheduleSave(), 3000);
  } finally {
    store.saving--;
    changed("save");
  }
}

let chain = Promise.resolve();
const queueSave = () => (chain = chain.then(saveAll, saveAll));
const saveSoon = debounce(queueSave, 700);

// Saves a moment after the last change, and lets the save indicator know.
export function scheduleSave() {
  saveSoon();
  changed("save");
}
scheduleSave.flush = () => saveSoon.flush();

export const hasUnsaved = () => store.dirtyDocs.size > 0 || store.dirtyNotes.size > 0 || store.projectDirty || store.saving > 0;

export async function flush() {
  scheduleSave.flush();
  await queueSave();
}
