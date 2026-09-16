/**
 * The filter language.
 *
 * A filter is a plain JSON tree:
 *
 *   { op: 'and', clauses: [
 *       { op: 'tag', tag: 'work' },
 *       { op: 'not', clause: { op: 'status', status: 'done' } },
 *       { op: 'within', node: 'n_ab12', depth: 2, direction: 'any' }
 *   ]}
 *
 * Because it is data it can be saved in the document as a named view, shared,
 * or built up by a UI without the UI knowing what the operators mean.
 *
 * Each operator is a registry entry:
 *
 *   build(spec, ctx) -> (node) => boolean
 *   describe(spec, ctx) -> string            (for chips and tooltips)
 *   fields                                    (drives the generic query builder)
 *
 * Operators that need the graph resolve their node set once, at compile time,
 * and the returned predicate is then a Set lookup.
 */

import { filterOps } from './registry.js';

export const MATCH_ALL = { op: 'all' };

/** Compile a spec into a predicate over nodes. */
export function compileFilter(spec, ctx) {
  if (!spec) return () => true;
  const op = filterOps.get(spec.op);
  if (!op) {
    console.warn(`Unknown filter op "${spec.op}" — treating as match-all.`);
    return () => true;
  }
  return op.build(spec, { ...ctx, compile: (child) => compileFilter(child, ctx) });
}

export function describeFilter(spec, ctx) {
  if (!spec) return 'everything';
  const op = filterOps.get(spec.op);
  if (!op || !op.describe) return spec.op;
  return op.describe(spec, { ...ctx, describe: (child) => describeFilter(child, ctx) });
}

/** Ids of nodes passing the filter. */
export function selectNodes(spec, ctx) {
  const predicate = compileFilter(spec, ctx);
  const out = new Set();
  for (const node of Object.values(ctx.doc.nodes)) {
    if (predicate(node)) out.add(node.id);
  }
  return out;
}

/** An edge is shown only when both of its endpoints survive the filter. */
export function selectEdges(nodeIds, doc) {
  const out = new Set();
  for (const edge of Object.values(doc.edges)) {
    if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) out.add(edge.id);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Structural operators
 * ------------------------------------------------------------------ */

filterOps.register('all', {
  label: 'Everything',
  category: 'basic',
  structural: true,
  fields: [],
  build: () => () => true,
  describe: () => 'everything',
});

filterOps.register('none', {
  label: 'Nothing',
  category: 'basic',
  structural: true,
  fields: [],
  build: () => () => false,
  describe: () => 'nothing',
});

filterOps.register('and', {
  label: 'All of',
  category: 'group',
  structural: true,
  fields: [],
  build: (spec, ctx) => {
    const parts = (spec.clauses ?? []).map(ctx.compile);
    return (node) => parts.every((p) => p(node));
  },
  describe: (spec, ctx) => (spec.clauses ?? []).map(ctx.describe).join(' AND ') || 'everything',
});

filterOps.register('or', {
  label: 'Any of',
  category: 'group',
  structural: true,
  fields: [],
  build: (spec, ctx) => {
    const parts = (spec.clauses ?? []).map(ctx.compile);
    if (!parts.length) return () => true;
    return (node) => parts.some((p) => p(node));
  },
  describe: (spec, ctx) => (spec.clauses ?? []).map(ctx.describe).join(' OR ') || 'everything',
});

filterOps.register('not', {
  label: 'Not',
  category: 'group',
  structural: true,
  fields: [],
  build: (spec, ctx) => {
    const inner = ctx.compile(spec.clause);
    return (node) => !inner(node);
  },
  describe: (spec, ctx) => `NOT (${ctx.describe(spec.clause)})`,
});

/* ------------------------------------------------------------------ *
 * Attribute operators
 * ------------------------------------------------------------------ */

filterOps.register('tag', {
  label: 'has label',
  category: 'attribute',
  order: 10,
  fields: [{ key: 'tag', type: 'tag', label: 'label' }],
  build: (spec) => (node) => node.tags.includes(spec.tag),
  describe: (spec, ctx) => `#${ctx.doc.tagTypes[spec.tag]?.label ?? spec.tag}`,
});

filterOps.register('anyTag', {
  label: 'has any label of',
  category: 'attribute',
  order: 11,
  fields: [{ key: 'tags', type: 'tagList', label: 'labels' }],
  build: (spec) => {
    const wanted = new Set(spec.tags ?? []);
    if (!wanted.size) return () => true;
    return (node) => node.tags.some((t) => wanted.has(t));
  },
  describe: (spec) => `any of #${(spec.tags ?? []).join(', #')}`,
});

filterOps.register('allTags', {
  label: 'has every label of',
  category: 'attribute',
  order: 12,
  fields: [{ key: 'tags', type: 'tagList', label: 'labels' }],
  build: (spec) => {
    const wanted = spec.tags ?? [];
    return (node) => wanted.every((t) => node.tags.includes(t));
  },
  describe: (spec) => `all of #${(spec.tags ?? []).join(', #')}`,
});

filterOps.register('untagged', {
  label: 'has no labels',
  category: 'attribute',
  order: 13,
  fields: [],
  build: () => (node) => node.tags.length === 0,
  describe: () => 'unlabelled',
});

filterOps.register('status', {
  label: 'status is',
  category: 'attribute',
  order: 20,
  fields: [{ key: 'status', type: 'status', label: 'status', default: 'none' }],
  build: (spec) => {
    if (spec.status === 'none' || spec.status === null) return (node) => !node.status;
    if (spec.status === 'any') return (node) => Boolean(node.status);
    return (node) => node.status === spec.status;
  },
  describe: (spec, ctx) => {
    if (spec.status === 'none' || spec.status == null) return 'no status';
    if (spec.status === 'any') return 'has a status';
    return ctx.doc.statusTypes[spec.status]?.label ?? spec.status;
  },
});

filterOps.register('text', {
  label: 'text contains',
  category: 'attribute',
  order: 30,
  fields: [{ key: 'query', type: 'text', label: 'text' }],
  build: (spec) => {
    const needle = String(spec.query ?? '').toLowerCase();
    if (!needle) return () => true;
    return (node) => searchableText(node).includes(needle);
  },
  describe: (spec) => `text ~ "${spec.query}"`,
});

const COMPARATORS = {
  eq: (a, b) => String(a) === String(b),
  ne: (a, b) => String(a) !== String(b),
  contains: (a, b) => String(a ?? '').toLowerCase().includes(String(b).toLowerCase()),
  gt: (a, b) => Number(a) > Number(b),
  lt: (a, b) => Number(a) < Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  exists: (a) => a !== undefined && a !== null && a !== '',
  missing: (a) => a === undefined || a === null || a === '',
};

filterOps.register('field', {
  label: 'field',
  category: 'attribute',
  order: 40,
  fields: [
    { key: 'key', type: 'text', label: 'key' },
    { key: 'cmp', type: 'select', label: 'is', options: Object.keys(COMPARATORS), default: 'eq' },
    { key: 'value', type: 'text', label: 'value' },
  ],
  build: (spec) => {
    const cmp = COMPARATORS[spec.cmp ?? 'eq'] ?? COMPARATORS.eq;
    return (node) => cmp(node.fields?.[spec.key], spec.value);
  },
  describe: (spec) => `${spec.key} ${spec.cmp ?? 'eq'} ${spec.value ?? ''}`.trim(),
});

/* ------------------------------------------------------------------ *
 * Relationship operators
 *
 * These are what make "show me only what hangs off this node" possible. Each
 * resolves a Set of ids at compile time.
 * ------------------------------------------------------------------ */

function reachOp({ id, label, order, describeVerb, resolve, extraFields = [] }) {
  filterOps.register(id, {
    label,
    category: 'relationship',
    order,
    fields: [
      { key: 'node', type: 'node', label: 'node' },
      { key: 'includeSelf', type: 'boolean', label: 'include it', default: true },
      ...extraFields,
    ],
    build: (spec, ctx) => {
      if (!spec.node || !ctx.doc.nodes[spec.node]) return () => true;
      const ids = resolve(spec, ctx);
      return (node) => ids.has(node.id);
    },
    describe: (spec, ctx) => {
      const title = ctx.doc.nodes[spec.node]?.title ?? '?';
      return `${describeVerb(spec)} "${title}"`;
    },
  });
}

reachOp({
  id: 'within',
  label: 'within N links of',
  order: 50,
  extraFields: [
    { key: 'depth', type: 'number', label: 'links', default: 1, min: 1, max: 12 },
    {
      key: 'direction',
      type: 'select',
      label: 'following',
      options: ['any', 'out', 'in'],
      default: 'any',
    },
    { key: 'edgeTypes', type: 'edgeTypeList', label: 'edge types' },
  ],
  describeVerb: (spec) => `within ${spec.depth ?? 1} of`,
  resolve: (spec, ctx) => new Set(ctx.graph.reach([spec.node], {
    depth: Number(spec.depth ?? 1),
    direction: spec.direction ?? 'any',
    edgeTypes: spec.edgeTypes?.length ? spec.edgeTypes : null,
    includeSelf: spec.includeSelf !== false,
  }).keys()),
});

reachOp({
  id: 'descendants',
  label: 'is under',
  order: 51,
  extraFields: [
    { key: 'depth', type: 'number', label: 'levels', default: 0, min: 0, max: 12,
      hint: '0 means all the way down' },
  ],
  describeVerb: () => 'under',
  resolve: (spec, ctx) => new Set(ctx.graph.descendants(spec.node, {
    depth: Number(spec.depth) > 0 ? Number(spec.depth) : Infinity,
    includeSelf: spec.includeSelf !== false,
  }).keys()),
});

reachOp({
  id: 'ancestors',
  label: 'is above',
  order: 52,
  extraFields: [
    { key: 'depth', type: 'number', label: 'levels', default: 0, min: 0, max: 12,
      hint: '0 means all the way up' },
  ],
  describeVerb: () => 'above',
  resolve: (spec, ctx) => new Set(ctx.graph.ancestors(spec.node, {
    depth: Number(spec.depth) > 0 ? Number(spec.depth) : Infinity,
    includeSelf: spec.includeSelf !== false,
  }).keys()),
});

reachOp({
  id: 'connected',
  label: 'is connected to',
  order: 53,
  describeVerb: () => 'connected to',
  resolve: (spec, ctx) => new Set(ctx.graph.component(spec.node).keys()),
});

filterOps.register('degree', {
  label: 'link count',
  category: 'relationship',
  order: 60,
  fields: [
    { key: 'cmp', type: 'select', label: 'is', options: ['gt', 'lt', 'eq', 'gte', 'lte'], default: 'gte' },
    { key: 'value', type: 'number', label: 'count', default: 1, min: 0 },
  ],
  build: (spec, ctx) => {
    const cmp = COMPARATORS[spec.cmp ?? 'gte'] ?? COMPARATORS.gte;
    return (node) => cmp(ctx.graph.degree(node.id), spec.value ?? 0);
  },
  describe: (spec) => `links ${spec.cmp ?? 'gte'} ${spec.value ?? 0}`,
});

filterOps.register('orphan', {
  label: 'has no links',
  category: 'relationship',
  order: 61,
  fields: [],
  build: (spec, ctx) => (node) => ctx.graph.degree(node.id) === 0,
  describe: () => 'unlinked',
});

/* ------------------------------------------------------------------ */

export function searchableText(node) {
  return [
    node.title,
    node.summary,
    ...(node.content ?? []).map((b) => b.value),
    ...Object.entries(node.fields ?? {}).map(([k, v]) => `${k} ${v}`),
  ].join('\n').toLowerCase();
}

export { COMPARATORS };
