# Architecture

A map of the code, and why it is shaped this way. If you only read one thing
before changing something, read this.

## The shape of it

```
index.html          the whole app shell
src/main.js         entry point; imports are what register extensions
src/core/           everything that would still make sense without a screen
  model.js          document schema, factories, migration, normalisation
  ids.js            id generation
  store.js          the only place the document changes; undo/redo
  graph.js          adjacency index and traversal (derived, disposable)
  query.js          the filter language and its operators
  commands.js       named, undoable operations — the app's verbs
  persistence.js    autosave, file handles, import/export
  registry.js       the extension points
  starter.js        the map you get on first run
src/content/        node content types
  markdown.js       small dependency-free Markdown renderer
  renderers.js      one registry entry per content block type
src/ui/             everything that touches the DOM
  app.js            wiring: when things run
  canvas.js         pan/zoom, cards, edges, direct manipulation
  filterpanel.js    the three tiers of filtering
  inspector.js      one node (or edge) in detail
  palette.js        Ctrl+K quick switcher
  toolbar.js        file operations, history, zoom
  viewstate.js      camera, selection, active filter
src/styles.css      all of the styling
tests/core.test.mjs tests for everything above that doesn't touch the DOM
examples/           a sample map file
docs/               these documents
```

There is no build step and no dependency tree. Everything is native ES modules
loaded straight from disk, which means the only thing between you and a change
is a reload.

## The three ideas worth knowing

### 1. The document is plain, versioned JSON

`core/model.js` defines a document as data with no methods and no back
references. That is what makes saving trivial, diffs readable, and undo a
matter of keeping old copies.

```jsonc
{
  "version": 1,
  "title": "…",
  "nodes":       { "n_ab12": { "id": "n_ab12", "title": "…", "x": 0, "y": 0,
                               "tags": [], "status": null,
                               "content": [], "fields": {} } },
  "edges":       { "e_cd34": { "id": "e_cd34", "from": "n_ab12", "to": "n_ef56",
                               "type": "child", "fields": {} } },
  "tagTypes":    { "work": { "id": "work", "label": "work", "color": "#5b8def" } },
  "edgeTypes":   { "child": { "id": "child", "directed": true, "hierarchical": true } },
  "statusTypes": { "todo": { "id": "todo", "label": "To-do", "done": false } },
  "views":       [ { "id": "v_1", "name": "No work stuff", "filter": { … } } ]
}
```

Four things in there exist to absorb change rather than to be used today:

- **`fields`** on nodes and edges is an untyped key/value bag. Write whatever
  you want into it; the `field` filter operator can already query it.
- **`content`** is an ordered list of typed blocks. The type is a registry key,
  so an unknown type survives a round-trip instead of being dropped.
- **`tagTypes` / `edgeTypes` / `statusTypes`** are data, not enums. `work` and
  `personal` are seeds in the starter map, not constants in the code.
- **`version`** plus the migration chain in `model.js` means an old file can
  always be opened.

`normalizeDocument()` is deliberately forgiving. A file you hand-edited opens
with whatever is salvageable and reports the rest, rather than refusing.

### 2. All change goes through the store

`core/store.js` owns the document. `update(label, mutator)` clones it, lets the
mutator edit the clone, keeps the old copy for undo, and notifies subscribers.
Nothing mutates the live document in place.

This is what buys, with no extra machinery:

- undo/redo, with a coalescing window so a drag is one step
- autosave, because "the document changed" is a real event
- panels that re-render from state rather than patching themselves

Snapshots rather than patches is a size/simplicity trade: it is fine for maps
with thousands of nodes and it makes the undo stack impossible to get wrong. If
your maps grow past the point where that is comfortable, `update()` is the one
function that has to change.

The one exception is live node dragging, which writes positions directly for
the duration of the drag and then restores and commits them properly on
pointer-up. That is an explicit performance concession, and it is confined to
`canvas.js`.

### 3. Filtering is one language, used everywhere

`core/query.js` defines a filter as a JSON tree:

```js
{ op: 'and', clauses: [
    { op: 'anyTag', tags: ['work'] },
    { op: 'not', clause: { op: 'status', status: 'done' } },
    { op: 'within', node: 'n_ab12', depth: 2, direction: 'any' },
]}
```

Every filtering surface — label chips, the status picker, the focus controls,
the search box, the query builder — compiles down to this. `buildEffectiveFilter()`
in `ui/viewstate.js` folds them together with AND. There is no second code path
that hides nodes, which is why "why is this node not showing?" always has one
answer.

Operators live in the `filterOps` registry. Each one declares:

- `build(spec, ctx)` → a predicate over nodes
- `describe(spec, ctx)` → a human-readable phrase
- `fields` → enough of a schema for the query builder to draw its own UI

Because `fields` drives the UI, registering an operator gives it a working
editor row for free.

Relationship operators (`within`, `descendants`, `ancestors`, `connected`)
resolve their node set once, at compile time, from the `GraphIndex`; the
predicate is then a Set lookup. That is why focus filters stay fast on a large
map.

## Where state lives, and why

| State | Lives in | Reason |
| --- | --- | --- |
| Nodes, edges, labels, saved views | the document | it is your data |
| Camera, selection, the active filter | `ui/viewstate.js` + localStorage | panning is not an edit |
| Undo history | the store, in memory | scoped to the session |
| The file handle | IndexedDB | so a reload can reconnect to the same file |

Autosave to localStorage is a crash net, not the artefact. The file on disk is
the artefact. The toolbar always says which of the two you are relying on.

## Rendering

Node cards are HTML; edges are one overflowing SVG layer behind them. Both sit
inside a single `.viewport` div, so the camera is one CSS transform and world
coordinates never need converting except for pointer input.

The split exists because text is the hard part: wrapped titles, tag chips and
checkboxes are trivial in HTML and painful in SVG, while lines and arrowheads
are the reverse.

Re-render is whole-panel and debounced to an animation frame. Node elements are
reused by id so dragging does not thrash the DOM. This is not the fastest
possible design; it is the one where a change to state cannot leave the screen
showing something else.
