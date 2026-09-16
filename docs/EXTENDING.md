# Extending it

Four recipes, roughly in order of how often you will reach for them. All of
them are additive: register something, add one import, reload.

---

## 1. A new filter condition

Say you want "changed in the last N days".

```js
// src/core/query.js, or your own file imported from src/main.js
import { filterOps } from './registry.js';

filterOps.register('recent', {
  label: 'changed within',
  category: 'attribute',
  order: 35,
  // `fields` is all the query builder needs to draw an editor for this.
  fields: [{ key: 'days', type: 'number', label: 'days', default: 7, min: 1 }],
  build: (spec) => {
    const cutoff = Date.now() - Number(spec.days ?? 7) * 86400000;
    return (node) => new Date(node.updated).getTime() >= cutoff;
  },
  describe: (spec) => `changed in the last ${spec.days ?? 7} days`,
});
```

It now appears in the "+ add condition" menu, works in saved views, and
round-trips through the JSON editor. Nothing else changes.

Field types the builder knows: `text`, `number`, `boolean`, `select` (with
`options`), `tag`, `tagList`, `status`, `node`, `edgeTypeList`. Add another by
extending the `switch` in `FilterPanel.renderField`.

**If your operator needs the graph**, resolve the set once in `build` and close
over it — see `within` and `descendants` in `query.js`. `ctx.graph` is a
`GraphIndex`; `ctx.doc` is the document.

---

## 2. A new kind of node content

Content blocks are `{ id, type, value, label }`. The `type` is a registry key.

```js
// src/content/renderers.js
import { contentRenderers } from '../core/registry.js';

contentRenderers.register('checklist', {
  label: 'Checklist',
  order: 7,
  editor: 'textarea',        // or 'line' for a single-line input
  placeholder: 'One item per line',
  hint: 'Shown as a list; prefix a line with x to tick it.',
  render: (block) => {
    const list = document.createElement('ul');
    list.className = 'block-body';
    for (const line of String(block.value).split('\n').filter(Boolean)) {
      const done = /^x\s+/i.test(line);
      const item = document.createElement('li');
      item.textContent = done ? line.slice(2) : line;
      if (done) item.style.textDecoration = 'line-through';
      list.append(item);
    }
    return list;
  },
  preview: (block) => block.value.split('\n')[0],   // used on the card
});
```

`render` must return a DOM node and must never set `innerHTML` from block
content without escaping it first — see `escapeHtml` in `content/markdown.js`.
Blocks are user data, and user data becomes someone else's data as soon as you
share a map file.

A block whose type is not registered still saves and loads correctly; it is
shown as raw text with a note. That is deliberate, so an old build never eats
data written by a newer one.

---

## 3. A new command

Commands are the app's verbs: named, undoable, argument objects only. Keyboard
shortcuts and buttons both go through `runCommand`, so a new verb is available
everywhere at once.

```js
// src/core/commands.js
define('node.duplicate', 'Duplicate node', (store, { id }) => {
  const source = store.doc.nodes[id];
  if (!source) return null;
  const copy = createNode({ ...source, id: undefined, x: source.x + 40, y: source.y + 40 });
  store.update('Duplicate node', (doc) => { doc.nodes[copy.id] = copy; });
  return copy.id;
});
```

Rules of thumb:

- One `store.update` per user-visible action, so one undo step per action.
- Pass `{ coalesceKey }` for anything fired continuously (typing, dragging).
- Return the id of anything created; callers usually want to select it.
- Return `false` from the mutator to decline the change without touching
  history.

To bind it to a key, add a case in `App.onKeyDown` in `src/ui/app.js`.

---

## 4. A new edge type

No code required — the inspector's "Edge types" section creates them, and
`edgeType.create` is a command. What matters is the `hierarchical` flag:

```js
{ id: 'blocks', label: 'blocks', directed: true, hierarchical: false, color: '#d9636b' }
```

Types marked `hierarchical: true` are the ones the "everything under" and
"everything above" filters walk. Several types can be hierarchical at once, and
the `within` filter can be restricted to any subset of types, so "two links
away, but only following `references`" is expressible today.

---

---

## 5. A new environment

If you later want the local-helper-process approach, or a mobile build, you do
not touch the UI. Implement `src/platform/platform.js`:

```js
import { Platform } from './platform.js';

export class HelperPlatform extends Platform {
  constructor() {
    super();
    this.id = 'helper';
    this.label = 'The local helper';
    this.can = { ...this.can, realPaths: true, openExternally: true, browseDirectories: true };
  }

  async listDir(path) {
    return (await fetch(`http://127.0.0.1:7777/dir?path=${encodeURIComponent(path)}`)).json();
  }
  // …and the rest.
}
```

Then add it to the check in `src/platform/index.js`. The UI is already written
against `platform.can.*`, so features light up on their own.

Two rules:

- **Report capabilities honestly.** Claiming `openExternally` you cannot deliver
  produces a button that fails when pressed, which is worse than no button.
- **Never let paths leak into the document.** Anything machine-specific belongs
  in `readSettings`/`writeSettings`. See `core/locators.js`.

---

## Optional: LaTeX with KaTeX

The `latex` block type renders with KaTeX when `globalThis.katex` exists and
falls back to showing the source otherwise. To turn it on without giving up
working offline, vendor it:

1. Download the KaTeX release and put it in `vendor/katex/`.
2. Add to `index.html`, before `src/main.js`:

   ```html
   <link rel="stylesheet" href="vendor/katex/katex.min.css">
   <script defer src="vendor/katex/katex.min.js"></script>
   ```

`vendor/` is not in `.gitignore`, so you can commit it if you want the map and
its renderer to travel together.

---

## Things worth not doing

- **Don't mutate `store.doc` directly.** Undo, autosave and re-render all hang
  off `store.update`. The one existing exception is live drag in `canvas.js`,
  and it restores the original values before committing.
- **Don't add a second way to hide nodes.** If something should be filterable,
  make it a filter operator. One code path is the reason the filter count in
  the panel can be trusted.
- **Don't put view state in the document.** Camera and selection belong in
  `viewstate.js`; otherwise every pan marks the file dirty.
- **Don't reach for a framework before you need one.** The whole point of the
  no-build setup is that a change costs a reload. That is worth more than it
  looks when you are still working out what the tool is.
- **Don't import `@tauri-apps/api` in the frontend.** It would need a bundler,
  and the same files would stop running in a plain browser tab. The native
  adapter goes through the global `invoke`; new native capabilities are new
  `#[tauri::command]`s in `src-tauri/src/lib.rs` plus a method on the adapter.
- **Don't write an absolute path into the document without a locator.** It will
  be dead the first time the map is opened anywhere else.
