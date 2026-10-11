// End-to-end test: drives the real app through a writing session.
// Run with `npm run test:e2e` (on Linux without a display: `xvfb-run -a npm run test:e2e`).
// Pass a folder as the first argument to also save screenshots there.
"use strict";

const { _electron: electron } = require("playwright-core");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs/promises");
const os = require("os");
const project = require("../../src/main/project");

const ROOT = path.join(__dirname, "../..");
const shots = process.argv[2] || null;
// QUIRE_ELECTRON runs the test on another Electron, such as the one for older Macs.
const executablePath = process.env.QUIRE_ELECTRON || undefined;
let step = 0;

async function launch(dir, base) {
  const app = await electron.launch({
    executablePath,
    args: [ROOT, dir, "--no-sandbox"],
    env: { ...process.env, QUIRE_USER_DATA: path.join(base, "userdata") },
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  win.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 860));
  await win.waitForSelector(".editable");
  return { app, win, errors };
}

// Native dialogs can't be clicked, so they answer from here.
async function answerDialogs(app, { save, open } = {}) {
  await app.evaluate(({ dialog }, { save, open }) => {
    dialog.showSaveDialog = async () => ({ canceled: !save, filePath: save });
    dialog.showOpenDialog = async () => ({ canceled: !open, filePaths: open || [] });
    dialog.showMessageBox = async () => ({ response: 0 });
  }, { save: save || null, open: open || null });
}

async function shot(win, name) {
  if (!shots) return;
  await win.waitForTimeout(150);
  await win.screenshot({ path: path.join(shots, String(++step).padStart(2, "0") + "-" + name + ".png") });
}

const menu = (app, cmd) => app.evaluate(({ BrowserWindow }, cmd) => BrowserWindow.getAllWindows()[0].webContents.send("menu", cmd), cmd);
// Edits reach the store after a short pause and the disk after another.
const saved = async (win) => {
  await win.waitForTimeout(350);
  await win.waitForFunction(() => document.querySelector("#st-save").textContent === "Saved");
};

async function rowFor(win, title) {
  return win.locator(".binder-tree .row", { has: win.locator(".title", { hasText: new RegExp("^" + title + "$") }) }).first();
}

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "quire-e2e-"));
  const { dir, data } = await project.create(path.join(base, "The Lighthouse"), "The Lighthouse", "Ada Writer", "novel");
  const ch1 = data.binder[0].children[0];
  const scene1 = ch1.children[0];

  let { app, win, errors } = await launch(dir, base);

  // ---- writing in a scene ----
  await (await rowFor(win, "Chapter One")).click();
  await win.locator('.binder-tree .row[data-id="' + ch1.id + '"] .twisty').click();
  await (await rowFor(win, "Scene One")).click();
  const ed = win.locator('.editable[data-id="' + scene1.id + '"]');
  await ed.click();
  await win.keyboard.type("The lamp had not been lit for eleven years.");
  await win.keyboard.press("Enter");
  await win.keyboard.type("Mara climbed the stairs anyway.");
  await saved(win);
  const onDisk = await fs.readFile(path.join(dir, "docs", scene1.id + ".html"), "utf8");
  assert.match(onDisk, /<p>The lamp had not been lit for eleven years\.<\/p><p>Mara climbed the stairs anyway\.<\/p>/);
  assert.match(await win.locator("#st-doc").textContent(), /Words\s*14/);
  assert.match(await win.locator("#st-session").textContent(), /Session\s*14/);

  // ---- bold via the menu command ----
  await win.keyboard.down("Shift");
  for (let i = 0; i < 7; i++) await win.keyboard.press("ArrowLeft");
  await win.keyboard.up("Shift");
  await menu(app, "italic");
  await saved(win);
  assert.match(await fs.readFile(path.join(dir, "docs", scene1.id + ".html"), "utf8"), /<em>anyway\.<\/em>/);
  await shot(win, "editor");

  // ---- inspector: synopsis, label, status, notes ----
  await win.fill(".insp-synopsis", "Mara returns to the lighthouse.");
  await win.selectOption("#insp-label", { label: "Blue" });
  await win.selectOption("#insp-status", { label: "First Draft" });
  await win.fill(".insp-notes", "Remember: the keeper's log is missing.");
  await win.locator(".insp-notes").blur();
  await saved(win);
  const saved1 = JSON.parse(await fs.readFile(path.join(dir, "project.json"), "utf8"));
  const s1 = saved1.binder[0].children[0].children[0];
  assert.strictEqual(s1.synopsis, "Mara returns to the lighthouse.");
  assert.strictEqual(s1.label, "l-blue");
  assert.strictEqual(s1.status, "s-first");
  assert.strictEqual(await fs.readFile(path.join(dir, "notes", scene1.id + ".txt"), "utf8"), "Remember: the keeper's log is missing.");

  // ---- new text, renamed in place ----
  await menu(app, "new-text");
  await win.waitForSelector(".binder-tree input.rename");
  await win.fill(".binder-tree input.rename", "The Storm");
  await win.keyboard.press("Enter");
  await (await rowFor(win, "The Storm")).waitFor();
  const order = await win.locator(".binder-tree .row .title").allTextContents();
  assert.deepStrictEqual(order.slice(0, 5), ["Manuscript", "Chapter One", "Scene One", "The Storm", "Scene Two"]);
  await win.locator(".editable").first().click();
  await win.keyboard.type("Rain hammered the glass.");
  await saved(win);

  // ---- scrivenings: the chapter shows all its scenes together ----
  await (await rowFor(win, "Chapter One")).click();
  assert.strictEqual(await win.locator(".pane.active .sec").count(), 3);
  assert.match(await win.locator("#st-doc").textContent(), /Words\s*18/);

  // ---- corkboard ----
  await menu(app, "view-corkboard");
  await win.waitForSelector(".cork .card[data-id]");
  assert.strictEqual(await win.locator(".cork .card[data-id]").count(), 3);
  const firstCard = win.locator(".cork .card[data-id]").first();
  assert.strictEqual(await firstCard.locator(".card-synopsis").inputValue(), "Mara returns to the lighthouse.");
  assert.match(await firstCard.locator(".stamp").textContent(), /First Draft/);
  // Drag the last card to the front.
  const cards = win.locator(".cork .card[data-id]");
  const lastBox = await cards.nth(2).boundingBox();
  const firstBox = await cards.nth(0).boundingBox();
  await win.mouse.move(lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height - 10);
  await cards.nth(2).dragTo(cards.nth(0), { sourcePosition: { x: lastBox.width / 2, y: lastBox.height - 10 }, targetPosition: { x: 10, y: firstBox.height / 2 } });
  await win.waitForFunction(() => document.querySelector(".cork .card[data-id] .card-title").textContent === "Scene Two");
  await shot(win, "corkboard");

  // ---- outliner ----
  await menu(app, "view-outliner");
  await win.waitForSelector("table.outline tbody tr");
  assert.deepStrictEqual(await win.locator("table.outline tbody .cell-title .t").allTextContents(), ["Scene Two", "Scene One", "The Storm"]);
  await win.locator("table.outline tbody tr").nth(2).locator(".col-syn .s").click();
  await win.keyboard.type("The storm arrives.");
  await win.keyboard.press("Enter");
  await shot(win, "outliner");
  await menu(app, "view-editor");

  // ---- snapshot, edit, compare, restore ----
  await (await rowFor(win, "Scene One")).click();
  await menu(app, "snapshot");
  await win.waitForSelector(".toast:not([hidden])");
  const ed1 = win.locator('.editable[data-id="' + scene1.id + '"]');
  await ed1.click();
  await win.keyboard.press("End");
  await win.keyboard.press("Control+End");
  await win.keyboard.type(" She did not look down.");
  await saved(win);
  await win.click('.tabs button[data-tab="snapshots"]');
  await win.locator(".snap").first().click();
  await win.waitForSelector("#dlg-snapshot[open] .diff ins");
  assert.match(await win.locator(".diff ins").first().textContent(), /She did not look down\./);
  await shot(win, "snapshot-compare");
  await answerDialogs(app);
  await win.click(".snap-restore");
  await win.waitForFunction(() => !document.querySelector("#dlg-snapshot").open);
  assert.doesNotMatch(await ed1.textContent(), /look down/);
  const snaps = await project.listSnapshots(dir, scene1.id);
  assert.strictEqual(snaps.length, 2, "restoring keeps the current text as a snapshot first");

  // ---- project search ----
  await menu(app, "find");
  await win.keyboard.type("hammered");
  await win.waitForSelector(".results .row.result");
  assert.match(await win.locator(".results .row.result .title").first().textContent(), /The Storm/);
  await win.keyboard.press("Escape");

  // ---- targets ----
  await menu(app, "targets");
  await win.fill("#t-project", "80000");
  await win.fill("#t-session", "500");
  await win.click("#t-ok");
  await win.waitForFunction(() => /80,000/.test(document.querySelector("#st-draft").textContent));

  // ---- split editor ----
  await menu(app, "toggle-split");
  assert.strictEqual(await win.locator(".pane").count(), 2);
  await (await rowFor(win, "Character Sketch")).click().catch(async () => {
    const research = await rowFor(win, "Research");
    await research.locator(".twisty").click();
    const chars = await rowFor(win, "Characters");
    await chars.locator(".twisty").click();
    await (await rowFor(win, "Character Sketch")).click();
  });
  await win.waitForSelector('.pane[data-pane="b"] .editable');
  assert.match(await win.locator('.pane[data-pane="b"] .editable').textContent(), /Wants:/);
  await shot(win, "split");
  await menu(app, "toggle-split");

  // ---- composition mode ----
  await (await rowFor(win, "Scene One")).click();
  await menu(app, "composition");
  await win.waitForFunction(() => document.body.classList.contains("composing"));
  await shot(win, "composition");
  await win.keyboard.press("Escape");
  await win.waitForFunction(() => !document.body.classList.contains("composing"));

  // ---- research import ----
  const png = path.join(base, "lighthouse.png");
  await fs.writeFile(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  await answerDialogs(app, { open: [png] });
  await menu(app, "import-research");
  await win.waitForSelector(".research-img");
  assert.ok(await fs.stat(path.join(dir, "research", "lighthouse.png")));

  // ---- trash and empty trash ----
  await (await rowFor(win, "Scene Two")).click();
  const scene2Id = await win.locator(".binder-tree .row.selected").getAttribute("data-id");
  await menu(app, "trash");
  await win.waitForFunction(() => /Trash/.test(document.querySelector(".toast").textContent));
  await answerDialogs(app);
  await menu(app, "empty-trash");
  await win.waitForFunction((id) => !document.querySelector('.binder-tree .row[data-id="' + id + '"]'), scene2Id);
  await saved(win);
  await assert.rejects(fs.access(path.join(dir, "docs", scene2Id + ".html")));

  // ---- split at cursor ----
  await (await rowFor(win, "The Storm")).click();
  const storm = win.locator(".pane.active .editable").first();
  await storm.click();
  await win.keyboard.press("Control+End");
  await win.keyboard.press("Enter");
  await win.keyboard.type("Morning came grey and quiet.");
  await win.keyboard.press("Home");
  await menu(app, "split");
  await (await rowFor(win, "The Storm \\(2\\)")).waitFor();
  await saved(win);

  // ---- compile to every format ----
  const outputs = {};
  for (const fmtName of ["docx", "md", "txt", "html", "pdf"]) {
    const file = path.join(base, "out." + fmtName);
    await answerDialogs(app, { save: file });
    await menu(app, "compile");
    await win.waitForSelector("#dlg-compile[open]");
    await win.selectOption("#c-format", fmtName);
    await win.selectOption("#c-sep", "* * *");
    await win.click('#dlg-compile button[value="ok"]');
    await win.waitForFunction(() => /Compiled to/.test(document.querySelector(".toast").textContent));
    outputs[fmtName] = await fs.readFile(file);
    await win.evaluate(() => { document.querySelector(".toast").hidden = true; document.querySelector(".toast").textContent = ""; });
  }
  const md = outputs.md.toString("utf8");
  assert.match(md, /^# The Lighthouse\n\n\*Ada Writer\*\n\n# Chapter One\n\nThe lamp had not been lit for eleven years\.\n\nMara climbed the stairs \*anyway\.\*\n\n\\\* \\\* \\\*\n\nRain hammered the glass\.\n\n\\\* \\\* \\\*\n\nMorning came grey and quiet\.\n\n# Chapter Two\n/);
  assert.match(outputs.txt.toString("utf8"), /THE LIGHTHOUSE\n\nAda Writer\n\nCHAPTER ONE/);
  assert.strictEqual(outputs.docx.readUInt32LE(0), 0x04034b50);
  assert.strictEqual(outputs.pdf.subarray(0, 5).toString(), "%PDF-");
  assert.match(outputs.html.toString("utf8"), /<h1>Chapter One<\/h1>/);
  assert.doesNotMatch(md, /Wants:/, "research is never compiled");

  assert.deepStrictEqual(errors, []);
  await app.close();

  // ---- everything is still there after reopening ----
  ({ app, win, errors } = await launch(dir, base));
  await win.waitForSelector(".binder-tree .row");
  const titles = await win.locator(".binder-tree .row .title").allTextContents();
  for (const t of ["Scene One", "The Storm", "The Storm (2)", "lighthouse"]) assert.ok(titles.includes(t), t + " is in the binder");
  assert.match(await win.locator("#st-draft").textContent(), /80,000/);
  assert.deepStrictEqual(errors, []);

  // ---- dark theme, for a look ----
  await menu(app, "theme-dark");
  await (await rowFor(win, "Chapter One")).click();
  await menu(app, "view-corkboard");
  await shot(win, "corkboard-dark");
  await menu(app, "view-editor");
  await shot(win, "editor-dark");
  await menu(app, "theme-system");
  await app.close();

  // ---- the welcome screen ----
  const empty = await electron.launch({ executablePath, args: [ROOT, "--no-sandbox"], env: { ...process.env, QUIRE_USER_DATA: path.join(base, "userdata") } });
  const w2 = await empty.firstWindow();
  await empty.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 860));
  await w2.waitForSelector("#welcome:not([hidden]) .recent-item");
  assert.match(await w2.locator(".recent-name").first().textContent(), /The Lighthouse/);
  await shot(w2, "welcome");
  // Create a project from the welcome screen.
  await answerDialogs(empty, { save: path.join(base, "Second Book") });
  await w2.fill("#new-title", "Second Book");
  await w2.click('label.tpl:has(input[value="story"])');
  await w2.click("#new-form button[type=submit]");
  await w2.waitForSelector(".editable", { timeout: 10000 });
  assert.ok(project.isProject(path.join(base, "Second Book.quire")));
  await empty.close();

  console.log("All end-to-end checks passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
