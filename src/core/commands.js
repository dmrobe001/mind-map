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
