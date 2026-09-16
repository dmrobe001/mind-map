/**
 * The document model.
 *
 * This is the part of the codebase meant to outlive the UI, so it is plain
 * data: a document is a JSON object with no methods, no classes and no
 * references back into the app. Anything here can be serialised, diffed in
 * git, and read by a human in a text editor.
 *
 * Extension points baked into the shape:
 *   - `node.fields` / `edge.fields`  free-form structured data, ignored by
 *     code that doesn't know about a given key
 *   - `node.content`                 a list of typed content blocks, rendered
 *     by whatever is registered in content/renderers.js
 *   - `doc.tagTypes`                 user-defined labels, not a fixed
 *     work/personal enum
 *   - `doc.edgeTypes`                user-defined relationship kinds, each of
 *     which can declare itself hierarchical
 *   - `doc.statusTypes`              user-defined lifecycle states; to-do and
 *     done are just the two that ship
 */

import { uid, slug } from './ids.js';

export const SCHEMA_VERSION = 1;

const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------ */

export const DEFAULT_EDGE_TYPES = {
  child: {
    id: 'child',
    label: 'child',
    // `from` is the parent, `to` is the child.
    directed: true,
    // Hierarchical types are the ones "children of X" and "ancestors of X"
    // walk. Several types may be hierarchical at once.
    hierarchical: true,
    color: '#5b8def',
    description: 'A → B means B sits under A.',
  },
  relates: {
    id: 'relates',
    label: 'relates to',
    directed: false,
    hierarchical: false,
    color: '#8a8f98',
    description: 'A symmetric association with no direction implied.',
  },
  references: {
    id: 'references',
    label: 'references',
    directed: true,
    hierarchical: false,
    color: '#b07cd6',
    description: 'A → B means A points at B, e.g. a note citing a source.',
  },
};

export const DEFAULT_ROOTS = {
  sync: {
    id: 'sync',
    label: 'Cloud drive',
    hint: 'The folder you sync between machines — Dropbox, OneDrive, Drive, Syncthing.',
  },
};

export const DEFAULT_STATUS_TYPES = {
  todo: { id: 'todo', label: 'To-do', color: '#e0a33e', done: false, order: 1 },
  done: { id: 'done', label: 'Done', color: '#4aa96c', done: true, order: 2 },
};

export const TAG_PALETTE = [
  '#5b8def', '#4aa96c', '#e0a33e', '#d9636b', '#b07cd6',
  '#3fb0ac', '#d98d4a', '#7f8ea3', '#c95f9b', '#6fa8dc',
];

/* ------------------------------------------------------------------ *
 * Factories
 * ------------------------------------------------------------------ */

export function createNode(props = {}) {
  const ts = now();
  return {
    id: props.id || uid('n'),
    title: props.title ?? 'Untitled',
    /** Short plain-text note shown on the card itself. */
    summary: props.summary ?? '',
    /**
     * Ordered content blocks. Each is { id, type, value, ... }; `type` is
     * looked up in the content renderer registry, so unknown types survive a
     * round-trip through an older build instead of being dropped.
     */
    content: props.content ? props.content.map(createBlock) : [],
    tags: [...(props.tags ?? [])],
    status: props.status ?? null,
    x: Number(props.x ?? 0),
    y: Number(props.y ?? 0),
    /** Free-form structured data. Nothing validates this on purpose. */
    fields: { ...(props.fields ?? {}) },
    color: props.color ?? null,
    created: props.created ?? ts,
    updated: props.updated ?? ts,
  };
}

export function createBlock(props = {}) {
  const meta = { ...(props.meta ?? {}) };
  // A file block's meta is its locator set, so give it the full shape up front
  // rather than making every reader guard for a missing key.
  if ((props.type ?? 'markdown') === 'file') {
    meta.root = meta.root ?? 'absolute';
    meta.alternates = (meta.alternates ?? []).map((alternate) => ({
      root: alternate.root ?? 'absolute',
      path: alternate.path ?? '',
      device: alternate.device ?? null,
      deviceName: alternate.deviceName ?? null,
    }));
  }
  return {
    id: props.id || uid('b'),
    type: props.type ?? 'markdown',
    value: props.value ?? '',
    label: props.label ?? '',
    meta,
  };
}

export function createEdge(props = {}) {
  const ts = now();
  return {
    id: props.id || uid('e'),
    from: props.from,
    to: props.to,
    type: props.type ?? 'relates',
    label: props.label ?? '',
    tags: [...(props.tags ?? [])],
    fields: { ...(props.fields ?? {}) },
    created: props.created ?? ts,
    updated: props.updated ?? ts,
  };
}

export function createTagType(name, props = {}) {
  const id = props.id || slug(name) || uid('t');
  return {
    id,
    label: props.label ?? name,
    color: props.color ?? TAG_PALETTE[0],
    description: props.description ?? '',
  };
}

export function createDocument(props = {}) {
  const ts = now();
  return {
    version: SCHEMA_VERSION,
    id: props.id || uid('doc'),
    title: props.title ?? 'Untitled map',
    nodes: props.nodes ?? {},
    edges: props.edges ?? {},
    tagTypes: props.tagTypes ?? {},
    edgeTypes: props.edgeTypes ?? structuredClone(DEFAULT_EDGE_TYPES),
    statusTypes: props.statusTypes ?? structuredClone(DEFAULT_STATUS_TYPES),
    /**
     * Named locations that file references can be relative to, e.g. a cloud
     * drive folder. Only the *names* live here — each machine maps them to a
     * real path in its own settings, which is what makes a reference portable.
     */
    roots: props.roots ?? structuredClone(DEFAULT_ROOTS),
    /** Saved filter/focus combinations, e.g. "no work stuff". */
    views: props.views ?? [],
    meta: { created: ts, ...(props.meta ?? {}), updated: ts },
  };
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

/**
 * Bring a document read from disk up to the current schema.
 *
 * Each step migrates one version forward, so a very old file walks the whole
 * chain. Migrations must be pure and must never throw on unexpected extra
 * keys — forward compatibility is the whole reason `fields` exists.
 */
const MIGRATIONS = {
  // 0 -> 1: documents written before the schema was versioned.
  0: (doc) => ({ ...doc, version: 1 }),
};

export function migrate(raw) {
  let doc = { ...raw };
  let version = Number(doc.version ?? 0);
  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) break;
    doc = step(doc);
    version = Number(doc.version ?? version + 1);
  }
  return doc;
}

/**
 * Coerce an arbitrary parsed object into a valid document.
 *
 * Deliberately forgiving: a map the user has hand-edited should open with the
 * salvageable parts intact rather than failing outright. Problems are
 * collected and returned so the caller can surface them.
 */
export function normalizeDocument(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object') {
    return { doc: createDocument(), problems: ['File did not contain a JSON object.'] };
  }

  const migrated = migrate(raw);
  const doc = createDocument({
    id: migrated.id,
    title: migrated.title,
    tagTypes: {},
    edgeTypes: { ...structuredClone(DEFAULT_EDGE_TYPES), ...(migrated.edgeTypes ?? {}) },
    statusTypes: { ...structuredClone(DEFAULT_STATUS_TYPES), ...(migrated.statusTypes ?? {}) },
    roots: { ...structuredClone(DEFAULT_ROOTS), ...(migrated.roots ?? {}) },
    views: Array.isArray(migrated.views) ? migrated.views : [],
    meta: migrated.meta ?? {},
  });

  for (const [id, tag] of Object.entries(migrated.tagTypes ?? {})) {
    doc.tagTypes[id] = createTagType(tag?.label ?? id, { ...tag, id });
  }

  for (const [id, node] of Object.entries(migrated.nodes ?? {})) {
    if (!node || typeof node !== 'object') {
      problems.push(`Skipped node ${id}: not an object.`);
      continue;
    }
    doc.nodes[id] = createNode({ ...node, id });
  }

  for (const [id, edge] of Object.entries(migrated.edges ?? {})) {
    if (!edge || typeof edge !== 'object') {
      problems.push(`Skipped edge ${id}: not an object.`);
      continue;
    }
    if (!doc.nodes[edge.from] || !doc.nodes[edge.to]) {
      problems.push(`Dropped edge ${id}: it points at a node that isn't in the file.`);
      continue;
    }
    doc.edges[id] = createEdge({ ...edge, id });
  }

  // Tags used by nodes but never declared get a definition so they show up in
  // the filter bar instead of being invisible.
  for (const node of Object.values(doc.nodes)) {
    for (const tagId of node.tags) {
      if (!doc.tagTypes[tagId]) {
        doc.tagTypes[tagId] = createTagType(tagId, {
          id: tagId,
          color: pickTagColor(doc.tagTypes),
        });
      }
    }
  }

  return { doc, problems };
}

export function pickTagColor(tagTypes) {
  const used = new Set(Object.values(tagTypes).map((t) => t.color));
  return TAG_PALETTE.find((c) => !used.has(c)) ?? TAG_PALETTE[Object.keys(tagTypes).length % TAG_PALETTE.length];
}

/** Stable, pretty JSON for writing to disk. Key order is fixed so diffs are small. */
export function serializeDocument(doc) {
  return JSON.stringify(doc, null, 2);
}

export { now };
