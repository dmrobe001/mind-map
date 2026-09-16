/**
 * Drives the UI against a scripted stand-in for the native bridge.
 *
 * The real desktop app can only be exercised by running it; this covers the
 * other half — that the UI does the right thing with the answers the bridge
 * gives, including the cases that are awkward to stage for real (a root this
 * machine has not mapped, a file that exists on the other laptop).
 *
 * Not part of `node --test`: it needs Playwright, and the point of this
 * project is that nothing else does.
 *
 *   npm run serve &
 *   node tests/manual/tauri-bridge.mjs [screenshot.png]
 */

import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MINDMAP_URL ?? 'http://127.0.0.1:8000/index.html';
const shot = process.argv[2];

/* A small filesystem to answer questions about. */
const work = mkdtempSync(join(tmpdir(), 'mindmap-bridge-'));
const drive = join(work, 'CloudDrive');
mkdirSync(join(drive, 'notes'), { recursive: true });
writeFileSync(join(drive, 'notes', 'reading-list.md'), '# Reading\n');
writeFileSync(join(drive, 'notes', 'budget.csv'), 'a,b\n');
writeFileSync(join(drive, 'loose.txt'), 'x\n');

const MISSING = '/not/on/this/machine/plan.md';

let settings = {};

const opened = [];
const failures = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(`${label}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

/* The bridge. Real file answers, scripted dialogs, recorded side effects. */
await page.exposeBinding('__bridge', async (_source, command, args) => {
  const fs = await import('node:fs');
  switch (command) {
    case 'device_info':
      return { id: 'dev_test', name: 'test machine', os: 'linux', home: work, separator: '/' };
    case 'read_device_settings':
      return settings;
    case 'write_device_settings':
      settings = args.settings;
      return null;
    case 'read_text_file':
      return fs.readFileSync(args.path, 'utf8');
    case 'write_text_file':
      fs.writeFileSync(args.path, args.contents);
      return null;
    case 'paths_exist':
      return args.paths.map((p) => fs.existsSync(p));
    case 'list_dir':
      return fs.readdirSync(args.path, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: join(args.path, e.name), isDir: e.isDirectory(), size: 0, modified: 0 }))
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    case 'pick_files':
      return [join(drive, 'loose.txt')];
    case 'pick_directory':
      return join(drive, 'notes');
    case 'open_path':
      opened.push(args.path);
      return null;
    default:
      return null;
  }
});

await page.addInitScript(() => {
  window.__TAURI__ = { core: { invoke: (command, args) => window.__bridge(command, args ?? {}) } };
});

// Accept the "start a new map?" and "import N files?" confirmations.
page.on('dialog', (dialog) => dialog.accept());

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

check('the app reports native capabilities',
  await page.evaluate(() => window.mindmap.platform.id), 'tauri');
check('native-only toolbar buttons appear',
  await page.locator('#toolbar button:has-text("Roots…")').count(), 1);

/* Map the cloud-drive root exactly as a user would, through the dialog. */
await page.locator('#toolbar button:has-text("Roots…")').click();
await page.waitForTimeout(300);
await page.locator('#roots-dialog .root-row input[type="text"]').first().fill(drive);
await page.locator('#roots-dialog .root-row input[type="text"]').first().blur();
await page.waitForTimeout(400);
check('the root path is persisted per machine',
  await page.evaluate(() => window.mindmap.platform.settings.roots.sync), drive);
await page.locator('#roots-dialog button:has-text("Done")').click();
await page.waitForTimeout(300);

// Start from an empty map: the starter map ships its own placeholder file
// reference, which would otherwise show up in the counts below.
await page.evaluate(() => window.mindmap.newMap());
await page.waitForTimeout(400);

/* Build a node whose file reference lives in three different places. */
await page.evaluate(({ missing }) => {
  const app = window.mindmap;
  return import('/src/core/commands.js').then((m) => {
    const id = m.runCommand('node.add', app.store, { title: 'Reading list', x: 0, y: 0 });
    const blockId = m.runCommand('block.add', app.store, { nodeId: id, type: 'file' });
    m.runCommand('locator.add', app.store, {
      nodeId: id, blockId, locator: { root: 'sync', path: 'notes/reading-list.md' },
    });
    m.runCommand('locator.add', app.store, {
      nodeId: id, blockId, locator: { root: 'absolute', path: missing, deviceName: 'work laptop' },
    });
    m.runCommand('locator.add', app.store, {
      nodeId: id, blockId, locator: { root: 'archive', path: 'old/reading-list.md' },
    });
    app.view.selectNodes([id]);
    app.refreshFileIndex({ force: true });
  });
}, { missing: MISSING });
await page.waitForTimeout(900);

const dots = await page.locator('#right-panel .locator-dot').evaluateAll(
  (els) => els.map((el) => el.dataset.state),
);
check('each location shows the right status', dots, ['here', 'elsewhere', 'unknown']);

check('a resolvable file offers to open',
  await page.locator('#right-panel .locator:has(.locator-dot[data-state="here"]) button:has-text("open")').count(), 1);
check('a missing file offers no open button',
  await page.locator('#right-panel .locator:has(.locator-dot[data-state="elsewhere"]) button:has-text("open")').count(), 0);

await page.locator('#right-panel button:has-text("open")').first().click();
await page.waitForTimeout(400);
check('opening hands the resolved path to the system',
  opened, [join(drive, 'notes', 'reading-list.md')]);

// Two of the three locations resolve to a path at all; the third names a root
// this machine has never mapped, so there is nothing to check.
check('the status bar counts what is reachable here',
  /1 of 2 files here/.test(await page.locator('#status-bar').textContent()), true);

/* Picking a file inside a mapped root should record it portably. */
await page.locator('#right-panel .block button:has-text("edit")').first().click();
await page.waitForTimeout(300);
await page.locator('#right-panel button:has-text("pick a file…")').click();
await page.waitForTimeout(500);
check('a root the map does not declare stays selected rather than silently becoming absolute',
  await page.locator('#right-panel .locator-edit').nth(2).locator('select').inputValue(), 'archive');

check('a picked file inside a root is stored relative to it',
  await page.evaluate(() => {
    const node = Object.values(window.mindmap.store.doc.nodes).find((n) => n.title === 'Reading list');
    return node.content[0].meta.alternates.at(-1);
  }),
  { root: 'sync', path: 'loose.txt', device: null, deviceName: null });

/* Folder import. */
await page.locator('#toolbar button:has-text("Import folder…")').click();
await page.waitForTimeout(900);
check('importing a folder makes a node per file',
  await page.evaluate(() => Object.values(window.mindmap.store.doc.nodes)
    .filter((n) => n.fields?.source === 'folder-import').map((n) => n.title).sort()),
  ['budget.csv', 'reading-list.md']);

check('no console errors', errors, []);

if (shot) await page.screenshot({ path: shot });
await browser.close();

console.log(failures.length ? `\n${failures.length} failure(s):\n${failures.join('\n')}` : '\nall bridge checks passed');
process.exit(failures.length ? 1 : 0);
