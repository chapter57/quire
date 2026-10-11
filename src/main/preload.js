// The bridge between the page and the main process. The page gets
// window.quire and nothing else from Node or Electron.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("quire", {
  state: call("window:state"),
  newProject: call("project:new"),
  openProject: call("project:open"),
  newWindow: call("project:new-window"),
  saveProject: call("project:save"),
  reveal: call("project:reveal"),

  readDoc: call("doc:read"),
  readDocs: call("doc:read-many"),
  writeDoc: call("doc:write"),
  readNotes: call("notes:read"),
  writeNotes: call("notes:write"),

  listSnapshots: call("snapshot:list"),
  takeSnapshot: call("snapshot:take"),
  readSnapshot: call("snapshot:read"),
  deleteSnapshot: call("snapshot:delete"),

  importResearch: call("research:import"),
  researchUrl: call("research:url"),
  openResearch: call("research:open"),
  importText: call("text:import"),
  purge: call("trash:purge"),

  saveCompiled: call("compile:save"),
  savePdf: call("compile:pdf"),
  showFile: call("app:show-file"),

  confirm: call("app:confirm"),
  popup: call("app:popup"),
  setTitle: call("app:set-title"),
  setFullScreen: call("app:fullscreen"),
  setTheme: call("app:theme"),
  closedReady: call("app:closed-ready"),

  on(channel, fn) {
    const allowed = ["menu", "app:flush-and-close", "app:project-opened", "app:fullscreen"];
    if (!allowed.includes(channel)) throw new Error("Unknown channel " + channel);
    ipcRenderer.on(channel, (event, ...args) => fn(...args));
  },
});
