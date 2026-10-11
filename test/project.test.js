"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const project = require("../src/main/project");

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "quire-test-"));
}

test("creates a novel project with its folders and starter documents", async () => {
  const base = await tmp();
  const { dir, data } = await project.create(path.join(base, "My Novel"), "My Novel", "A. Writer", "novel");
  assert.ok(dir.endsWith("My Novel.quire"));
  assert.ok(project.isProject(dir));
  assert.deepStrictEqual(data.binder.map((n) => n.role), ["draft", "research", "trash"]);
  const loaded = await project.load(dir);
  assert.strictEqual(loaded.title, "My Novel");
  assert.strictEqual(loaded.author, "A. Writer");
  const chars = loaded.binder[1].children.find((n) => n.title === "Characters");
  const sketch = chars.children[0];
  assert.match(await project.readDoc(dir, sketch.id), /Wants:/);
});

test("refuses to create over an existing folder", async () => {
  const base = await tmp();
  await project.create(path.join(base, "Same"), "Same", "", "blank");
  await assert.rejects(project.create(path.join(base, "Same"), "Same", "", "blank"), /already exists/);
});

test("reads and writes documents and notes, and missing ones read as empty", async () => {
  const base = await tmp();
  const { dir } = await project.create(path.join(base, "P"), "P", "", "blank");
  assert.strictEqual(await project.readDoc(dir, "abc123"), "");
  await project.writeDoc(dir, "abc123", "<p>Hello</p>");
  await project.writeNotes(dir, "abc123", "a note");
  assert.strictEqual(await project.readDoc(dir, "abc123"), "<p>Hello</p>");
  assert.strictEqual(await project.readNotes(dir, "abc123"), "a note");
  assert.deepStrictEqual(await project.readDocs(dir, ["abc123", "zzz"]), { abc123: "<p>Hello</p>", zzz: "" });
});

test("rejects ids and paths that reach outside the project", async () => {
  const base = await tmp();
  const { dir } = await project.create(path.join(base, "P"), "P", "", "blank");
  await assert.rejects(project.readDoc(dir, "../../etc/passwd"), /Bad document id/);
  await assert.rejects(project.writeDoc(dir, "a/b", "x"), /Bad document id/);
  assert.throws(() => project.researchPath(dir, "research/../../x"), /outside project/);
  assert.throws(() => project.researchPath(dir, "docs/x.html"), /Bad research path/);
  await assert.rejects(project.readSnapshot(dir, "abc", "../project.json"), /Bad snapshot name/);
});

test("takes, lists, reads and deletes snapshots", async () => {
  const base = await tmp();
  const { dir } = await project.create(path.join(base, "P"), "P", "", "blank");
  const a = await project.takeSnapshot(dir, "doc1", "First", "<p>one</p>");
  await new Promise((r) => setTimeout(r, 5));
  const b = await project.takeSnapshot(dir, "doc1", "", "<p>two</p>");
  const list = await project.listSnapshots(dir, "doc1");
  assert.deepStrictEqual(list.map((s) => s.file), [b.file, a.file]);
  assert.strictEqual(await project.readSnapshot(dir, "doc1", a.file), "<p>one</p>");
  await project.deleteSnapshot(dir, "doc1", a.file);
  assert.deepStrictEqual((await project.listSnapshots(dir, "doc1")).map((s) => s.name), [""]);
});

test("imports research files without overwriting, and purges trashed items", async () => {
  const base = await tmp();
  const { dir } = await project.create(path.join(base, "P"), "P", "", "blank");
  const src = path.join(base, "map.png");
  await fs.writeFile(src, "png");
  const [first] = await project.importResearch(dir, [src]);
  const [second] = await project.importResearch(dir, [src]);
  assert.deepStrictEqual(first, { file: "research/map.png", title: "map", mime: "image/png" });
  assert.strictEqual(second.file, "research/map 2.png");
  await project.writeDoc(dir, "gone1", "<p>x</p>");
  await project.takeSnapshot(dir, "gone1", "s", "<p>x</p>");
  await project.purge(dir, [{ id: "gone1", type: "text" }, { id: "f1", type: "file", file: first.file }]);
  assert.strictEqual(await project.readDoc(dir, "gone1"), "");
  await assert.rejects(fs.access(path.join(dir, "research", "map.png")));
  await assert.rejects(fs.access(path.join(dir, "snapshots", "gone1")));
});

test("saving writes the whole project atomically and stamps it", async () => {
  const base = await tmp();
  const { dir, data } = await project.create(path.join(base, "P"), "P", "", "story");
  data.title = "Changed";
  const before = data.modified;
  await new Promise((r) => setTimeout(r, 5));
  await project.save(dir, data);
  const again = await project.load(dir);
  assert.strictEqual(again.title, "Changed");
  assert.notStrictEqual(again.modified, before);
  const leftovers = (await fs.readdir(dir)).filter((f) => f.includes(".tmp-"));
  assert.deepStrictEqual(leftovers, []);
});
