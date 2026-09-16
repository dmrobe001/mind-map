/**
 * Commands: the app's verb vocabulary.
 *
 * Every document change the UI can make exists here as a named command with a
 * plain-data argument object. Keyboard shortcuts, buttons and (later) any
 * scripting surface all go through the same list, so a new verb is available
 * everywhere the moment it is registered.
 */

import { commands } from './registry.js';
import { createNode, createEdge, createBlock, createTagType, pickTagColor, now } from './model.js';
import { uid, slug } from './ids.js';

function define(id, label, run, extra = {}) {
  commands.register(id, { label, run, ...extra });
}

export function runCommand(id, store, args = {}) {
  const command = commands.get(id);
  if (!command) throw new Error(`Unknown command "${id}"`);
  return command.run(store, args);
}

const touch = (entity) => { entity.updated = now(); };

/* ------------------------------------------------------------------ *
 * Nodes
 * ------------------------------------------------------------------ */

define('node.add', 'Add node', (store, { title = '', x = 0, y = 0, tags = [], status = null, fields }) => {
  const node = createNode({ title: title || 'New node', x, y, tags, status, fields });
  store.update('Add node', (doc) => { doc.nodes[node.id] = node; });
  return node.id;
});

define('node.update', 'Edit node', (store, { id, patch, coalesceKey }) => {
  store.update('Edit node', (doc) => {
    const node = doc.nodes[id];
    if (!node) return false;
    Object.assign(node, patch);
    touch(node);
    return true;
  }, { coalesceKey });
  return id;
});

define('node.move', 'Move node', (store, { positions }) => {
  // `positions` is { [nodeId]: {x, y} } so a multi-node drag is one undo step.
  store.update('Move node', (doc) => {
    for (const [id, pos] of Object.entries(positions)) {
      const node = doc.nodes[id];
      if (!node) continue;
      node.x = pos.x;
      node.y = pos.y;
    }
  }, { coalesceKey: `move:${Object.keys(positions).sort().join(',')}` });
});

define('node.delete', 'Delete node', (store, { ids }) => {
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  store.update(set.size > 1 ? 'Delete nodes' : 'Delete node', (doc) => {
    for (const id of set) delete doc.nodes[id];
    // Edges cannot outlive their endpoints.
    for (const [edgeId, edge] of Object.entries(doc.edges)) {
      if (set.has(edge.from) || set.has(edge.to)) delete doc.edges[edgeId];
    }
  });
});

define('node.setStatus', 'Set status', (store, { ids, status }) => {
  const list = Array.isArray(ids) ? ids : [ids];
  store.update('Set status', (doc) => {
    for (const id of list) {
      const node = doc.nodes[id];
      if (!node) continue;
      node.status = status;
      touch(node);
    }
  });
});

/** Cycle none -> first status -> ... -> last -> none. */
define('node.cycleStatus', 'Cycle status', (store, { ids }) => {
  const list = Array.isArray(ids) ? ids : [ids];
  const order = Object.values(store.doc.statusTypes)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((s) => s.id);
  store.update('Cycle status', (doc) => {
    for (const id of list) {
      const node = doc.nodes[id];
      if (!node) continue;
      const index = order.indexOf(node.status);
      node.status = index + 1 >= order.length ? null : order[index + 1];
      touch(node);
    }
  });
});

define('node.toggleTag', 'Toggle label', (store, { ids, tag }) => {
  const list = Array.isArray(ids) ? ids : [ids];
  store.update('Toggle label', (doc) => {
    // Adding wins: if any selected node lacks the tag, add it to all of them.
    const shouldAdd = list.some((id) => doc.nodes[id] && !doc.nodes[id].tags.includes(tag));
    for (const id of list) {
      const node = doc.nodes[id];
      if (!node) continue;
      const has = node.tags.includes(tag);
      if (shouldAdd && !has) node.tags.push(tag);
      if (!shouldAdd && has) node.tags = node.tags.filter((t) => t !== tag);
      touch(node);
    }
  });
});

define('node.setField', 'Set field', (store, { id, key, value }) => {
  store.update('Set field', (doc) => {
    const node = doc.nodes[id];
    if (!node || !key) return false;
    node.fields[key] = value;
    touch(node);
    return true;
  });
});

define('node.deleteField', 'Remove field', (store, { id, key }) => {
  store.update('Remove field', (doc) => {
    const node = doc.nodes[id];
    if (!node) return false;
    delete node.fields[key];
    touch(node);
    return true;
  });
});

/* ------------------------------------------------------------------ *
 * Content blocks
 * ------------------------------------------------------------------ */

define('block.add', 'Add content', (store, { nodeId, type = 'markdown', value = '', label = '' }) => {
  const block = createBlock({ type, value, label });
  store.update('Add content', (doc) => {
    const node = doc.nodes[nodeId];
    if (!node) return false;
    node.content.push(block);
    touch(node);
    return true;
  });
  return block.id;
});

define('block.update', 'Edit content', (store, { nodeId, blockId, patch, coalesceKey }) => {
  store.update('Edit content', (doc) => {
    const block = doc.nodes[nodeId]?.content.find((b) => b.id === blockId);
    if (!block) return false;
    Object.assign(block, patch);
    touch(doc.nodes[nodeId]);
    return true;
  }, { coalesceKey });
});

define('block.delete', 'Remove content', (store, { nodeId, blockId }) => {
  store.update('Remove content', (doc) => {
    const node = doc.nodes[nodeId];
    if (!node) return false;
    node.content = node.content.filter((b) => b.id !== blockId);
    touch(node);
    return true;
  });
});

define('block.move', 'Reorder content', (store, { nodeId, blockId, delta }) => {
  store.update('Reorder content', (doc) => {
    const node = doc.nodes[nodeId];
    if (!node) return false;
    const index = node.content.findIndex((b) => b.id === blockId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= node.content.length) return false;
    const [block] = node.content.splice(index, 1);
    node.content.splice(target, 0, block);
    touch(node);
    return true;
  });
});

/* ------------------------------------------------------------------ *
 * Edges
 * ------------------------------------------------------------------ */

define('edge.add', 'Link nodes', (store, { from, to, type = 'relates', label = '' }) => {
  if (from === to) return null;
  const existing = Object.values(store.doc.edges).find((e) => (
    e.type === type && ((e.from === from && e.to === to)
      || (!store.doc.edgeTypes[type]?.directed && e.from === to && e.to === from))
  ));
  if (existing) return existing.id;
  const edge = createEdge({ from, to, type, label });
  store.update('Link nodes', (doc) => {
    if (!doc.nodes[from] || !doc.nodes[to]) return false;
    doc.edges[edge.id] = edge;
    return true;
  });
  return edge.id;
});

define('edge.update', 'Edit link', (store, { id, patch }) => {
  store.update('Edit link', (doc) => {
    const edge = doc.edges[id];
    if (!edge) return false;
    Object.assign(edge, patch);
    touch(edge);
    return true;
  });
});

define('edge.delete', 'Remove link', (store, { ids }) => {
  const list = Array.isArray(ids) ? ids : [ids];
  store.update('Remove link', (doc) => {
    for (const id of list) delete doc.edges[id];
  });
});

define('edge.reverse', 'Reverse link', (store, { id }) => {
  store.update('Reverse link', (doc) => {
    const edge = doc.edges[id];
    if (!edge) return false;
    [edge.from, edge.to] = [edge.to, edge.from];
    touch(edge);
    return true;
  });
});

/* ------------------------------------------------------------------ *
 * Labels, statuses, edge types
 * ------------------------------------------------------------------ */

define('tag.create', 'Create label', (store, { label }) => {
  const id = slug(label) || uid('tag');
  store.update('Create label', (doc) => {
    if (doc.tagTypes[id]) return false;
    doc.tagTypes[id] = createTagType(label, { id, color: pickTagColor(doc.tagTypes) });
    return true;
  });
  return id;
});

define('tag.update', 'Edit label', (store, { id, patch }) => {
  store.update('Edit label', (doc) => {
    if (!doc.tagTypes[id]) return false;
    Object.assign(doc.tagTypes[id], patch);
    return true;
  });
});

define('tag.delete', 'Delete label', (store, { id }) => {
  store.update('Delete label', (doc) => {
    delete doc.tagTypes[id];
    for (const node of Object.values(doc.nodes)) {
      node.tags = node.tags.filter((t) => t !== id);
    }
  });
});

define('edgeType.create', 'Create edge type', (store, { label, directed = true, hierarchical = false, color = '#8a8f98' }) => {
  const id = slug(label) || uid('et');
  store.update('Create edge type', (doc) => {
    if (doc.edgeTypes[id]) return false;
    doc.edgeTypes[id] = { id, label, directed, hierarchical, color, description: '' };
    return true;
  });
  return id;
});

define('edgeType.update', 'Edit edge type', (store, { id, patch }) => {
  store.update('Edit edge type', (doc) => {
    if (!doc.edgeTypes[id]) return false;
    Object.assign(doc.edgeTypes[id], patch);
    return true;
  });
});

/* ------------------------------------------------------------------ *
 * Named roots and file locators
 *
 * See core/locators.js for why a file reference is a list rather than a
 * string. These commands manage that list; resolving it is the UI's job.
 * ------------------------------------------------------------------ */

define('root.create', 'Add root', (store, { label, hint = '' }) => {
  const id = slug(label) || uid('root');
  store.update('Add root', (doc) => {
    if (doc.roots[id]) return false;
    doc.roots[id] = { id, label, hint };
    return true;
  });
  return id;
});

define('root.update', 'Edit root', (store, { id, patch }) => {
  store.update('Edit root', (doc) => {
    if (!doc.roots[id]) return false;
    Object.assign(doc.roots[id], patch);
    return true;
  });
});

define('root.delete', 'Remove root', (store, { id }) => {
  store.update('Remove root', (doc) => {
    delete doc.roots[id];
    // References to a deleted root would resolve to nothing forever, so they
    // are rewritten to plain relative paths the user can re-home.
    for (const node of Object.values(doc.nodes)) {
      for (const block of node.content ?? []) {
        if (block.type !== 'file') continue;
        if (block.meta?.root === id) block.meta.root = 'absolute';
        if (block.meta?.alternates) {
          for (const alternate of block.meta.alternates) {
            if (alternate.root === id) alternate.root = 'absolute';
          }
        }
      }
    }
  });
});

/** Attach another place the same file can be found. */
define('locator.add', 'Add file location', (store, { nodeId, blockId, locator }) => {
  store.update('Add file location', (doc) => {
    const block = doc.nodes[nodeId]?.content.find((b) => b.id === blockId);
    if (!block) return false;
    block.meta = block.meta ?? {};
    // The first location recorded becomes the primary, so adding one to an
    // empty block does the obvious thing rather than creating a blank primary.
    if (!block.value) {
      block.value = locator.path;
      block.meta.root = locator.root;
      block.meta.device = locator.device ?? null;
      block.meta.deviceName = locator.deviceName ?? null;
      return true;
    }
    block.meta.alternates = block.meta.alternates ?? [];
    const duplicate = block.meta.alternates.some(
      (a) => a.root === locator.root && a.path === locator.path,
    ) || (block.meta.root === locator.root && block.value === locator.path);
    if (duplicate) return false;
    block.meta.alternates.push({ ...locator });
    touch(doc.nodes[nodeId]);
    return true;
  });
});

define('locator.remove', 'Remove file location', (store, { nodeId, blockId, index }) => {
  store.update('Remove file location', (doc) => {
    const block = doc.nodes[nodeId]?.content.find((b) => b.id === blockId);
    if (!block) return false;
    if (index === 0) {
      // Removing the primary promotes the first alternate into its place.
      const next = (block.meta?.alternates ?? []).shift();
      block.value = next?.path ?? '';
      block.meta.root = next?.root ?? 'absolute';
      block.meta.device = next?.device ?? null;
      block.meta.deviceName = next?.deviceName ?? null;
      return true;
    }
    block.meta.alternates.splice(index - 1, 1);
    touch(doc.nodes[nodeId]);
    return true;
  });
});

define('locator.promote', 'Make primary location', (store, { nodeId, blockId, index }) => {
  store.update('Make primary location', (doc) => {
    const block = doc.nodes[nodeId]?.content.find((b) => b.id === blockId);
    if (!block || index < 1) return false;
    const alternates = block.meta.alternates ?? [];
    const [chosen] = alternates.splice(index - 1, 1);
    if (!chosen) return false;
    alternates.unshift({
      root: block.meta.root ?? 'absolute',
      path: block.value,
      device: block.meta.device ?? null,
      deviceName: block.meta.deviceName ?? null,
    });
    block.value = chosen.path;
    block.meta.root = chosen.root;
    block.meta.device = chosen.device ?? null;
    block.meta.deviceName = chosen.deviceName ?? null;
    touch(doc.nodes[nodeId]);
    return true;
  });
});

/**
 * Create one node per file, all hanging off a parent node.
 *
 * This is the "sits on top of my filesystem" move: point it at a folder and
 * the folder becomes a neighbourhood of the map that you can then link to
 * anything else. Re-running it over the same parent skips files already
 * referenced there, so it reconciles rather than duplicating.
 */
define('node.importFiles', 'Import files', (store, { parentId, entries, position }) => {
  const created = [];
  store.update('Import files', (doc) => {
    const parent = doc.nodes[parentId];
    const originX = position?.x ?? parent?.x ?? 0;
    const originY = position?.y ?? parent?.y ?? 0;

    const existing = new Set();
    if (parent) {
      for (const edge of Object.values(doc.edges)) {
        if (edge.from !== parentId) continue;
        for (const block of doc.nodes[edge.to]?.content ?? []) {
          if (block.type === 'file' && block.value) existing.add(block.value);
        }
      }
    }

    let placed = 0;
    for (const entry of entries) {
      if (existing.has(entry.locator.path)) continue;
      const node = createNode({
        title: entry.title,
        x: originX + 260 + (placed % 3) * 215,
        y: originY - 120 + Math.floor(placed / 3) * 110,
        tags: entry.tags ?? [],
        fields: entry.fields ?? {},
        content: [{
          type: 'file',
          label: entry.title,
          value: entry.locator.path,
          meta: {
            root: entry.locator.root,
            device: entry.locator.device ?? null,
            deviceName: entry.locator.deviceName ?? null,
          },
        }],
      });
      doc.nodes[node.id] = node;
      created.push(node.id);
      placed += 1;

      if (parent) {
        const edge = createEdge({ from: parentId, to: node.id, type: 'child' });
        doc.edges[edge.id] = edge;
      }
    }
    return created.length > 0;
  });
  return created;
});

/* ------------------------------------------------------------------ *
 * Saved views
 * ------------------------------------------------------------------ */

define('view.save', 'Save view', (store, { name, filter }) => {
  const id = uid('v');
  store.update('Save view', (doc) => {
    doc.views = doc.views.filter((v) => v.name !== name);
    doc.views.push({ id, name, filter: structuredClone(filter) });
  });
  return id;
});

define('view.delete', 'Delete view', (store, { id }) => {
  store.update('Delete view', (doc) => {
    doc.views = doc.views.filter((v) => v.id !== id);
  });
});

define('doc.rename', 'Rename map', (store, { title }) => {
  store.update('Rename map', (doc) => { doc.title = title; });
});

export { commands };
