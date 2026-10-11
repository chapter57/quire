// A pane shows one binder item as an editor, a corkboard or an outliner.
// There are two panes when the editor is split; the one last clicked is active.
import { el, debounce, sanitizeHtml, plainToHtml, htmlToText, fmt } from "./lib/util.js";
import * as S from "./store.js";
import { iconFor, iconSpan, labelOf, statusOf } from "./binder.js";

const api = window.quire;

export class Pane {
  constructor(app, name) {
    this.app = app;
    this.name = name;
    this.nodeId = null;
    this.view = "editor";
    this.collapsed = new Set(); // outliner rows folded shut
    this.crumbs = el("nav.crumbs", { "aria-label": "Location" });
    this.closeBtn = el("button.icon-btn.pane-close", { title: "Close split", hidden: name === "a", onclick: () => app.command("toggle-split") }, "×");
    this.head = el("div.pane-head", this.crumbs, el("span.grow"), this.closeBtn);
    this.body = el("div.pane-body");
    this.root = el("section.pane", { dataset: { pane: name } }, this.head, this.body);
    this.root.addEventListener("focusin", () => app.setActivePane(this));
    this.root.addEventListener("mousedown", () => app.setActivePane(this));
    this.commits = new Map(); // section id -> debounced commit
  }

  get node() { return S.find(this.nodeId); }

  show(id, view) {
    this.flushEdits();
    this.nodeId = id;
    if (view) this.view = view;
    this.render();
  }

  setView(view) {
    if (this.view === view) return;
    this.flushEdits();
    this.view = view;
    this.render();
  }

  render() {
    this.flushEdits();
    const n = this.node;
    this.renderCrumbs();
    this.body.className = "pane-body view-" + this.view;
    this.body.scrollTop = 0;
    if (!n) {
      this.body.replaceChildren(el("div.empty", "Nothing selected."));
      return;
    }
    if (n.type === "file") return this.renderFile(n);
    if (this.view === "corkboard") return this.renderCorkboard(n);
    if (this.view === "outliner") return this.renderOutliner(n);
    return this.renderEditor(n);
  }

  renderCrumbs() {
    const n = this.node;
    const parts = n ? S.pathOf(n.id) : [];
    this.crumbs.replaceChildren(...parts.flatMap((p, i) => [
      i ? el("span.crumb-sep", "›") : null,
      el("button.crumb", { onclick: () => this.app.binder.select(p.id) }, p.title || "Untitled"),
    ]).filter(Boolean));
  }

  // ---------- editor ----------

  renderEditor(n) {
    const texts = S.textsUnder(n);
    const page = el("div.page");
    if (!texts.length) {
      page.append(el("div.empty",
        el("p", n.type === "folder" ? "This folder has no texts in it yet." : "Nothing to show."),
        el("button.btn", { onclick: () => this.app.command("new-text") }, "Add a text"),
      ));
    }
    const many = texts.length > 1;
    for (const t of texts) page.append(this.section(t, many));
    if (this.app.prefs.typewriter) page.classList.add("typewriter");
    this.body.replaceChildren(page);
  }

  section(t, many) {
    const ed = el("div.editable", {
      contenteditable: S.inTrash(t.id) ? "false" : "true",
      spellcheck: true,
      dataset: { id: t.id, placeholder: many ? "" : "Start writing…" },
      role: "textbox",
      "aria-multiline": "true",
      "aria-label": t.title || "Untitled",
    });
    ed.innerHTML = S.getDoc(t.id) || "<p><br></p>";
    const head = el("div.sec-head",
      el("button.sec-title", { onclick: () => this.app.inspect(t.id) }, t.title || "Untitled"),
    );
    const sec = el("div.sec" + (many ? ".joined" : ""), { dataset: { id: t.id } }, head, ed);
    this.wireEditable(ed, t.id);
    return sec;
  }

  wireEditable(ed, id) {
    const commit = debounce(() => {
      S.setDoc(id, sanitizeHtml(ed.innerHTML), this);
    }, 250);
    this.commits.set(id, commit);
    ed.addEventListener("input", () => {
      commit();
      this.app.updateCounts(true);
      if (this.app.prefs.typewriter) this.typewriterScroll();
    });
    ed.addEventListener("focus", () => {
      this.app.inspect(id, false);
      document.execCommand("defaultParagraphSeparator", false, "p");
      document.execCommand("styleWithCSS", false, false);
    });
    ed.addEventListener("blur", () => commit.flush());
    ed.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
      }
      if (this.app.prefs.typewriter && (e.key === "Enter" || e.key.startsWith("Arrow"))) requestAnimationFrame(() => this.typewriterScroll());
    });
    ed.addEventListener("paste", (e) => {
      e.preventDefault();
      const dt = e.clipboardData;
      const html = dt.getData("text/html");
      const text = dt.getData("text/plain");
      if (html) document.execCommand("insertHTML", false, sanitizeHtml(html));
      else if (text && /\n/.test(text.trim())) document.execCommand("insertHTML", false, plainToHtml(text.trim()));
      else if (text) document.execCommand("insertText", false, text);
    });
    ed.addEventListener("drop", (e) => {
      // Dropped files go to Research, not into the text.
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) e.preventDefault();
    });
  }

  flushEdits() {
    for (const c of this.commits.values()) c.flush();
    this.commits.clear();
  }

  // Called when a document changed somewhere else, so this pane can catch up.
  refreshText(id, source) {
    if (source === this) return;
    if (this.view === "editor") {
      const ed = this.body.querySelector('.editable[data-id="' + id + '"]');
      if (ed && document.activeElement !== ed) ed.innerHTML = S.getDoc(id) || "<p><br></p>";
    } else if (this.view !== "editor") {
      this.updateWordCells();
    }
  }

  typewriterScroll() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0).cloneRange();
    let rect = range.getClientRects()[0];
    if (!rect) {
      const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      rect = node.getBoundingClientRect();
    }
    const box = this.body.getBoundingClientRect();
    const want = box.top + box.height * 0.45;
    this.body.scrollTop += rect.top - want;
  }

  activeEditable() {
    const a = document.activeElement;
    return a && a.classList && a.classList.contains("editable") && this.root.contains(a) ? a : null;
  }

  focusEditor() {
    const ed = this.body.querySelector(".editable");
    if (!ed) return;
    ed.focus();
    const r = document.createRange();
    r.selectNodeContents(ed);
    r.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  // Selects the first match for q in the editor and scrolls to it.
  find(q) {
    if (this.view !== "editor" || !q) return;
    const low = q.toLowerCase();
    for (const ed of this.body.querySelectorAll(".editable")) {
      const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const at = t.nodeValue.toLowerCase().indexOf(low);
        if (at < 0) continue;
        const r = document.createRange();
        r.setStart(t, at);
        r.setEnd(t, at + q.length);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        t.parentElement.scrollIntoView({ block: "center" });
        return;
      }
    }
  }

  // Splits the current text at the cursor, moving the rest into a new text after it.
  splitAtCursor() {
    const ed = this.activeEditable();
    if (!ed) return false;
    const id = ed.dataset.id;
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    const r = sel.getRangeAt(0);
    const tail = document.createRange();
    tail.setStart(r.startContainer, r.startOffset);
    tail.setEnd(ed, ed.childNodes.length);
    const frag = tail.extractContents();
    const holder = el("div");
    holder.append(frag);
    // Remove the empty shell left behind by the split.
    const last = ed.lastElementChild;
    if (last && !last.textContent.trim() && ed.children.length > 1) last.remove();
    S.setDoc(id, sanitizeHtml(ed.innerHTML), this);
    const src = S.find(id);
    const piece = S.makeNode("text", src.title + " (2)", { label: src.label, status: src.status });
    S.insert(piece, src, "after");
    S.setDoc(piece.id, sanitizeHtml(holder.innerHTML) || "<p></p>");
    return piece;
  }

  // ---------- corkboard ----------

  boardItems(n) {
    if (n.children && n.children.length) return { container: n, items: n.children, focus: null };
    const p = S.parentOf(n.id);
    if (n.type === "folder" || !p) return { container: n, items: [], focus: null };
    return { container: p, items: p.children, focus: n.id };
  }

  renderCorkboard(n) {
    const { container, items, focus } = this.boardItems(n);
    const board = el("div.cork");
    for (const c of items) board.append(this.card(c, c.id === focus));
    if (!S.inTrash(container.id)) {
      board.append(el("button.card.add-card", {
        title: "Add a card",
        onclick: () => {
          const t = S.makeNode("text", "Untitled");
          S.insert(t, container, "inside");
          this.render();
          const titleEl = this.body.querySelector('.card[data-id="' + t.id + '"] .card-title');
          if (titleEl) { titleEl.focus(); document.execCommand("selectAll"); }
        },
      }, el("span", "+"), el("span.add-label", "New card")));
    }
    if (!items.length) board.prepend(el("p.empty.board-empty", "No cards here yet."));
    this.body.replaceChildren(board);
    this.wireCardDrag(board, container);
  }

  card(c, focused) {
    const label = labelOf(c);
    const status = statusOf(c);
    const auto = !c.synopsis && c.type === "text" ? htmlToText(S.getDoc(c.id)).replace(/\s+/g, " ").trim().slice(0, 240) : "";
    const title = el("div.card-title", {
      contenteditable: "plaintext-only", spellcheck: false,
      onblur: () => { const v = title.textContent.trim(); if (v && v !== c.title) S.update(c.id, { title: v }, this); },
      onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); syn.focus(); } if (e.key === "Escape") { title.textContent = c.title; title.blur(); } },
    }, c.title || "Untitled");
    const syn = el("textarea.card-synopsis", {
      placeholder: auto || "Synopsis",
      spellcheck: true,
      oninput: () => S.update(c.id, { synopsis: syn.value }, this),
    });
    syn.value = c.synopsis || "";
    const card = el("article.card" + (focused ? ".focused" : "") + (c.id === this.app.inspecting ? ".selected" : ""), {
      dataset: { id: c.id },
      draggable: true,
      style: label ? { "--label": label.color } : undefined,
      onmousedown: () => this.app.inspect(c.id),
      ondblclick: (e) => { if (!e.target.closest(".card-title, .card-synopsis")) this.app.openNode(c.id, "editor"); },
    },
    el("header.card-head", iconSpan(iconFor(c)), title),
    syn,
    el("footer.card-foot",
      status ? el("span.stamp", status.name) : el("span"),
      c.type === "file" ? el("span") : el("span.words", { dataset: { words: c.id } }, fmt(S.wordsUnder(c)) + " words"),
    ));
    if (!c.include) card.classList.add("excluded");
    return card;
  }

  wireCardDrag(board) {
    let dragId = null;
    const clear = () => board.querySelectorAll(".drop-before, .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
    board.addEventListener("dragstart", (e) => {
      const card = e.target.closest(".card[data-id]");
      if (!card || e.target.closest(".card-synopsis, .card-title")) { if (card) e.preventDefault(); return; }
      dragId = card.dataset.id;
      this.app.cardDrag = { id: dragId };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/x-quire-node", dragId);
      card.classList.add("dragging");
    });
    board.addEventListener("dragend", () => { dragId = null; this.app.cardDrag = null; clear(); board.querySelectorAll(".dragging").forEach((x) => x.classList.remove("dragging")); });
    board.addEventListener("dragover", (e) => {
      const card = e.target.closest(".card[data-id]");
      clear();
      if (!card || !dragId || card.dataset.id === dragId) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      card.classList.add(e.clientX < r.left + r.width / 2 ? "drop-before" : "drop-after");
    });
    board.addEventListener("drop", (e) => {
      const card = e.target.closest(".card[data-id]");
      if (!card || !dragId) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      const where = e.clientX < r.left + r.width / 2 ? "before" : "after";
      const moved = dragId;
      clear();
      S.move(moved, card.dataset.id, where);
      this.render();
    });
  }

  // ---------- outliner ----------

  renderOutliner(n) {
    const base = n.children && n.children.length ? n : (S.parentOf(n.id) && n.type !== "folder" ? S.parentOf(n.id) : n);
    const d = S.store.data;
    const table = el("table.outline");
    table.append(el("thead", el("tr",
      el("th.col-title", "Title"), el("th.col-syn", "Synopsis"), el("th.col-label", "Label"),
      el("th.col-status", "Status"), el("th.col-num", "Words"), el("th.col-num", "Target"), el("th.col-inc", { title: "Include in compile" }, "Compile"),
    )));
    const tbody = el("tbody");
    const rows = (nodes, depth) => {
      for (const c of nodes) {
        tbody.append(this.outlineRow(c, depth, d));
        if (c.children && c.children.length && !this.collapsed.has(c.id)) rows(c.children, depth + 1);
      }
    };
    rows(base.children || [], 0);
    table.append(tbody);
    const total = S.wordsUnder(base);
    const wrap = el("div.outline-wrap", table,
      base.children && base.children.length ? el("p.outline-total", fmt(total) + " words in " + (base.title || "Untitled")) : el("p.empty", "Nothing in here yet."));
    this.body.replaceChildren(wrap);
  }

  outlineRow(c, depth, d) {
    const has = c.children && c.children.length;
    const editCell = (field, cls) => {
      const div = el("div." + cls, {
        contenteditable: "plaintext-only", spellcheck: field === "synopsis",
        onblur: () => { const v = field === "title" ? div.textContent.trim() : div.textContent; if ((field !== "title" || v) && v !== (c[field] || "")) S.update(c.id, { [field]: v }, this); },
        onkeydown: (e) => { if (e.key === "Enter" && (field === "title" || !e.shiftKey)) { e.preventDefault(); div.blur(); } },
      }, c[field] || "");
      if (field === "synopsis") div.dataset.placeholder = "—";
      return div;
    };
    const labelSel = el("select.mini", { onchange: () => S.update(c.id, { label: labelSel.value || null }, this), "aria-label": "Label" },
      el("option", { value: "" }, "—"), ...d.labels.map((l) => el("option", { value: l.id, selected: c.label === l.id }, l.name)));
    const statusSel = el("select.mini", { onchange: () => S.update(c.id, { status: statusSel.value || null }, this), "aria-label": "Status" },
      el("option", { value: "" }, "—"), ...d.statuses.map((s) => el("option", { value: s.id, selected: c.status === s.id }, s.name)));
    const label = labelOf(c);
    const target = c.type === "text" ? el("input.mini.num", {
      type: "number", min: 0, step: 50, value: c.target || "", placeholder: "—", "aria-label": "Target",
      onchange: (e) => S.update(c.id, { target: Math.max(0, parseInt(e.target.value, 10) || 0) }, this),
    }) : "";
    return el("tr" + (c.id === this.app.inspecting ? ".selected" : "") + (c.include ? "" : ".excluded"), {
      dataset: { id: c.id },
      onmousedown: () => this.app.inspect(c.id),
    },
    el("td.col-title", el("div.cell-title", { style: { paddingLeft: depth * 18 + "px" } },
      el("button.twisty" + (has ? "" : ".none") + (has && !this.collapsed.has(c.id) ? ".open" : ""), {
        tabindex: -1, "aria-label": "Expand",
        onclick: () => { if (this.collapsed.has(c.id)) this.collapsed.delete(c.id); else this.collapsed.add(c.id); this.render(); },
      }),
      iconSpan(iconFor(c)),
      label ? el("span.dot", { style: { background: label.color } }) : null,
      editCell("title", "t"),
      el("button.open-btn", { title: "Open in editor", onclick: () => this.app.openNode(c.id, "editor") }, "↗"),
    )),
    el("td.col-syn", editCell("synopsis", "s")),
    el("td.col-label", labelSel),
    el("td.col-status", statusSel),
    el("td.col-num", el("span", { dataset: { words: c.id } }, c.type === "file" ? "" : fmt(S.wordsUnder(c)))),
    el("td.col-num", target),
    el("td.col-inc", el("input", { type: "checkbox", checked: !!c.include, "aria-label": "Include in compile", onchange: (e) => S.update(c.id, { include: e.target.checked }, this) })),
    );
  }

  updateWordCells() {
    for (const w of this.body.querySelectorAll("[data-words]")) {
      const n = S.find(w.dataset.words);
      if (!n) continue;
      const words = fmt(S.wordsUnder(n));
      w.textContent = this.view === "corkboard" ? words + " words" : words;
    }
  }

  // ---------- research files ----------

  async renderFile(n) {
    const url = await api.researchUrl(n.file);
    const m = n.mime || "";
    let view;
    if (m.startsWith("image/")) view = el("img.research-img", { src: url, alt: n.title });
    else if (m === "application/pdf") view = el("iframe.research-pdf", { src: url, title: n.title });
    else if (m.startsWith("audio/")) view = el("audio", { src: url, controls: true });
    else if (m.startsWith("video/")) view = el("video.research-video", { src: url, controls: true });
    else view = el("div.empty", el("p", "Quire can't show this kind of file itself."));
    this.body.replaceChildren(el("div.research",
      el("div.research-bar",
        el("span.research-name", n.file.replace(/^research\//, "")),
        el("span.grow"),
        el("button.btn", { onclick: () => api.openResearch(n.file) }, "Open in Default App"),
      ),
      el("div.research-view", view)));
  }
}
