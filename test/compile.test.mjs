import test from "node:test";
import assert from "node:assert";
import { assemble, toDocx, toMarkdown, toText, toHtml, countWords, crc32 } from "../src/renderer/lib/compile.js";

const p = (text, style = {}) => ({ tag: "p", runs: [{ text, ...style }] });

const draft = {
  children: [
    { id: "c1", type: "folder", title: "Chapter One", include: true, children: [
      { id: "s1", type: "text", title: "Scene 1", include: true, children: [] },
      { id: "s2", type: "text", title: "Scene 2", include: true, children: [] },
      { id: "s3", type: "text", title: "Cut scene", include: false, children: [] },
    ] },
    { id: "c2", type: "folder", title: "Chapter Two", include: true, children: [
      { id: "s4", type: "text", title: "Scene 4", include: true, children: [] },
    ] },
  ],
};
const docs = {
  s1: [p("It was a dark night.")],
  s2: [p("Then "), { tag: "p", runs: [{ text: "morning", i: true }, { text: " came." }] }],
  s3: [p("Never seen.")],
  s4: [p("The end.")],
};

test("assembles chapters, scene breaks and the title page in binder order", () => {
  const { blocks } = assemble(draft, docs, { separator: "#" }, { title: "Book", author: "Me" });
  const tags = blocks.map((b) => b.tag);
  assert.deepStrictEqual(tags, ["title", "byline", "pagebreak", "h1", "p", "sep", "p", "p", "pagebreak", "h1", "p"]);
  assert.ok(!JSON.stringify(blocks).includes("Never seen"), "excluded documents stay out");
});

test("text titles replace scene breaks and can turn off chapter breaks", () => {
  const { blocks } = assemble(draft, docs, { titlePage: false, textTitles: true, chapterBreaks: false }, {});
  assert.deepStrictEqual(blocks.map((b) => b.tag), ["h1", "h2", "p", "h2", "p", "p", "h1", "h2", "p"]);
});

test("writes Markdown, plain text and HTML", () => {
  const { blocks, separator } = assemble(draft, docs, { titlePage: false, separator: "* * *" }, {});
  const md = toMarkdown(blocks, separator);
  assert.match(md, /^# Chapter One\n\nIt was a dark night\.\n\n\\\* \\\* \\\*\n\nThen\n\n\*morning\* came\./);
  const txt = toText(blocks, separator);
  assert.match(txt, /^CHAPTER ONE\n\nIt was a dark night\.\n\n\* \* \*\n\n/);
  const html = toHtml(blocks, { title: "T & U" }, separator);
  assert.match(html, /<title>T &amp; U<\/title>/);
  assert.match(html, /<p><em>morning<\/em> came\.<\/p>/);
  assert.match(html, /<div class="pagebreak"><\/div>/);
});

test("Markdown keeps lists together and escapes paragraphs that look like syntax", () => {
  const blocks = [
    { tag: "ul", runs: [{ text: "one" }] }, { tag: "ul", runs: [{ text: "two" }] },
    { tag: "ol", runs: [{ text: "a" }] }, { tag: "ol", runs: [{ text: "b" }] },
    p("# not a heading"), p("1. not a list"),
  ];
  assert.strictEqual(toMarkdown(blocks), "- one\n- two\n1. a\n2. b\n\n\\# not a heading\n\n1\\. not a list\n");
});

test("writes a .docx that is a valid zip with the expected parts", () => {
  const { blocks } = assemble(draft, docs, {}, { title: "Book", author: "Me" });
  const bytes = toDocx(blocks, { title: "Book", author: "Me", font: "Garamond" });
  const text = new TextDecoder("latin1").decode(bytes);
  for (const part of ["[Content_Types].xml", "word/document.xml", "word/styles.xml", "docProps/core.xml"]) assert.ok(text.includes(part), part);
  assert.ok(text.includes('w:pStyle w:val="Heading1"'));
  assert.ok(text.includes('<w:br w:type="page"/>'));
  assert.ok(text.includes("Garamond"));
  assert.ok(text.includes("<w:i/>"));
  // End of central directory record says how many files there are.
  const view = new DataView(bytes.buffer);
  const end = bytes.length - 22;
  assert.strictEqual(view.getUint32(end, true), 0x06054b50);
  assert.strictEqual(view.getUint16(end + 10, true), 6);
});

test("counts words the way writers expect", () => {
  assert.strictEqual(countWords("It's a well-known fact — isn't it? 1,000 times."), 7 + 1);
  assert.strictEqual(countWords(""), 0);
  assert.strictEqual(countWords("café naïve"), 2);
});

test("crc32 matches the standard check value", () => {
  assert.strictEqual(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});
