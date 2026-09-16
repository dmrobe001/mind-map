/**
 * The store: the one place the document is allowed to change.
 *
 * Every mutation goes through `update()`, which hands the mutator a clone,
 * pushes the previous document onto the undo stack, and notifies subscribers.
 * Nothing else in the app mutates `doc` in place, which is what makes undo
 * and autosave reliable without any change-tracking machinery.
 */

import { GraphIndex } from './graph.js';
import { now } from './model.js';

const MAX_HISTORY = 200;
const COALESCE_WINDOW_MS = 700;

export class Store {
  constructor(doc) {
    this._doc = doc;
    this._graph = null;
    this._listeners = new Set();
    this._undo = [];
    this._redo = [];
    this._lastEntry = null;
  }

  get doc() {
    return this._doc;
  }

  /** Derived adjacency index, rebuilt lazily after each change. */
  get graph() {
    if (!this._graph) this._graph = new GraphIndex(this._doc);
    return this._graph;
  }

  /** Context object accepted by the query engine. */
  get queryContext() {
    return { doc: this._doc, graph: this.graph };
  }

  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit(reason) {
    this._graph = null;
    for (const listener of this._listeners) listener(this._doc, reason);
  }

  /**
   * Apply a change.
   *
   * @param {string}   label     shown in the undo tooltip
   * @param {Function} mutator   receives a mutable clone of the document
   * @param {object}   [opts]
   * @param {string}   [opts.coalesceKey]  consecutive updates sharing a key
   *   within a short window collapse into one undo step, so dragging a node
   *   is one undo rather than two hundred
   * @param {boolean}  [opts.silent]  skip history entirely (view-only changes)
   */
  update(label, mutator, opts = {}) {
    const draft = structuredClone(this._doc);
    const result = mutator(draft);
    if (result === false) return null; // mutator declined
    draft.meta = { ...draft.meta, updated: now() };

    if (!opts.silent) {
      const coalesce = opts.coalesceKey
        && this._lastEntry
        && this._lastEntry.coalesceKey === opts.coalesceKey
        && Date.now() - this._lastEntry.at < COALESCE_WINDOW_MS;

      if (!coalesce) {
        this._undo.push({ doc: this._doc, label });
        if (this._undo.length > MAX_HISTORY) this._undo.shift();
      }
      this._lastEntry = { coalesceKey: opts.coalesceKey, at: Date.now() };
      this._redo.length = 0;
    }

    this._doc = draft;
    this._emit({ label, ...opts });
    return result;
  }

  /** Swap the whole document, e.g. on file open. Clears history. */
  replaceDocument(doc, label = 'Open map') {
    this._undo.length = 0;
    this._redo.length = 0;
    this._lastEntry = null;
    this._doc = doc;
    this._emit({ label, replaced: true });
  }

  get canUndo() { return this._undo.length > 0; }

  get canRedo() { return this._redo.length > 0; }

  get undoLabel() { return this._undo.at(-1)?.label ?? null; }

  get redoLabel() { return this._redo.at(-1)?.label ?? null; }

  undo() {
    const entry = this._undo.pop();
    if (!entry) return false;
    this._redo.push({ doc: this._doc, label: entry.label });
    this._doc = entry.doc;
    this._lastEntry = null;
    this._emit({ label: `Undo ${entry.label}`, history: true });
    return true;
  }

  redo() {
    const entry = this._redo.pop();
    if (!entry) return false;
    this._undo.push({ doc: this._doc, label: entry.label });
    this._doc = entry.doc;
    this._lastEntry = null;
    this._emit({ label: `Redo ${entry.label}`, history: true });
    return true;
  }
}
