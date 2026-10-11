// Reading and writing Quire projects on disk.
//
// A project is a folder whose name ends in ".quire":
//
//   My Novel.quire/
//     project.json            binder tree, labels, statuses, targets, settings
//     docs/<id>.html          the text of each document
//     notes/<id>.txt          the inspector notes of each document
//     snapshots/<id>/<n>.html saved versions of a document
//     research/<file>         files imported into the Research folder
//
// Everything here is plain files so a project survives without Quire and
// works with any sync service or version control.
"use strict";

const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");

const FORMAT = 1;
const EXT = ".quire";

const DEFAULT_LABELS = [
  { id: "l-red", name: "Red", color: "#C8553D" },
  { id: "l-orange", name: "Orange", color: "#D9893B" },
  { id: "l-yellow", name: "Yellow", color: "#C9A227" },
  { id: "l-green", name: "Green", color: "#5B8C5A" },
  { id: "l-blue", name: "Blue", color: "#3F6E9E" },
  { id: "l-purple", name: "Purple", color: "#7A5A9E" },
];

const DEFAULT_STATUSES = [
  { id: "s-todo", name: "To Do" },
  { id: "s-first", name: "First Draft" },
  { id: "s-revised", name: "Revised Draft" },
  { id: "s-final", name: "Final Draft" },
  { id: "s-done", name: "Done" },
];

function newId() {
  return crypto.randomBytes(6).toString("hex");
}

function node(type, title, extra) {
  const now = new Date().toISOString();
  return Object.assign({
    id: newId(), type, title, synopsis: "", label: null, status: null,
    include: true, target: 0, created: now, modified: now, children: [],
  }, extra || {});
}

// The starting binder and documents for each template.
function template(kind) {
  const docs = {};
  const text = (title, html, extra) => {
    const n = node("text", title, extra);
    if (html) docs[n.id] = html;
    return n;
  };
  const folder = (title, children, extra) => Object.assign(node("folder", title, extra), { children });

  let draft, research;
  if (kind === "novel") {
    draft = folder("Manuscript", [
      folder("Chapter One", [
        text("Scene One", "", { synopsis: "Where the story opens." }),
        text("Scene Two", ""),
      ]),
      folder("Chapter Two", [text("Scene One", "")]),
    ]);
    research = folder("Research", [
      folder("Characters", [text("Character Sketch", "<h2>Name</h2><p>Role in the story:</p><p>Wants:</p><p>Fears:</p><p>Physical description:</p>")]),
      folder("Places", [text("Setting Sketch", "<h2>Place</h2><p>What it looks, sounds and smells like:</p><p>Why it matters to the story:</p>")]),
      text("Ideas", ""),
    ]);
  } else if (kind === "story") {
    draft = folder("Manuscript", [text("Scene One", ""), text("Scene Two", ""), text("Scene Three", "")]);
    research = folder("Research", [text("Notes", "")]);
  } else if (kind === "nonfiction") {
    draft = folder("Manuscript", [
      text("Introduction", ""),
      folder("Part One", [text("Chapter One", ""), text("Chapter Two", "")]),
      text("Conclusion", ""),
    ]);
    research = folder("Research", [text("Sources", ""), text("Outline", "")]);
  } else {
    draft = folder("Manuscript", [text("Untitled", "")]);
    research = folder("Research", []);
  }
  draft.role = "draft";
  research.role = "research";
  const trash = folder("Trash", [], { role: "trash" });
  return { roots: [draft, research, trash], docs };
}

function newProjectData(title, author, kind) {
  const t = template(kind);
  const now = new Date().toISOString();
  return {
    data: {
      format: FORMAT,
      title,
      author: author || "",
      created: now,
      modified: now,
      binder: t.roots,
      labels: DEFAULT_LABELS.map((l) => ({ ...l })),
      statuses: DEFAULT_STATUSES.map((s) => ({ ...s })),
      targets: { project: 0, session: 0, deadline: "" },
      session: { date: "", start: 0 },
      compile: {
        format: "docx", titlePage: true, folderTitles: true, textTitles: false,
        separator: "#", chapterBreaks: true, font: "Georgia",
      },
      ui: { selected: t.roots[0].children[0] ? t.roots[0].children[0].id : t.roots[0].id, expanded: [t.roots[0].id] },
    },
    docs: t.docs,
  };
}

// ---------- paths ----------

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function checkId(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("Bad document id");
  return id;
}

// Joins a path inside the project and refuses anything that would step outside it.
function inside(root, ...parts) {
  const full = path.resolve(root, ...parts);
  const base = path.resolve(root) + path.sep;
  if (!full.startsWith(base)) throw new Error("Path outside project");
  return full;
}

function isProject(dir) {
  try {
    return fsSync.statSync(path.join(dir, "project.json")).isFile();
  } catch {
    return false;
  }
}

// ---------- whole project ----------

async function writeAtomic(file, contents) {
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  await fs.writeFile(tmp, contents);
  await fs.rename(tmp, file);
}

async function create(dir, title, author, kind) {
  if (!dir.endsWith(EXT)) dir += EXT;
  try {
    await fs.access(dir);
    throw new Error("A file or folder named \"" + path.basename(dir) + "\" already exists there.");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await fs.mkdir(dir, { recursive: true });
  for (const sub of ["docs", "notes", "snapshots", "research"]) await fs.mkdir(path.join(dir, sub), { recursive: true });
  const { data, docs } = newProjectData(title, author, kind);
  for (const [id, html] of Object.entries(docs)) await writeAtomic(path.join(dir, "docs", id + ".html"), html);
  await writeAtomic(path.join(dir, "project.json"), JSON.stringify(data, null, 2));
  return { dir, data };
}

async function load(dir) {
  const raw = await fs.readFile(path.join(dir, "project.json"), "utf8");
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.binder)) throw new Error("This doesn't look like a Quire project.");
  if (data.format > FORMAT) throw new Error("This project was made by a newer version of Quire.");
  for (const sub of ["docs", "notes", "snapshots", "research"]) await fs.mkdir(path.join(dir, sub), { recursive: true });
  return data;
}

async function save(dir, data) {
  data.modified = new Date().toISOString();
  await writeAtomic(path.join(dir, "project.json"), JSON.stringify(data, null, 2));
}

// ---------- documents and notes ----------

async function readOr(file, fallback) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

const readDoc = async (dir, id) => readOr(inside(dir, "docs", checkId(id) + ".html"), "");
const writeDoc = async (dir, id, html) => writeAtomic(inside(dir, "docs", checkId(id) + ".html"), String(html));
const readNotes = async (dir, id) => readOr(inside(dir, "notes", checkId(id) + ".txt"), "");
const writeNotes = async (dir, id, text) => writeAtomic(inside(dir, "notes", checkId(id) + ".txt"), String(text));

async function readDocs(dir, ids) {
  const out = {};
  for (const id of ids) out[id] = await readDoc(dir, id);
  return out;
}

// ---------- snapshots ----------
// Each snapshot is docs/<id>.html as it was, saved as snapshots/<id>/<time>.html
// with its name in a small JSON index next to it.

async function snapshotIndex(dir, id) {
  const raw = await readOr(inside(dir, "snapshots", checkId(id), "index.json"), "[]");
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function listSnapshots(dir, id) {
  const list = await snapshotIndex(dir, id);
  return list.sort((a, b) => (a.time < b.time ? 1 : -1));
}

async function takeSnapshot(dir, id, name, html) {
  const folder = inside(dir, "snapshots", checkId(id));
  await fs.mkdir(folder, { recursive: true });
  const time = new Date().toISOString();
  const file = time.replace(/[:.]/g, "-") + ".html";
  await writeAtomic(path.join(folder, file), String(html));
  const list = await snapshotIndex(dir, id);
  const entry = { time, file, name: String(name || "").slice(0, 200) };
  list.push(entry);
  await writeAtomic(path.join(folder, "index.json"), JSON.stringify(list, null, 2));
  return entry;
}

async function readSnapshot(dir, id, file) {
  if (!/^[0-9TZ-]+\.html$/.test(file)) throw new Error("Bad snapshot name");
  return fs.readFile(inside(dir, "snapshots", checkId(id), file), "utf8");
}

async function deleteSnapshot(dir, id, file) {
  if (!/^[0-9TZ-]+\.html$/.test(file)) throw new Error("Bad snapshot name");
  const folder = inside(dir, "snapshots", checkId(id));
  await fs.rm(path.join(folder, file), { force: true });
  const list = (await snapshotIndex(dir, id)).filter((s) => s.file !== file);
  await writeAtomic(path.join(folder, "index.json"), JSON.stringify(list, null, 2));
}

// ---------- research files ----------

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf",
  ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
};

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
}

function safeFileName(name) {
  const cleaned = path.basename(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").slice(0, 120);
  return cleaned || "file";
}

// Copies files into research/ and returns { file, title, mime } for each.
async function importResearch(dir, sources) {
  const out = [];
  for (const src of sources) {
    const base = safeFileName(src);
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    let name = base;
    for (let n = 2; fsSync.existsSync(inside(dir, "research", name)); n++) name = stem + " " + n + ext;
    await fs.copyFile(src, inside(dir, "research", name));
    out.push({ file: "research/" + name, title: stem, mime: mimeOf(name) });
  }
  return out;
}

function researchPath(dir, file) {
  if (typeof file !== "string" || !file.startsWith("research/")) throw new Error("Bad research path");
  return inside(dir, file);
}

// ---------- emptying the trash ----------

async function purge(dir, nodes) {
  for (const n of nodes) {
    checkId(n.id);
    await fs.rm(inside(dir, "docs", n.id + ".html"), { force: true });
    await fs.rm(inside(dir, "notes", n.id + ".txt"), { force: true });
    await fs.rm(inside(dir, "snapshots", n.id), { recursive: true, force: true });
    if (n.type === "file" && n.file) await fs.rm(researchPath(dir, n.file), { force: true });
  }
}

module.exports = {
  EXT, FORMAT, newId, node, newProjectData, template, isProject, inside, checkId,
  create, load, save, readDoc, writeDoc, readDocs, readNotes, writeNotes,
  listSnapshots, takeSnapshot, readSnapshot, deleteSnapshot,
  importResearch, researchPath, mimeOf, purge,
};
