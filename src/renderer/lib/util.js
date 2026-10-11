// Small helpers shared by the page's modules.
import { countWords } from "./compile.js";

export { countWords };

// Builds an element: el("div.card.big", { title: "x", onclick }, child, "text", ...)
export function el(spec, attrs, ...children) {
  const [tag, ...classes] = spec.split(".");
  const node = document.createElement(tag || "div");
  if (classes.length) node.className = classes.join(" ");
  if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "style" && typeof v === "object") {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith("--")) node.style.setProperty(prop, val);
        else node.style[prop] = val;
      }
    }
    else if (k in node && typeof v !== "string") node[k] = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function newId() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
  d.flush = () => { if (t) { clearTimeout(t); t = null; fn(); } };
  return d;
}

export const fmt = (n) => Number(n || 0).toLocaleString();

export function todayKey(d = new Date()) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

export function when(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) + ", " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// ---------- the editor's HTML ----------
// Documents are stored as a small, fixed set of tags. Anything else, from a
// paste or a hand-edited file, is reduced to these.

const KEEP_BLOCK = new Set(["P", "H1", "H2", "H3", "BLOCKQUOTE", "UL", "OL", "LI", "HR"]);
const KEEP_INLINE = { B: "strong", STRONG: "strong", I: "em", EM: "em", U: "u", S: "s", STRIKE: "s", DEL: "s", BR: "br" };
const BLOCKISH = new Set(["DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "ASIDE", "MAIN", "NAV", "H4", "H5", "H6", "PRE", "TABLE", "TR", "FIGURE", "FIGCAPTION", "DL", "DT", "DD", "ADDRESS"]);
const DROP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "NOSCRIPT", "SVG", "MATH", "HEAD", "TITLE", "META", "LINK", "IMG", "VIDEO", "AUDIO", "CANVAS", "BUTTON", "INPUT", "SELECT", "TEXTAREA"]);

function cleanInto(src, dest) {
  for (const n of src.childNodes) {
    if (n.nodeType === 3) {
      dest.append(n.nodeValue.replace(/ /g, " ").replace(/[\r\n]+/g, " "));
      continue;
    }
    if (n.nodeType !== 1) continue;
    const t = n.tagName;
    if (DROP.has(t)) continue;
    if (KEEP_INLINE[t]) {
      const k = document.createElement(KEEP_INLINE[t]);
      if (t !== "BR") cleanInto(n, k);
      dest.append(k);
    } else if (KEEP_BLOCK.has(t)) {
      const k = document.createElement(t.toLowerCase());
      cleanInto(n, k);
      dest.append(k);
    } else if (BLOCKISH.has(t)) {
      const k = document.createElement(t === "H4" || t === "H5" || t === "H6" ? "h3" : "p");
      cleanInto(n, k);
      dest.append(k);
    } else {
      // A <span> from Word or Google Docs carries bold and italic in its style.
      const st = n.getAttribute("style") || "";
      let target = dest;
      const wrap = (tag) => { const w = document.createElement(tag); target.append(w); target = w; };
      if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(st)) wrap("strong");
      if (/font-style\s*:\s*italic/i.test(st)) wrap("em");
      if (/text-decoration[^;]*underline/i.test(st)) wrap("u");
      cleanInto(n, target);
    }
  }
}

// Inline content sitting directly in the document goes into paragraphs, and
// blocks nested inside paragraphs are lifted out.
function normalise(root) {
  const out = document.createElement("div");
  let para = null;
  const isBlock = (n) => n.nodeType === 1 && (KEEP_BLOCK.has(n.tagName));
  const pushInline = (n) => {
    if (!para) { para = document.createElement("p"); out.append(para); }
    para.append(n);
  };
  const flatten = (container) => {
    for (const n of [...container.childNodes]) {
      if (isBlock(n)) {
        para = null;
        if ((n.tagName === "P" || /^H\d$/.test(n.tagName)) && [...n.children].some(isBlock)) {
          const shell = n.tagName;
          let cur = document.createElement(shell);
          for (const c of [...n.childNodes]) {
            if (isBlock(c)) {
              if (cur.childNodes.length) out.append(cur);
              out.append(c);
              cur = document.createElement(shell);
            } else cur.append(c);
          }
          if (cur.childNodes.length) out.append(cur);
        } else if (n.tagName === "LI") {
          const ul = document.createElement("ul");
          ul.append(n);
          out.append(ul);
        } else {
          out.append(n);
        }
      } else if (n.nodeType === 3 && !n.nodeValue.trim() && !para) {
        continue;
      } else {
        pushInline(n);
      }
    }
  };
  flatten(root);
  // Lists hold only list items.
  for (const list of out.querySelectorAll("ul, ol")) {
    for (const c of [...list.childNodes]) {
      if (c.nodeType === 1 && c.tagName === "LI") continue;
      if (c.nodeType === 3 && !c.nodeValue.trim()) { c.remove(); continue; }
      const li = document.createElement("li");
      list.replaceChild(li, c);
      li.append(c);
    }
  }
  return out;
}

export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString("<body>" + String(html || ""), "text/html");
  const tmp = document.createElement("div");
  cleanInto(doc.body, tmp);
  const out = normalise(tmp);
  // Drop wrappers that ended up empty, except paragraphs (blank lines) and rules.
  for (const e of out.querySelectorAll("strong, em, u, s")) if (!e.textContent && !e.querySelector("br")) e.remove();
  return out.innerHTML;
}

export function plainToHtml(text) {
  return String(text).replace(/\r\n?/g, "\n").split(/\n{2,}|\n/).map((line) =>
    "<p>" + line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</p>").join("");
}

// A little Markdown: headings, quotes, lists, rules, bold and italic.
export function markdownToHtml(text) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (m, a, b) => "<strong>" + (a || b) + "</strong>")
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)|(^|[^_\w])_(?!\s)(.+?)_(?!\w)/g, (m, p1, a, p2, b) => (p1 || p2 || "") + "<em>" + (a || b) + "</em>")
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
    .replace(/\\([\\`*_[\]<>#])/g, "$1");
  const out = [];
  let list = null;
  let para = [];
  const endPara = () => { if (para.length) { out.push("<p>" + inline(para.join(" ")) + "</p>"); para = []; } };
  const endList = () => { if (list) { out.push("</" + list + ">"); list = null; } };
  for (const raw of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { endPara(); endList(); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { endPara(); endList(); const l = Math.min(m[1].length, 3); out.push("<h" + l + ">" + inline(m[2]) + "</h" + l + ">"); continue; }
    if (/^\s*([-*_#]\s*){3,}$/.test(line) || /^\s*\\?#\s*$/.test(line)) { endPara(); endList(); out.push("<hr>"); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { endPara(); endList(); out.push("<blockquote>" + inline(m[1]) + "</blockquote>"); continue; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { endPara(); if (list !== "ul") { endList(); out.push("<ul>"); list = "ul"; } out.push("<li>" + inline(m[1]) + "</li>"); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { endPara(); if (list !== "ol") { endList(); out.push("<ol>"); list = "ol"; } out.push("<li>" + inline(m[1]) + "</li>"); continue; }
    endList();
    para.push(line.trim());
  }
  endPara();
  endList();
  return out.join("");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", mdash: "—", ndash: "–", hellip: "…" };

// Text of stored HTML, with a break between blocks, without a DOM.
export function htmlToText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h\d|li|blockquote|div)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] || m;
    });
}

// ---------- comparing versions ----------

function lcsPairs(a, b) {
  // Longest common subsequence of two token lists, as matched index pairs.
  const n = a.length, m = b.length;
  if (n * m > 4e6) return null;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const pairs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) i++;
    else j++;
  }
  return pairs;
}

// Returns [{ op: "same" | "del" | "add", text }] from old to new.
export function diffTokens(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const out = [];
  const push = (op, text) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ op, text });
  };
  for (let k = 0; k < start; k++) push("same", a[k]);
  const ma = a.slice(start, endA), mb = b.slice(start, endB);
  const pairs = lcsPairs(ma, mb);
  if (!pairs) {
    for (const t of ma) push("del", t);
    for (const t of mb) push("add", t);
  } else {
    let i = 0, j = 0;
    for (const [pi, pj] of [...pairs, [ma.length, mb.length]]) {
      while (i < pi) push("del", ma[i++]);
      while (j < pj) push("add", mb[j++]);
      if (pi < ma.length) push("same", ma[pi]);
      i = pi + 1; j = pj + 1;
    }
  }
  for (let k = endA; k < a.length; k++) push("same", a[k]);
  return out;
}

export const wordTokens = (s) => s.match(/\s+|[^\s]+/g) || [];
