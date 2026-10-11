// The inspector: synopsis, metadata, notes and snapshots for the selected item.
import { el, debounce, fmt, when, htmlToText, countWords, diffTokens, wordTokens, sanitizeHtml } from "./lib/util.js";
import * as S from "./store.js";

const api = window.quire;

export class Inspector {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.id = null;
    this.tab = "notes";
    this.body = el("div.insp-body");
    root.append(this.body);
    this.saveNotes = debounce(() => {
      if (this.notesFor && this.notesEl) S.setNotes(this.notesFor, this.notesEl.value);
    }, 400);
  }

  show(id) {
    if (this.id === id && this.body.childNodes.length) { this.refreshMeta(); return; }
    this.saveNotes.flush();
    this.id = id;
    this.render();
  }

  render() {
    const n = S.find(this.id);
    if (!n) { this.body.replaceChildren(el("p.empty", "Nothing selected.")); return; }
    const d = S.store.data;
    const editable = !n.role;

    this.synEl = el("textarea.insp-synopsis", {
      placeholder: n.role ? "" : "Synopsis: what happens here, in a line or two",
      disabled: !editable,
      spellcheck: true,
      oninput: () => S.update(n.id, { synopsis: this.synEl.value }, this),
    });
    this.synEl.value = n.synopsis || "";

    this.labelSel = el("select", { disabled: !editable, onchange: () => S.update(n.id, { label: this.labelSel.value || null }, this), id: "insp-label" },
      el("option", { value: "" }, "No Label"), ...d.labels.map((l) => el("option", { value: l.id }, l.name)));
    this.labelSel.value = n.label || "";
    this.statusSel = el("select", { disabled: !editable, onchange: () => S.update(n.id, { status: this.statusSel.value || null }, this), id: "insp-status" },
      el("option", { value: "" }, "No Status"), ...d.statuses.map((s) => el("option", { value: s.id }, s.name)));
    this.statusSel.value = n.status || "";
    this.includeBox = el("input", { type: "checkbox", id: "insp-include", disabled: !editable, checked: !!n.include, onchange: () => S.update(n.id, { include: this.includeBox.checked }, this) });
    this.targetIn = el("input.num", {
      type: "number", min: 0, step: 50, id: "insp-target", placeholder: "None", value: n.target || "",
      onchange: () => S.update(n.id, { target: Math.max(0, parseInt(this.targetIn.value, 10) || 0) }, this),
    });
    this.swatch = el("span.swatch");
    this.progress = el("div.insp-progress");

    const meta = el("div.insp-meta",
      el("label", { for: "insp-label" }, "Label"), el("div.with-swatch", this.swatch, this.labelSel),
      el("label", { for: "insp-status" }, "Status"), this.statusSel,
      n.type === "text" ? el("label", { for: "insp-target" }, "Target") : null,
      n.type === "text" ? el("div.target-row", this.targetIn, el("span.unit", "words")) : null,
      el("label", { for: "insp-include" }, "Compile"), el("label.check", this.includeBox, el("span", "Include in compile")),
    );

    const tabs = n.type === "text"
      ? el("div.tabs", { role: "tablist" },
        tabBtn("Notes", "notes", this), tabBtn("Snapshots", "snapshots", this))
      : null;
    this.tabBody = el("div.tab-body");
    const dates = el("p.insp-dates", "Created " + when(n.created) + (n.modified && n.modified !== n.created ? " · Changed " + when(n.modified) : ""));

    this.body.replaceChildren(
      el("h2.insp-title", n.title || "Untitled"),
      el("div.insp-section", el("h3", "Synopsis"), this.synEl),
      el("div.insp-section", el("h3", "General"), meta, this.progress),
      ...[tabs, this.tabBody, n.role ? null : dates].filter(Boolean),
    );
    this.refreshMeta();
    if (n.type === "text") this.renderTab(n);
    else if (n.type === "folder" && !n.role) this.renderNotesOnly(n);
  }

  // Updates the parts that change while typing, without redrawing.
  refreshMeta() {
    const n = S.find(this.id);
    if (!n || !this.synEl) return;
    const title = this.body.querySelector(".insp-title");
    if (title) title.textContent = n.title || "Untitled";
    if (document.activeElement !== this.synEl && this.synEl.value !== (n.synopsis || "")) this.synEl.value = n.synopsis || "";
    this.labelSel.value = n.label || "";
    this.statusSel.value = n.status || "";
    this.includeBox.checked = !!n.include;
    const label = n.label && S.store.data.labels.find((l) => l.id === n.label);
    this.swatch.style.background = label ? label.color : "transparent";
    this.swatch.classList.toggle("none", !label);
    const words = S.wordsUnder(n);
    if (n.type === "text" && n.target) {
      const pct = Math.min(100, Math.round((S.wordsOf(n.id) / n.target) * 100));
      this.progress.replaceChildren(
        el("div.bar", el("span", { style: { width: pct + "%" } })),
        el("span.bar-label", fmt(S.wordsOf(n.id)) + " of " + fmt(n.target) + " words"),
      );
    } else {
      this.progress.replaceChildren(el("span.bar-label", fmt(words) + " words" + (n.children && n.children.length ? " including everything inside" : "")));
    }
  }

  renderTab(n) {
    this.body.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === this.tab)));
    if (this.tab === "snapshots") this.renderSnapshots(n);
    else this.renderNotes(n);
  }

  renderNotesOnly(n) {
    this.tabBody.replaceChildren(el("h3.solo", "Notes"));
    this.renderNotes(n, true);
  }

  async renderNotes(n, append) {
    this.notesFor = n.id;
    this.notesEl = el("textarea.insp-notes", {
      placeholder: "Notes for this document",
      spellcheck: true,
      oninput: () => this.saveNotes(),
      onblur: () => this.saveNotes.flush(),
    });
    if (append) this.tabBody.append(this.notesEl); else this.tabBody.replaceChildren(this.notesEl);
    const text = await S.getNotes(n.id);
    if (this.notesFor === n.id && document.activeElement !== this.notesEl) this.notesEl.value = text;
  }

  async renderSnapshots(n) {
    const nameIn = el("input", { type: "text", placeholder: "Name (optional)", "aria-label": "Snapshot name" });
    const take = el("button.btn", { onclick: async () => { await this.app.takeSnapshot(n.id, nameIn.value); nameIn.value = ""; } }, "Take Snapshot");
    const list = el("ul.snapshots");
    this.tabBody.replaceChildren(el("div.snap-take", nameIn, take), list);
    const snaps = await api.listSnapshots(n.id);
    if (this.id !== n.id) return;
    if (!snaps.length) { list.append(el("li.empty", "No snapshots yet. A snapshot saves this text as it is now, so you can compare or go back later.")); return; }
    for (const s of snaps) {
      list.append(el("li", el("button.snap", { onclick: () => this.app.openSnapshot(n.id, s) },
        el("span.snap-name", s.name || "Untitled snapshot"),
        el("span.snap-time", when(s.time)))));
    }
  }
}

function tabBtn(label, key, insp) {
  return el("button", {
    role: "tab", dataset: { tab: key },
    onclick: () => { insp.saveNotes.flush(); insp.tab = key; insp.renderTab(S.find(insp.id)); },
  }, label);
}

// ---------- the snapshot window ----------

// Fills a dialog with the snapshot, compared with the text as it is now.
export async function snapshotDialog(dlg, id, snap, app) {
  const n = S.find(id);
  const old = sanitizeHtml(await api.readSnapshot(id, snap.file));
  const now = S.getDoc(id);
  const oldText = htmlToText(old).trim();
  const nowText = htmlToText(now).trim();
  const body = dlg.querySelector(".snap-body");
  const mode = { compare: true };

  const draw = () => {
    if (mode.compare) {
      const parts = diffTokens(wordTokens(oldText), wordTokens(nowText));
      const box = el("div.diff");
      for (const p of parts) {
        const lines = p.text.split(/\n+/);
        lines.forEach((line, i) => {
          if (i) box.append(el("br"), el("br"));
          if (!line) return;
          if (p.op === "same") box.append(line);
          else box.append(el(p.op === "add" ? "ins" : "del", line));
        });
      }
      body.replaceChildren(box);
    } else {
      const view = el("div.snap-text");
      view.innerHTML = old;
      body.replaceChildren(view);
    }
  };
  dlg.querySelector(".snap-heading").textContent = (snap.name || "Snapshot") + " · " + when(snap.time);
  dlg.querySelector(".snap-sub").textContent = (n ? n.title : "") + " — " + fmt(countWords(oldText)) + " words then, " + fmt(countWords(nowText)) + " now";
  const toggle = dlg.querySelector(".snap-toggle");
  toggle.textContent = "Show Snapshot Only";
  toggle.onclick = () => { mode.compare = !mode.compare; toggle.textContent = mode.compare ? "Show Snapshot Only" : "Compare with Current"; draw(); };
  dlg.querySelector(".snap-restore").onclick = async () => {
    const ok = await api.confirm({ message: "Restore this snapshot?", detail: "The text as it is now is saved as a snapshot first, so you can come back to it.", ok: "Restore" });
    if (!ok) return;
    await api.takeSnapshot(id, "Before restoring “" + (snap.name || when(snap.time)) + "”", now);
    S.setDoc(id, old);
    app.refreshAll();
    dlg.close();
  };
  dlg.querySelector(".snap-delete").onclick = async () => {
    const ok = await api.confirm({ message: "Delete this snapshot?", detail: "This can't be undone.", ok: "Delete", danger: true });
    if (!ok) return;
    await api.deleteSnapshot(id, snap.file);
    app.inspector.render();
    dlg.close();
  };
  draw();
  dlg.showModal();
}
