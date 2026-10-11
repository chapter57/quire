// Quire's main process: windows, menus, dialogs and all file access.
// Each window holds at most one project, and its page can only reach files
// inside that project, through the handlers below.
"use strict";

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const { pathToFileURL } = require("url");
const project = require("./project");

const RENDERER = path.join(__dirname, "..", "renderer", "index.html");
const isMac = process.platform === "darwin";

// webContents id -> { win, dir, closing }
const windows = new Map();
let pendingOpen = [];
let quitting = false;

// ---------- recent projects ----------

const recentFile = () => path.join(app.getPath("userData"), "recent.json");

async function readRecent() {
  try {
    const list = JSON.parse(await fs.readFile(recentFile(), "utf8"));
    return Array.isArray(list) ? list.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

async function addRecent(dir) {
  const list = (await readRecent()).filter((p) => p !== dir);
  list.unshift(dir);
  await fs.mkdir(path.dirname(recentFile()), { recursive: true });
  await fs.writeFile(recentFile(), JSON.stringify(list.slice(0, 12), null, 2));
  if (isMac || process.platform === "win32") app.addRecentDocument(dir);
}

async function recentWithNames() {
  const list = await readRecent();
  return list.filter((dir) => project.isProject(dir)).map((dir) => ({ dir, name: path.basename(dir, project.EXT) }));
}

// ---------- windows ----------

function windowFor(dir) {
  for (const w of windows.values()) if (w.dir === dir) return w;
  return null;
}

function emptyWindow() {
  for (const w of windows.values()) if (!w.dir && !w.win.isDestroyed()) return w;
  return null;
}

function createWindow(dir) {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: "Quire",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#17191C" : "#F4F3EE",
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      plugins: true, // the built-in PDF viewer, for PDFs in Research
    },
  });
  const entry = { win, dir: dir || null, closing: false };
  const id = win.webContents.id;
  windows.set(id, entry);

  win.once("ready-to-show", () => win.show());
  win.on("closed", () => windows.delete(id));

  // Ask the page to save everything before the window goes away.
  win.on("close", (e) => {
    if (entry.closing || !entry.dir) return;
    e.preventDefault();
    entry.closing = true;
    win.webContents.send("app:flush-and-close");
    setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, 4000);
  });

  // Links open in the browser, never inside Quire.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });

  win.webContents.on("context-menu", (e, params) => spellMenu(win, params));
  win.on("enter-full-screen", () => win.webContents.send("app:fullscreen", true));
  win.on("leave-full-screen", () => win.webContents.send("app:fullscreen", false));

  win.loadFile(RENDERER);
  if (dir) win.setRepresentedFilename(dir);
  return entry;
}

function spellMenu(win, params) {
  if (!params.isEditable) return;
  const items = [];
  for (const s of params.dictionarySuggestions.slice(0, 6)) {
    items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
  }
  if (params.misspelledWord) {
    if (!items.length) items.push({ label: "No suggestions", enabled: false });
    items.push({
      label: "Add to Dictionary",
      click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    });
    items.push({ type: "separator" });
  }
  items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "pasteAndMatchStyle" }, { type: "separator" }, { role: "selectAll" });
  Menu.buildFromTemplate(items).popup({ window: win });
}

async function openProject(dir, fromWin) {
  dir = path.resolve(dir);
  if (!project.isProject(dir)) {
    dialog.showErrorBox("Can't open project", "\"" + path.basename(dir) + "\" isn't a Quire project.");
    return;
  }
  const existing = windowFor(dir);
  if (existing) {
    existing.win.focus();
    return;
  }
  let entry = fromWin && windows.get(fromWin.webContents.id);
  if (!entry || entry.dir) entry = emptyWindow();
  if (entry) {
    entry.dir = dir;
    entry.win.setRepresentedFilename(dir);
    entry.win.webContents.send("app:project-opened");
    entry.win.focus();
  } else {
    createWindow(dir);
  }
  await addRecent(dir);
  buildMenu();
}

async function chooseAndOpen(fromWin) {
  const res = await dialog.showOpenDialog(fromWin || undefined, {
    title: "Open Project",
    buttonLabel: "Open",
    // On the Mac an installed Quire makes projects look like single files.
    properties: isMac ? ["openFile", "openDirectory"] : ["openDirectory"],
    filters: [{ name: "Quire Project", extensions: ["quire"] }],
  });
  if (res.canceled || !res.filePaths.length) return;
  let dir = res.filePaths[0];
  // Choosing a file inside the project folder works too.
  if (!project.isProject(dir) && project.isProject(path.dirname(dir))) dir = path.dirname(dir);
  await openProject(dir, fromWin);
}

// ---------- menus ----------

// Ctrl+Alt is AltGr on many Windows and Linux keyboards, so those shortcuts are Mac-only.
const macOnly = (accelerator) => (isMac ? accelerator : undefined);

function send(cmd, arg) {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.webContents.send("menu", cmd, arg);
}

async function buildMenu() {
  const recent = await recentWithNames();
  const item = (label, cmd, accelerator, extra) => Object.assign({ label, accelerator, click: () => send(cmd) }, extra || {});
  const template = [];
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" }, { type: "separator" },
        item("Settings…", "project-settings", "CmdOrCtrl+,"),
        { type: "separator" }, { role: "services" }, { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" },
      ],
    });
  }
  template.push({
    label: "File",
    submenu: [
      item("New Project…", "new-project", "CmdOrCtrl+Shift+N"),
      { label: "Open Project…", accelerator: "CmdOrCtrl+O", click: (m, win) => chooseAndOpen(win) },
      {
        label: "Open Recent",
        submenu: recent.length
          ? recent.map((r) => ({ label: r.name, click: (m, win) => openProject(r.dir, win) }))
          : [{ label: "No recent projects", enabled: false }],
      },
      { type: "separator" },
      item("New Text", "new-text", "CmdOrCtrl+N"),
      item("New Folder", "new-folder", macOnly("Cmd+Alt+N")),
      item("Import Text Files…", "import-text"),
      item("Import Research Files…", "import-research"),
      { type: "separator" },
      item("Take Snapshot", "snapshot", "CmdOrCtrl+5"),
      item("Compile…", "compile", "CmdOrCtrl+Shift+E"),
      { type: "separator" },
      item("Show Project in " + (isMac ? "Finder" : "Folder"), "reveal"),
      ...(isMac ? [] : [item("Project Settings…", "project-settings", "CmdOrCtrl+,")]),
      { type: "separator" },
      isMac ? { role: "close" } : { role: "quit" },
    ],
  });
  template.push({
    label: "Edit",
    submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "pasteAndMatchStyle" }, { role: "selectAll" },
      { type: "separator" },
      item("Find in Project…", "find", "CmdOrCtrl+Shift+F"),
      { type: "separator" },
      item("Duplicate", "duplicate", "CmdOrCtrl+D"),
      item("Move to Trash", "trash"),
    ],
  });
  template.push({
    label: "Format",
    submenu: [
      item("Bold", "bold", "CmdOrCtrl+B"),
      item("Italic", "italic", "CmdOrCtrl+I"),
      item("Underline", "underline", "CmdOrCtrl+U"),
      item("Strikethrough", "strike", "CmdOrCtrl+Shift+X"),
      { type: "separator" },
      item("Body Text", "body", macOnly("Cmd+Alt+0")),
      item("Heading 1", "h1", macOnly("Cmd+Alt+1")),
      item("Heading 2", "h2", macOnly("Cmd+Alt+2")),
      item("Heading 3", "h3", macOnly("Cmd+Alt+3")),
      item("Block Quote", "quote", macOnly("Cmd+Alt+Q")),
      item("Bulleted List", "ul", macOnly("Cmd+Alt+U")),
      item("Numbered List", "ol", macOnly("Cmd+Alt+O")),
      item("Scene Break", "scene-break", macOnly("Cmd+Alt+Enter")),
      { type: "separator" },
      item("Split at Cursor", "split", "CmdOrCtrl+K"),
    ],
  });
  template.push({
    label: "View",
    submenu: [
      item("Editor", "view-editor", "CmdOrCtrl+1"),
      item("Corkboard", "view-corkboard", "CmdOrCtrl+2"),
      item("Outliner", "view-outliner", "CmdOrCtrl+3"),
      { type: "separator" },
      item("Show or Hide Binder", "toggle-binder", macOnly("Cmd+Alt+B")),
      item("Show or Hide Inspector", "toggle-inspector", macOnly("Cmd+Alt+I")),
      item("Split Editor", "toggle-split", "CmdOrCtrl+\\"),
      { type: "separator" },
      item("Composition Mode", "composition", "CmdOrCtrl+Shift+Enter"),
      item("Typewriter Scrolling", "typewriter", "CmdOrCtrl+Shift+T"),
      { type: "separator" },
      item("Larger Text", "text-bigger", "CmdOrCtrl+="),
      item("Smaller Text", "text-smaller", "CmdOrCtrl+-"),
      {
        label: "Appearance",
        submenu: [
          item("Match System", "theme-system"),
          item("Light", "theme-light"),
          item("Dark", "theme-dark"),
        ],
      },
      { type: "separator" },
      { role: "togglefullscreen" },
      ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }, { role: "reload" }]),
    ],
  });
  template.push({
    label: "Project",
    submenu: [
      item("Targets…", "targets", "CmdOrCtrl+Shift+G"),
      item("Project Settings…", "project-settings"),
      { type: "separator" },
      item("Go Up to Parent", "go-up"),
      item("Empty Trash…", "empty-trash"),
    ],
  });
  template.push({ role: "windowMenu" });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC ----------

function entryOf(event) {
  const entry = windows.get(event.sender.id);
  if (!entry) throw new Error("No window");
  return entry;
}

function dirOf(event) {
  const entry = entryOf(event);
  if (!entry.dir) throw new Error("No project is open in this window");
  return entry.dir;
}

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => fn(event, ...args));
}

function registerIpc() {
  handle("window:state", async (event) => {
    const entry = entryOf(event);
    if (!entry.dir) return { project: null, recent: await recentWithNames(), platform: process.platform };
    const data = await project.load(entry.dir);
    return { project: { dir: entry.dir, name: path.basename(entry.dir, project.EXT), data }, platform: process.platform };
  });

  handle("project:new", async (event, { title, author, kind }) => {
    const entry = entryOf(event);
    const res = await dialog.showSaveDialog(entry.win, {
      title: "Create Project",
      buttonLabel: "Create",
      defaultPath: path.join(app.getPath("documents"), (title || "Untitled").replace(/[\\/:*?"<>|]/g, "-") + project.EXT),
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (res.canceled || !res.filePath) return null;
    const { dir } = await project.create(res.filePath, title || "Untitled", author, kind);
    await openProject(dir, entry.win);
    return dir;
  });

  handle("project:open", async (event, dir) => {
    const entry = entryOf(event);
    if (dir) await openProject(dir, entry.win);
    else await chooseAndOpen(entry.win);
  });

  handle("project:new-window", () => { createWindow(null); });
  handle("project:save", (event, data) => project.save(dirOf(event), data));
  handle("project:reveal", (event) => { shell.showItemInFolder(dirOf(event)); });

  handle("doc:read", (event, id) => project.readDoc(dirOf(event), id));
  handle("doc:read-many", (event, ids) => project.readDocs(dirOf(event), ids));
  handle("doc:write", (event, id, html) => project.writeDoc(dirOf(event), id, html));
  handle("notes:read", (event, id) => project.readNotes(dirOf(event), id));
  handle("notes:write", (event, id, text) => project.writeNotes(dirOf(event), id, text));

  handle("snapshot:list", (event, id) => project.listSnapshots(dirOf(event), id));
  handle("snapshot:take", (event, id, name, html) => project.takeSnapshot(dirOf(event), id, name, html));
  handle("snapshot:read", (event, id, file) => project.readSnapshot(dirOf(event), id, file));
  handle("snapshot:delete", (event, id, file) => project.deleteSnapshot(dirOf(event), id, file));

  handle("research:import", async (event) => {
    const entry = entryOf(event);
    const res = await dialog.showOpenDialog(entry.win, {
      title: "Import Research Files",
      buttonLabel: "Import",
      properties: ["openFile", "multiSelections"],
    });
    if (res.canceled) return [];
    return project.importResearch(dirOf(event), res.filePaths);
  });
  handle("research:url", (event, file) => pathToFileURL(project.researchPath(dirOf(event), file)).href);
  handle("research:open", (event, file) => shell.openPath(project.researchPath(dirOf(event), file)));

  handle("text:import", async (event) => {
    const entry = entryOf(event);
    const res = await dialog.showOpenDialog(entry.win, {
      title: "Import Text Files",
      buttonLabel: "Import",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Text", extensions: ["txt", "md", "markdown", "text"] }],
    });
    if (res.canceled) return [];
    const out = [];
    for (const file of res.filePaths) {
      out.push({ title: path.basename(file, path.extname(file)), text: await fs.readFile(file, "utf8"), markdown: /\.(md|markdown)$/i.test(file) });
    }
    return out;
  });

  handle("trash:purge", (event, nodes) => project.purge(dirOf(event), nodes));

  handle("compile:save", async (event, { name, ext, data }) => {
    const entry = entryOf(event);
    const res = await dialog.showSaveDialog(entry.win, {
      title: "Compile",
      buttonLabel: "Compile",
      defaultPath: path.join(app.getPath("documents"), name + "." + ext),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (res.canceled || !res.filePath) return null;
    await fs.writeFile(res.filePath, typeof data === "string" ? data : Buffer.from(data));
    return res.filePath;
  });

  handle("compile:pdf", async (event, { name, html }) => {
    const entry = entryOf(event);
    const res = await dialog.showSaveDialog(entry.win, {
      title: "Compile",
      buttonLabel: "Compile",
      defaultPath: path.join(app.getPath("documents"), name + ".pdf"),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (res.canceled || !res.filePath) return null;
    const pdf = await htmlToPdf(html);
    await fs.writeFile(res.filePath, pdf);
    return res.filePath;
  });

  handle("app:show-file", (event, file) => { shell.showItemInFolder(file); });

  handle("app:confirm", async (event, { message, detail, ok, danger }) => {
    const entry = entryOf(event);
    const res = await dialog.showMessageBox(entry.win, {
      type: danger ? "warning" : "question",
      message, detail,
      buttons: [ok || "OK", "Cancel"],
      defaultId: danger ? 1 : 0,
      cancelId: 1,
    });
    return res.response === 0;
  });

  // A native menu built from the page's description; resolves to the chosen id.
  handle("app:popup", (event, items) => new Promise((resolve) => {
    const entry = entryOf(event);
    let chosen = null;
    const build = (list) => list.map((it) => {
      if (it.type === "separator") return { type: "separator" };
      const m = { label: String(it.label), enabled: it.enabled !== false };
      if (it.checked !== undefined) { m.type = "checkbox"; m.checked = !!it.checked; }
      if (it.submenu) m.submenu = build(it.submenu);
      else m.click = () => { chosen = it.id; };
      return m;
    });
    Menu.buildFromTemplate(build(items)).popup({ window: entry.win, callback: () => setTimeout(() => resolve(chosen), 0) });
  }));

  handle("app:set-title", (event, title, edited) => {
    const entry = entryOf(event);
    entry.win.setTitle(title);
    if (isMac) entry.win.setDocumentEdited(!!edited);
  });
  handle("app:fullscreen", (event, on) => {
    const entry = entryOf(event);
    entry.win.setFullScreen(!!on);
  });
  handle("app:theme", (event, theme) => { nativeTheme.themeSource = theme; });
  handle("app:closed-ready", (event) => {
    const entry = entryOf(event);
    entry.closing = true;
    entry.win.destroy();
    // Closing was holding up a quit; carry on with it now everything is saved.
    if (quitting) app.quit();
  });
}

async function htmlToPdf(html) {
  // A whole manuscript is too long for a data: URL, so it goes through a temporary file.
  const tmp = await fs.mkdtemp(path.join(app.getPath("temp"), "quire-pdf-"));
  const file = path.join(tmp, "manuscript.html");
  await fs.writeFile(file, html);
  const pdfWin = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, javascript: false },
  });
  try {
    await pdfWin.loadFile(file);
    return await pdfWin.webContents.printToPDF({
      pageSize: "Letter",
      printBackground: false,
      margins: { top: 1, bottom: 1, left: 1, right: 1 },
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: '<div style="font-size:9px;width:100%;text-align:center;color:#666"><span class="pageNumber"></span></div>',
    });
  } finally {
    pdfWin.destroy();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ---------- start ----------

// A project can arrive as a command-line argument, or on the Mac from Finder.
function projectArgs(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith("-") && project.isProject(path.resolve(a)));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (e, argv) => {
    const dirs = projectArgs(argv);
    if (dirs.length) dirs.forEach((d) => openProject(d));
    else {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
    }
  });

  app.on("open-file", (e, file) => {
    e.preventDefault();
    if (app.isReady()) openProject(file);
    else pendingOpen.push(file);
  });

  app.whenReady().then(async () => {
    if (process.env.QUIRE_USER_DATA) app.setPath("userData", process.env.QUIRE_USER_DATA);
    registerIpc();
    await buildMenu();
    const dirs = [...pendingOpen, ...projectArgs(process.argv)];
    pendingOpen = [];
    if (dirs.length) for (const d of dirs) await openProject(d);
    else createWindow(null);
    app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(null); });
  });

  app.on("before-quit", () => { quitting = true; });
  app.on("window-all-closed", () => { if (!isMac || quitting) app.quit(); });
}
