/**
 * Registries.
 *
 * The app's extension story is: to add a capability, register a function.
 * Nothing that consumes a registry may special-case a particular entry, so a
 * feature added from outside behaves exactly like one that shipped.
 */

export class Registry {
  constructor(name) {
    this.name = name;
    this.entries = new Map();
  }

  register(id, entry) {
    if (this.entries.has(id)) {
      console.warn(`[${this.name}] overwriting "${id}"`);
    }
    this.entries.set(id, { id, ...entry });
    return this;
  }

  get(id) {
    return this.entries.get(id);
  }

  has(id) {
    return this.entries.has(id);
  }

  list() {
    return [...this.entries.values()];
  }

  /** Entries in declared display order, for building menus. */
  sorted() {
    return this.list().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)
      || String(a.label ?? a.id).localeCompare(String(b.label ?? b.id)));
  }
}

/** Predicate builders for the filter language. See core/query.js. */
export const filterOps = new Registry('filterOps');

/** Renderers for node content blocks. See content/renderers.js. */
export const contentRenderers = new Registry('contentRenderers');

/** Named, undoable operations on the document. See core/commands.js. */
export const commands = new Registry('commands');
