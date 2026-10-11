// Compile: turns the manuscript into one finished document.
//
// Works on a list of blocks
//   { tag: "p" | "h1" | "h2" | "h3" | "quote" | "ul" | "ol" | "sep" | "title" | "byline" | "pagebreak",
//     runs: [{ text, b, i, u, s } | { br: true }] }
// which is built from the binder by assemble() and written out by toDocx(),
// toMarkdown(), toText() and toHtml(). Nothing here touches the DOM except
// htmlToBlocks(), which takes an element.

// ---------- reading the editor's HTML ----------

const BLOCK_TAGS = { P: "p", DIV: "p", H1: "h1", H2: "h2", H3: "h3", BLOCKQUOTE: "quote", HR: "sep" };

function runsOf(el, style, out) {
  for (const child of el.childNodes) {
    if (child.nodeType === 3) {
      if (child.nodeValue) out.push({ text: child.nodeValue, b: !!style.b, i: !!style.i, u: !!style.u, s: !!style.s });
    } else if (child.nodeType === 1) {
      const t = child.tagName;
      if (t === "BR") { out.push({ br: true }); continue; }
      const next = { ...style };
      if (t === "B" || t === "STRONG") next.b = true;
      if (t === "I" || t === "EM") next.i = true;
      if (t === "U") next.u = true;
      if (t === "S" || t === "STRIKE" || t === "DEL") next.s = true;
      runsOf(child, next, out);
    }
  }
  return out;
}

// Merges neighbouring runs with the same style and drops a trailing <br>.
function tidyRuns(runs) {
  const out = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && !r.br && !last.br && last.b === r.b && last.i === r.i && last.u === r.u && last.s === r.s) last.text += r.text;
    else out.push({ ...r });
  }
  while (out.length && out[out.length - 1].br) out.pop();
  return out;
}

export function htmlToBlocks(root) {
  const blocks = [];
  const loose = [];
  const flushLoose = () => {
    if (loose.length) {
      const runs = tidyRuns(loose.splice(0));
      if (runs.some((r) => r.br || r.text.trim())) blocks.push({ tag: "p", runs });
    }
  };
  for (const child of root.childNodes) {
    if (child.nodeType === 3) {
      if (child.nodeValue.trim()) loose.push({ text: child.nodeValue });
      continue;
    }
    if (child.nodeType !== 1) continue;
    const t = child.tagName;
    if (t === "UL" || t === "OL") {
      flushLoose();
      for (const li of child.children) blocks.push({ tag: t === "UL" ? "ul" : "ol", runs: tidyRuns(runsOf(li, {}, [])) });
    } else if (t === "HR") {
      flushLoose();
      blocks.push({ tag: "sep", runs: [] });
    } else if (BLOCK_TAGS[t]) {
      flushLoose();
      if (t === "BLOCKQUOTE" && [...child.children].some((c) => c.tagName === "P")) {
        for (const p of child.children) blocks.push({ tag: "quote", runs: tidyRuns(runsOf(p, {}, [])) });
      } else {
        blocks.push({ tag: BLOCK_TAGS[t], runs: tidyRuns(runsOf(child, {}, [])) });
      }
    } else {
      loose.push(...runsOf({ childNodes: [child] }, {}, []));
    }
  }
  flushLoose();
  // An empty paragraph is spacing in the editor, not content.
  return blocks.filter((b) => b.tag === "sep" || b.runs.some((r) => r.br || (r.text && r.text.trim())));
}

export function blocksText(blocks) {
  return blocks.map((b) => b.runs.map((r) => (r.br ? "\n" : r.text)).join("")).join("\n\n");
}

// ---------- gathering the manuscript ----------

// Walks the Draft folder in binder order and returns the blocks to compile.
// docs maps a document id to its blocks.
export function assemble(draft, docs, opts, meta) {
  const blocks = [];
  const o = Object.assign({ titlePage: true, folderTitles: true, textTitles: false, separator: "#", chapterBreaks: true }, opts);
  if (o.titlePage && meta && meta.title) {
    blocks.push({ tag: "title", runs: [{ text: meta.title }] });
    if (meta.author) blocks.push({ tag: "byline", runs: [{ text: meta.author }] });
    blocks.push({ tag: "pagebreak", runs: [] });
  }
  let lastWasText = false;
  let firstChapter = true;
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      if (!n.include || n.type === "file") continue;
      const isContainer = n.type === "folder";
      if (isContainer) {
        if (depth === 0 && o.chapterBreaks && !firstChapter && blocks.length && blocks[blocks.length - 1].tag !== "pagebreak") {
          blocks.push({ tag: "pagebreak", runs: [] });
        }
        if (depth === 0) firstChapter = false;
        if (o.folderTitles) blocks.push({ tag: depth === 0 ? "h1" : "h2", runs: [{ text: n.title }] });
        lastWasText = false;
      } else {
        const body = docs[n.id] || [];
        if (lastWasText && o.separator && !o.textTitles) {
          blocks.push(o.separator === "blank" ? { tag: "p", runs: [{ br: true }] } : { tag: "sep", runs: [] });
        }
        if (o.textTitles) blocks.push({ tag: depth === 0 ? "h1" : depth === 1 ? "h2" : "h3", runs: [{ text: n.title }] });
        blocks.push(...body);
        lastWasText = body.length > 0 || lastWasText;
      }
      if (n.children && n.children.length) walk(n.children, depth + 1);
      if (isContainer) lastWasText = false;
    }
  };
  walk(draft.children || [], 0);
  return { blocks, separator: o.separator && o.separator !== "blank" ? o.separator : "#" };
}

// ---------- Word (.docx) ----------
// A .docx is a zip of a few XML files. This writes the smallest set that Word,
// Pages, Google Docs and LibreOffice all accept, stored without compression.

const xmlEscape = (s) => String(s)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function docxRuns(runs) {
  return runs.map((r) => {
    if (r.br) return "<w:r><w:br/></w:r>";
    if (r.tab) return "<w:r><w:tab/></w:r>";
    if (!r.text) return "";
    const props = (r.b ? "<w:b/>" : "") + (r.i ? "<w:i/>" : "") + (r.s ? "<w:strike/>" : "") + (r.u ? '<w:u w:val="single"/>' : "");
    return "<w:r>" + (props ? "<w:rPr>" + props + "</w:rPr>" : "") +
      '<w:t xml:space="preserve">' + xmlEscape(r.text.replace(/\t/g, " ")) + "</w:t></w:r>";
  }).join("");
}

const DOCX_STYLE = { h1: "Heading1", h2: "Heading2", h3: "Heading3", quote: "Quote", title: "Title", byline: "Subtitle", sep: "Separator", ul: "ListBullet", ol: "ListNumber" };

function documentXml(blocks, separator) {
  let n = 0;
  const body = blocks.map((b) => {
    if (b.tag === "pagebreak") return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    if (b.tag !== "ol") n = 0;
    const style = DOCX_STYLE[b.tag];
    const ppr = style ? '<w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>' : "";
    let runs = b.runs;
    if (b.tag === "sep") runs = [{ text: separator }];
    if (b.tag === "ul") runs = [{ text: "•" }, { tab: true }, ...runs];
    if (b.tag === "ol") runs = [{ text: ++n + "." }, { tab: true }, ...runs];
    return "<w:p>" + ppr + docxRuns(runs) + "</w:p>";
  }).join("");
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    body +
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' +
    "</w:body></w:document>";
}

function stylesXml(font) {
  const f = xmlEscape(font || "Georgia");
  const para = (id, name, ppr, rpr) =>
    '<w:style w:type="paragraph" w:styleId="' + id + '"><w:name w:val="' + name + '"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    "<w:pPr>" + ppr + "</w:pPr><w:rPr>" + rpr + "</w:rPr></w:style>";
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="' + f + '" w:hAnsi="' + f + '" w:eastAsia="' + f + '" w:cs="' + f + '"/>' +
    '<w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="480" w:lineRule="auto"/><w:ind w:firstLine="720"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    para("Heading1", "heading 1", '<w:keepNext/><w:pageBreakBefore w:val="0"/><w:spacing w:before="1440" w:after="480"/><w:ind w:firstLine="0"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/>', '<w:sz w:val="32"/><w:szCs w:val="32"/>') +
    para("Heading2", "heading 2", '<w:keepNext/><w:spacing w:before="480" w:after="240"/><w:ind w:firstLine="0"/><w:jc w:val="center"/><w:outlineLvl w:val="1"/>', '<w:sz w:val="28"/><w:szCs w:val="28"/>') +
    para("Heading3", "heading 3", '<w:keepNext/><w:spacing w:before="240" w:after="120"/><w:ind w:firstLine="0"/><w:outlineLvl w:val="2"/>', "<w:b/><w:bCs/>") +
    para("Quote", "Quote", '<w:ind w:left="720" w:right="720" w:firstLine="0"/>', "") +
    para("Title", "Title", '<w:spacing w:before="4320" w:after="240"/><w:ind w:firstLine="0"/><w:jc w:val="center"/>', '<w:sz w:val="48"/><w:szCs w:val="48"/>') +
    para("Subtitle", "Subtitle", '<w:ind w:firstLine="0"/><w:jc w:val="center"/>', '<w:sz w:val="28"/><w:szCs w:val="28"/>') +
    para("Separator", "Scene Separator", '<w:ind w:firstLine="0"/><w:jc w:val="center"/>', "") +
    para("ListBullet", "List Bullet", '<w:ind w:left="720" w:hanging="360" w:firstLine="0"/>', "") +
    para("ListNumber", "List Number", '<w:ind w:left="720" w:hanging="360" w:firstLine="0"/>', "") +
    "</w:styles>";
}

const CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  "</Types>";

const ROOT_RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  "</Relationships>";

const DOC_RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  "</Relationships>";

function coreXml(meta) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    "<dc:title>" + xmlEscape(meta.title || "") + "</dc:title><dc:creator>" + xmlEscape(meta.author || "") + "</dc:creator>" +
    "</cp:coreProperties>";
}

let crcTable = null;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Builds an uncompressed zip from [{ name, data: Uint8Array }].
export function zip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    locals.push(new Uint8Array(local.buffer), name, f.data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(12, dosTime, true);
    central.setUint16(14, dosDate, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + size;
  }
  const centralSize = centrals.reduce((s, a) => s + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((s, a) => s + a.length, 0));
  let at = 0;
  for (const a of parts) { out.set(a, at); at += a.length; }
  return out;
}

export function toDocx(blocks, meta = {}, separator = "#") {
  const enc = new TextEncoder();
  return zip([
    { name: "[Content_Types].xml", data: enc.encode(CONTENT_TYPES_XML) },
    { name: "_rels/.rels", data: enc.encode(ROOT_RELS_XML) },
    { name: "docProps/core.xml", data: enc.encode(coreXml(meta)) },
    { name: "word/document.xml", data: enc.encode(documentXml(blocks, separator)) },
    { name: "word/_rels/document.xml.rels", data: enc.encode(DOC_RELS_XML) },
    { name: "word/styles.xml", data: enc.encode(stylesXml(meta.font)) },
  ]);
}

// ---------- Markdown ----------

const mdEscape = (s) => s.replace(/([\\`*_[\]<>])/g, "\\$1");

function mdRuns(runs) {
  return runs.map((r) => {
    if (r.br) return "\\\n";
    if (!r.text) return "";
    // Keep spaces outside the markers, where Markdown expects them.
    const m = r.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!m[2]) return r.text;
    let s = mdEscape(m[2]);
    if (r.s) s = "~~" + s + "~~";
    if (r.b) s = "**" + s + "**";
    if (r.i) s = "*" + s + "*";
    return m[1] + s + m[3];
  }).join("");
}

export function toMarkdown(blocks, separator = "#") {
  let n = 0;
  const parts = [];
  for (const b of blocks) {
    if (b.tag !== "ol") n = 0;
    const line = mdRuns(b.runs).replace(/\t/g, " ");
    switch (b.tag) {
      case "title": parts.push("# " + line.trim()); break;
      case "byline": parts.push("*" + line.trim() + "*"); break;
      case "pagebreak": break;
      case "h1": parts.push("# " + line.trim()); break;
      case "h2": parts.push("## " + line.trim()); break;
      case "h3": parts.push("### " + line.trim()); break;
      case "quote": parts.push("> " + line.replace(/\n/g, "\n> ")); break;
      case "ul": parts.push("- " + line); break;
      case "ol": parts.push(++n + ". " + line); break;
      case "sep": parts.push(separator === "#" ? "\\#" : mdEscape(separator)); break;
      default:
        // A paragraph that starts like a list, heading or quote stays a paragraph.
        parts.push(line.replace(/[ \t]+$/, "")
          .replace(/^(\s*)(#{1,6}\s|>|[-+*]\s)/, (all, sp, mark) => sp + "\\" + mark)
          .replace(/^(\s*\d+)([.)]\s)/, "$1\\$2"));
    }
  }
  // List items sit on consecutive lines; everything else is separated by a blank line.
  let out = "";
  parts.forEach((p, i) => {
    if (i === 0) { out = p; return; }
    const prevList = /^(- |\d+\. )/.test(parts[i - 1]);
    const thisList = /^(- |\d+\. )/.test(p);
    out += (prevList && thisList ? "\n" : "\n\n") + p;
  });
  return out.trim() + "\n";
}

// ---------- plain text ----------

export function toText(blocks, separator = "#") {
  let n = 0;
  return blocks.map((b) => {
    if (b.tag !== "ol") n = 0;
    if (b.tag === "pagebreak") return null;
    if (b.tag === "sep") return separator;
    let s = b.runs.map((r) => (r.br ? "\n" : r.text || "")).join("").replace(/\t/g, " ");
    if (b.tag === "ul") s = "• " + s;
    if (b.tag === "ol") s = ++n + ". " + s;
    if (b.tag === "h1" || b.tag === "title") s = s.toUpperCase();
    return s;
  }).filter((s) => s !== null).join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// ---------- HTML (also the source for PDF) ----------

const htmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function htmlRuns(runs) {
  return runs.map((r) => {
    if (r.br) return "<br>";
    let s = htmlEscape(r.text || "");
    if (r.u) s = "<u>" + s + "</u>";
    if (r.s) s = "<s>" + s + "</s>";
    if (r.i) s = "<em>" + s + "</em>";
    if (r.b) s = "<strong>" + s + "</strong>";
    return s;
  }).join("");
}

export function toHtml(blocks, meta = {}, separator = "#") {
  const out = [];
  let list = null;
  for (const b of blocks) {
    const want = b.tag === "ul" || b.tag === "ol" ? b.tag : null;
    if (list && list !== want) { out.push("</" + list + ">"); list = null; }
    if (want && !list) { out.push("<" + want + ">"); list = want; }
    const r = htmlRuns(b.runs);
    switch (b.tag) {
      case "title": out.push('<h1 class="title">' + r + "</h1>"); break;
      case "byline": out.push('<p class="byline">' + r + "</p>"); break;
      case "pagebreak": out.push('<div class="pagebreak"></div>'); break;
      case "h1": case "h2": case "h3": out.push("<" + b.tag + ">" + r + "</" + b.tag + ">"); break;
      case "quote": out.push("<blockquote><p>" + r + "</p></blockquote>"); break;
      case "ul": case "ol": out.push("<li>" + r + "</li>"); break;
      case "sep": out.push('<p class="sep">' + htmlEscape(separator) + "</p>"); break;
      default: out.push("<p>" + r + "</p>");
    }
  }
  if (list) out.push("</" + list + ">");
  const font = htmlEscape(meta.font || "Georgia");
  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    "<title>" + htmlEscape(meta.title || "Manuscript") + "</title>\n" +
    "<style>\n" +
    "  body { font-family: \"" + font + "\", Georgia, serif; font-size: 12pt; line-height: 1.8; max-width: 38em; margin: 3em auto; padding: 0 1em; color: #111; background: #fff; }\n" +
    "  p { margin: 0; text-indent: 2em; }\n" +
    "  h1, h2, h3, .sep, h1 + p, h2 + p, h3 + p, .sep + p, blockquote p { text-indent: 0; }\n" +
    "  h1 { font-size: 1.5em; font-weight: normal; text-align: center; margin: 3em 0 1.5em; }\n" +
    "  h2 { font-size: 1.25em; font-weight: normal; text-align: center; margin: 2em 0 1em; }\n" +
    "  h3 { font-size: 1em; margin: 1.5em 0 .5em; }\n" +
    "  h1.title { font-size: 2.2em; margin-top: 30vh; }\n" +
    "  .byline { text-align: center; text-indent: 0; font-size: 1.2em; }\n" +
    "  .sep { text-align: center; margin: 1em 0; }\n" +
    "  blockquote { margin: 1em 2em; }\n" +
    "  .pagebreak { break-after: page; height: 0; }\n" +
    "  @media screen { .pagebreak { border-top: 1px solid #ddd; margin: 4em 0; } }\n" +
    "</style>\n</head>\n<body>\n" + out.join("\n") + "\n</body>\n</html>\n";
}

// ---------- counting ----------

export function countWords(text) {
  const m = String(text).match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+|[.,]\p{N}+)*/gu);
  return m ? m.length : 0;
}
