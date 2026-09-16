# Roadmap

Where the things you already know you want would land, and what each one
actually costs. Nothing here is scheduled — it exists so that when you decide
you want one of them, the decision is about the feature and not about
archaeology.

## Shipped

| Want | Where it lives |
| --- | --- |
| Quick node creation and linking | double-click, `Tab`, `Ctrl`+`K`, drag-to-link |
| Customisable labels, not a fixed work/personal split | `doc.tagTypes`; create and recolour from the filter panel |
| Include/exclude filtering | label chips cycle neutral → require → exclude |
| Relationship filtering | Focus: within N links, everything under, everything above, same cluster |
| To-do / done | `doc.statusTypes`; `t` cycles, and statuses are themselves extensible |
| Compound queries | the Query section: AND/OR, per-row NOT, plus a raw JSON editor |
| Rich node content | markdown, plain text, link, file reference, code, LaTeX blocks |
| Structured data on a node | `node.fields`, queryable with the `field` condition |
| Saved filters | `doc.views` — "No work stuff" is two clicks and stays |

## Next, in rough order of value per unit of work

### Typed fields

`node.fields` is currently string-to-string, edited as text. The step up is a
schema per key — number, date, enum, node reference — declared in the document
so the inspector can draw the right input and `field` comparisons can be
type-aware. Put the declarations in `doc.fieldTypes` alongside `tagTypes`, and
add an editor field type in `FilterPanel.renderField`. Nothing in the document
format has to change.

### Nested query groups in the UI

The filter *language* already nests arbitrarily — `{op:'or', clauses:[{op:'and', …}]}`
works today via the JSON editor. Only the builder is flat. Making
`renderClause` recurse when it meets an `and`/`or` clause is the whole job.

### Auto-layout, on request only

Positions are yours and nothing moves on its own; that is deliberate. But a
"tidy these ten nodes" button — force-directed or a tree layout applied to the
current selection — is compatible with that, as long as it is a command you
invoke and can undo.

### Better edge routing

Straight lines with fan-out for parallel edges get crowded past a few hundred
nodes. Orthogonal or curved routing with basic obstacle avoidance would be a
self-contained change inside `Canvas.edgeGeometry`.

### Transclusion

`[[wiki links]]` already navigate. Rendering a block that *shows* another
node's content rather than linking to it is a new content type (`{type:
'transclude', value: nodeId}`) and roughly twenty lines, with the caveat that
you need a cycle guard.

## The filesystem overlay

This is the ambition worth being precise about, because a browser page can do
part of it and not the rest.

**What is already useful:** the `file` content block records a path. Every note
that mentions a file is then a text search away, and "show me every node
referring to this path" is `{op:'text', query:'/path/to/thing'}` — or a
dedicated `filePath` operator if you want it exact.

**What a browser cannot do:** enumerate your disk, watch for changes, or follow
a `file://` link from a page served over http. Those are not missing features,
they are the sandbox.

**What closes most of the gap:** the File System Access API's directory picker.
Granting the page access to a folder — once, explicitly — gives it the ability
to walk that tree, read files, and write to them. That is enough for:

- a command that scans a chosen folder and creates a node per file, tagged with
  its extension, positioned by directory
- opening a file's contents into a node's content blocks
- keeping a `fields.path` on those nodes so a re-scan can reconcile renames
  instead of duplicating

It is Chromium-only today, it needs re-granting per session, and it will never
see anything outside the folder you picked. Whether that is the tool you
described or a disappointing imitation of it is a real question, and the
honest answer is that you will only know once you have tried it on one of your
actual project folders. `persistence.js` already uses the same API for single
files, so the groundwork is there.

**The other half of the idea** — notes that refer to files, and seeing all
notes that refer to a given file — needs none of that, and works today.

## Deliberately not planned

- **Sync, accounts, a server.** The file is the artefact. Put it in a folder
  that syncs, or in git.
- **Real-time collaboration.** It would reshape the store from snapshots to
  operations, which is a different project.
- **A build step,** until the absence of one actually hurts. Right now a change
  costs a reload, and that is the property keeping this thing easy to bend.
