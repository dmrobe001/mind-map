/**
 * Tests for portable file references.
 *
 * This is the part of the model that decides whether a link you recorded on
 * one machine means anything on another, so it is worth pinning down hard.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ABSOLUTE, createLocator, locatorsFor, resolveLocator, resolveBlock,
  bestLocatorForPath, describeLocator, collectLocators, joinPath, basename,
} from '../src/core/locators.js';
import { createDocument, createNode, createBlock } from '../src/core/model.js';
import { Store } from '../src/core/store.js';
import { runCommand } from '../src/core/commands.js';
import { selectNodes } from '../src/core/query.js';
import { GraphIndex } from '../src/core/graph.js';

const DEVICE_ROOTS = {
  sync: '/home/dan/Dropbox',
  nested: '/home/dan/Dropbox/projects',
};

/* ---- path helpers ---- */

test('joinPath does not double or drop separators', () => {
  assert.equal(joinPath('/a/b', 'c/d'), '/a/b/c/d');
  assert.equal(joinPath('/a/b/', '/c/d'), '/a/b/c/d');
  assert.equal(joinPath('', 'c/d'), 'c/d');
  assert.equal(joinPath('/a/b', ''), '/a/b');
  assert.equal(joinPath('C:\\Users\\dan', 'notes.md', '\\'), 'C:\\Users\\dan\\notes.md');
});

test('basename handles both separators', () => {
  assert.equal(basename('/a/b/c.md'), 'c.md');
  assert.equal(basename('C:\\a\\b\\c.md'), 'c.md');
  assert.equal(basename(''), '');
});

/* ---- resolution ---- */

test('an absolute locator resolves to itself', () => {
  const locator = createLocator({ root: ABSOLUTE, path: '/etc/hosts' });
  assert.equal(resolveLocator(locator, { deviceRoots: {} }), '/etc/hosts');
});

test('a rooted locator resolves through this machine\'s mapping', () => {
  const locator = createLocator({ root: 'sync', path: 'notes/today.md' });
  assert.equal(
    resolveLocator(locator, { deviceRoots: DEVICE_ROOTS }),
    '/home/dan/Dropbox/notes/today.md',
  );
});

test('a rooted locator is unresolvable where the root is unmapped', () => {
  const locator = createLocator({ root: 'sync', path: 'notes/today.md' });
  assert.equal(resolveLocator(locator, { deviceRoots: {} }), null);
});

test('the same locator resolves differently on two machines', () => {
  const locator = createLocator({ root: 'sync', path: 'notes.md' });
  assert.equal(
    resolveLocator(locator, { deviceRoots: { sync: '/home/dan/Dropbox' } }),
    '/home/dan/Dropbox/notes.md',
  );
  assert.equal(
    resolveLocator(locator, { deviceRoots: { sync: 'C:\\Users\\dan\\Dropbox' }, separator: '\\' }),
    'C:\\Users\\dan\\Dropbox\\notes.md',
  );
});

/* ---- choosing the most portable form ---- */

test('a path inside a root is recorded relative to it', () => {
  const locator = bestLocatorForPath('/home/dan/Dropbox/notes/today.md', { deviceRoots: DEVICE_ROOTS });
  assert.equal(locator.root, 'sync');
  assert.equal(locator.path, 'notes/today.md');
});

test('the deepest matching root wins', () => {
  // Both roots contain this path; the more specific one keeps the stored path
  // shorter and survives the outer root being re-pointed.
  const locator = bestLocatorForPath('/home/dan/Dropbox/projects/app/readme.md', { deviceRoots: DEVICE_ROOTS });
  assert.equal(locator.root, 'nested');
  assert.equal(locator.path, 'app/readme.md');
});

test('a path outside every root stays absolute and is tagged with the machine', () => {
  const locator = bestLocatorForPath('/var/log/syslog', {
    deviceRoots: DEVICE_ROOTS,
    device: { id: 'dev_1', name: 'desktop' },
  });
  assert.equal(locator.root, ABSOLUTE);
  assert.equal(locator.path, '/var/log/syslog');
  assert.equal(locator.deviceName, 'desktop');
});

test('a near-miss prefix is not treated as inside the root', () => {
  // /home/dan/DropboxOld must not match the /home/dan/Dropbox root.
  const locator = bestLocatorForPath('/home/dan/DropboxOld/notes.md', { deviceRoots: DEVICE_ROOTS });
  assert.equal(locator.root, ABSOLUTE);
});

/* ---- blocks with several locations ---- */

function fileBlock() {
  return createBlock({
    type: 'file',
    value: 'notes/today.md',
    meta: {
      root: 'sync',
      alternates: [
        { root: ABSOLUTE, path: '/home/dan/local-only.md', device: 'dev_1', deviceName: 'desktop' },
      ],
    },
  });
}

test('a file block exposes its primary first', () => {
  const locators = locatorsFor(fileBlock());
  assert.equal(locators.length, 2);
  assert.equal(locators[0].root, 'sync');
  assert.equal(locators[1].path, '/home/dan/local-only.md');
});

test('resolution prefers a location that actually exists here', () => {
  const block = fileBlock();
  const result = resolveBlock(block, {
    deviceRoots: DEVICE_ROOTS,
    // The primary resolves to a path that is not present; the alternate is.
    exists: (path) => path === '/home/dan/local-only.md',
  });
  assert.equal(result.path, '/home/dan/local-only.md');
  assert.equal(result.resolved, true);
});

test('with nothing present it still offers the first resolvable candidate', () => {
  const result = resolveBlock(fileBlock(), {
    deviceRoots: DEVICE_ROOTS,
    exists: () => false,
  });
  assert.equal(result.path, '/home/dan/Dropbox/notes/today.md');
  assert.equal(result.resolved, false);
  assert.equal(result.candidates.length, 2);
});

test('unmapped roots drop out of the candidate list', () => {
  const result = resolveBlock(fileBlock(), { deviceRoots: {}, exists: () => false });
  assert.equal(result.candidates.length, 1, 'only the absolute alternate is resolvable');
  assert.equal(result.path, '/home/dan/local-only.md');
});

test('a block with no locations resolves to nothing rather than throwing', () => {
  const result = resolveBlock(createBlock({ type: 'file', value: '' }), { deviceRoots: {} });
  assert.equal(result.path, null);
});

test('locators describe themselves for humans', () => {
  const doc = createDocument();
  const [primary, alternate] = locatorsFor(fileBlock());
  assert.equal(describeLocator(primary, doc), 'Cloud drive: notes/today.md');
  assert.equal(describeLocator(alternate, doc), '/home/dan/local-only.md (desktop)');
});

/* ---- commands ---- */

function storeWithFileBlock() {
  const doc = createDocument();
  const node = createNode({ id: 'n1', title: 'Notes', content: [fileBlock()] });
  doc.nodes.n1 = node;
  return { store: new Store(doc), blockId: node.content[0].id };
}

test('adding a location to an empty block fills the primary', () => {
  const doc = createDocument();
  const node = createNode({ id: 'n1', title: 'Notes', content: [createBlock({ type: 'file', value: '' })] });
  doc.nodes.n1 = node;
  const store = new Store(doc);
  runCommand('locator.add', store, {
    nodeId: 'n1',
    blockId: node.content[0].id,
    locator: { root: 'sync', path: 'first.md' },
  });
  const block = store.doc.nodes.n1.content[0];
  assert.equal(block.value, 'first.md');
  assert.equal(block.meta.root, 'sync');
  assert.equal(block.meta.alternates.length, 0);
});

test('adding a second location appends an alternate', () => {
  const { store, blockId } = storeWithFileBlock();
  runCommand('locator.add', store, {
    nodeId: 'n1', blockId, locator: { root: ABSOLUTE, path: '/mnt/usb/notes.md' },
  });
  assert.equal(store.doc.nodes.n1.content[0].meta.alternates.length, 2);
});

test('a duplicate location is not added twice', () => {
  const { store, blockId } = storeWithFileBlock();
  runCommand('locator.add', store, {
    nodeId: 'n1', blockId, locator: { root: 'sync', path: 'notes/today.md' },
  });
  assert.equal(store.doc.nodes.n1.content[0].meta.alternates.length, 1);
});

test('promoting an alternate swaps it with the primary', () => {
  const { store, blockId } = storeWithFileBlock();
  runCommand('locator.promote', store, { nodeId: 'n1', blockId, index: 1 });
  const block = store.doc.nodes.n1.content[0];
  assert.equal(block.value, '/home/dan/local-only.md');
  assert.equal(block.meta.root, ABSOLUTE);
  assert.equal(block.meta.alternates[0].path, 'notes/today.md');
});

test('removing the primary promotes the next location into its place', () => {
  const { store, blockId } = storeWithFileBlock();
  runCommand('locator.remove', store, { nodeId: 'n1', blockId, index: 0 });
  const block = store.doc.nodes.n1.content[0];
  assert.equal(block.value, '/home/dan/local-only.md');
  assert.equal(block.meta.alternates.length, 0);
});

test('deleting a root re-homes references instead of stranding them', () => {
  const { store } = storeWithFileBlock();
  runCommand('root.delete', store, { id: 'sync' });
  assert.equal(store.doc.roots.sync, undefined);
  // The path survives as a plain one the user can re-point, rather than
  // pointing at a root that no longer exists.
  assert.equal(store.doc.nodes.n1.content[0].meta.root, ABSOLUTE);
});

test('importing a folder makes one node per file, linked to the parent', () => {
  const doc = createDocument();
  doc.nodes.parent = createNode({ id: 'parent', title: 'Project', x: 0, y: 0 });
  const store = new Store(doc);

  const entries = ['a.md', 'b.md', 'c.md'].map((name) => ({
    title: name,
    locator: { root: 'sync', path: `project/${name}` },
  }));
  const created = runCommand('node.importFiles', store, { parentId: 'parent', entries });

  assert.equal(created.length, 3);
  assert.equal(Object.keys(store.doc.nodes).length, 4);
  assert.equal(Object.values(store.doc.edges).filter((e) => e.from === 'parent').length, 3);
  assert.equal(store.doc.nodes[created[0]].content[0].type, 'file');
});

test('re-importing the same folder adds nothing', () => {
  const doc = createDocument();
  doc.nodes.parent = createNode({ id: 'parent', title: 'Project' });
  const store = new Store(doc);
  const entries = [{ title: 'a.md', locator: { root: 'sync', path: 'project/a.md' } }];

  runCommand('node.importFiles', store, { parentId: 'parent', entries });
  const again = runCommand('node.importFiles', store, { parentId: 'parent', entries });

  assert.equal(again.length, 0, 'reconciles rather than duplicating');
  assert.equal(Object.keys(store.doc.nodes).length, 2);
});

/* ---- searching by file ---- */

test('the filePath filter finds every note touching a file', () => {
  const doc = createDocument();
  doc.nodes.a = createNode({ id: 'a', title: 'A', content: [fileBlock()] });
  doc.nodes.b = createNode({
    id: 'b',
    title: 'B',
    content: [createBlock({ type: 'file', value: '/somewhere/else.md', meta: { root: ABSOLUTE } })],
  });
  doc.nodes.c = createNode({ id: 'c', title: 'C' });
  const ctx = { doc, graph: new GraphIndex(doc) };

  const byName = selectNodes({ op: 'filePath', query: 'today.md' }, ctx);
  assert.deepEqual([...byName], ['a']);

  // Matches alternates too, so a file found only on another machine still
  // turns up the note that mentions it.
  const byAlternate = selectNodes({ op: 'filePath', query: 'local-only' }, ctx);
  assert.deepEqual([...byAlternate], ['a']);

  const anyFile = selectNodes({ op: 'filePath', query: '' }, ctx);
  assert.deepEqual([...anyFile].sort(), ['a', 'b']);
});

test('collectLocators walks every file reference in the document', () => {
  const doc = createDocument();
  doc.nodes.a = createNode({ id: 'a', title: 'A', content: [fileBlock()] });
  doc.nodes.b = createNode({ id: 'b', title: 'B', content: [createBlock({ type: 'markdown', value: 'x' })] });
  assert.equal(collectLocators(doc).length, 2, 'both locations on the one file block');
});
