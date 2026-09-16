/**
 * View state: everything that is about *looking* at the map rather than about
 * the map itself.
 *
 * Kept out of the document on purpose. Camera position and what you currently
 * have selected are not facts about your notes, and putting them in the file
 * would make every pan show up as a change to save.
 *
 * The one thing that does belong in the document is a *saved* view, because
 * "the filter I use when I don't want to see work stuff" is a real preference
 * worth keeping. Those live in `doc.views`.
 */

import { saveViewState, loadViewState } from '../core/persistence.js';

export const FOCUS_MODES = {
  off: { label: 'Off' },
  within: { label: 'Within N links', usesDepth: true, usesDirection: true },
  descendants: { label: 'Everything under', usesDepth: true },
  ancestors: { label: 'Everything above', usesDepth: true },
  connected: { label: 'Same cluster' },
};

const DEFAULTS = () => ({
  camera: { x: 0, y: 0, zoom: 1 },
  selection: { nodes: [], edges: [] },
  search: '',
  quick: { include: [], exclude: [], status: 'all' },
  focus: { node: null, mode: 'off', depth: 1, direction: 'any', includeSelf: true },
  /** Compound query built in the filter panel, or null. */
  advanced: null,
  /** Non-matching nodes fade instead of disappearing — keeps spatial memory intact. */
  dimInsteadOfHide: true,
  newEdgeType: 'child',
  panel: 'filters',
});

export class ViewState extends EventTarget {
  constructor(initial) {
    super();
    this.state = { ...DEFAULTS(), ...(initial ?? {}) };
  }

  static restore() {
    const saved = loadViewState();
    const base = DEFAULTS();
    if (!saved) return new ViewState(base);
    return new ViewState({
      ...base,
      ...saved,
      camera: { ...base.camera, ...(saved.camera ?? {}) },
      quick: { ...base.quick, ...(saved.quick ?? {}) },
      focus: { ...base.focus, ...(saved.focus ?? {}) },
      // Selection is intentionally not restored: reopening the tab pointing at
      // a stale node is more confusing than starting clean.
      selection: { nodes: [], edges: [] },
    });
  }

  get(key) {
    return this.state[key];
  }

  /** Merge a patch and notify. `quiet` skips persistence for high-frequency updates. */
  set(patch, { quiet = false } = {}) {
    Object.assign(this.state, patch);
    this.dispatchEvent(new CustomEvent('change', { detail: { patch } }));
    if (!quiet) this.persist();
  }

  persist() {
    const { selection, ...rest } = this.state;
    saveViewState(rest);
  }

  /* ---- selection helpers ---- */

  get selectedNodes() { return this.state.selection.nodes; }

  get selectedEdges() { return this.state.selection.edges; }

  get soleSelectedNode() {
    const { nodes } = this.state.selection;
    return nodes.length === 1 ? nodes[0] : null;
  }

  selectNodes(ids, { additive = false } = {}) {
    const list = Array.isArray(ids) ? ids : [ids].filter(Boolean);
    const next = additive
      ? [...new Set([...this.state.selection.nodes, ...list])]
      : list;
    this.set({ selection: { nodes: next, edges: additive ? this.state.selection.edges : [] } });
  }

  toggleNode(id) {
    const current = this.state.selection.nodes;
    const next = current.includes(id) ? current.filter((n) => n !== id) : [...current, id];
    this.set({ selection: { nodes: next, edges: this.state.selection.edges } });
  }

  selectEdges(ids, { additive = false } = {}) {
    const list = Array.isArray(ids) ? ids : [ids].filter(Boolean);
    this.set({
      selection: {
        nodes: additive ? this.state.selection.nodes : [],
        edges: additive ? [...new Set([...this.state.selection.edges, ...list])] : list,
      },
    });
  }

  clearSelection() {
    this.set({ selection: { nodes: [], edges: [] } });
  }

  /* ---- quick filter helpers ---- */

  /** Chips cycle neutral -> include -> exclude -> neutral. */
  cycleTag(tagId) {
    const { include, exclude } = this.state.quick;
    let nextInclude = include.filter((t) => t !== tagId);
    let nextExclude = exclude.filter((t) => t !== tagId);
    if (include.includes(tagId)) {
      nextExclude = [...nextExclude, tagId];
    } else if (!exclude.includes(tagId)) {
      nextInclude = [...nextInclude, tagId];
    }
    this.set({ quick: { ...this.state.quick, include: nextInclude, exclude: nextExclude } });
  }

  tagState(tagId) {
    if (this.state.quick.include.includes(tagId)) return 'include';
    if (this.state.quick.exclude.includes(tagId)) return 'exclude';
    return 'neutral';
  }

  resetFilters() {
    this.set({
      quick: { include: [], exclude: [], status: 'all' },
      focus: { ...this.state.focus, mode: 'off' },
      advanced: null,
      search: '',
    });
  }

  get hasActiveFilter() {
    const { quick, focus, advanced, search } = this.state;
    return quick.include.length > 0
      || quick.exclude.length > 0
      || quick.status !== 'all'
      || (focus.mode !== 'off' && Boolean(focus.node))
      || Boolean(advanced)
      || Boolean(search.trim());
  }
}

/**
 * Fold the whole view state down to one filter spec.
 *
 * Everything the UI offers — label chips, the status dropdown, the focus
 * controls, the search box and the compound query builder — compiles to the
 * same language, so there is no second filtering path to keep in sync.
 */
export function buildEffectiveFilter(view) {
  const { quick, focus, advanced, search } = view.state;
  const clauses = [];

  if (quick.include.length) clauses.push({ op: 'anyTag', tags: quick.include });
  if (quick.exclude.length) {
    clauses.push({ op: 'not', clause: { op: 'anyTag', tags: quick.exclude } });
  }
  if (quick.status !== 'all') clauses.push({ op: 'status', status: quick.status });
  if (search.trim()) clauses.push({ op: 'text', query: search.trim() });

  if (focus.mode !== 'off' && focus.node) {
    clauses.push({
      op: focus.mode,
      node: focus.node,
      depth: focus.depth,
      direction: focus.direction,
      includeSelf: focus.includeSelf,
    });
  }

  if (advanced) clauses.push(advanced);

  if (!clauses.length) return { op: 'all' };
  if (clauses.length === 1) return clauses[0];
  return { op: 'and', clauses };
}
