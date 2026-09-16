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
| Real file access | the desktop build — open a file in its own program, browse folders |
| Portable file links | named roots plus per-machine alternates, `core/locators.js` |
| Notes that refer to files | the `file` block and the `filePath` condition |
| A node per file in a folder | Import folder… |

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

This was the ambition worth being precise about, and most of it now works.

**What works today.** The desktop build reads and writes any path your user
account can. A file reference records every place a file lives; a green dot
means it is on this machine and the "open" button hands it to whatever program
owns it. "Import folder…" turns a directory into a neighbourhood of the map,
which is the part a directory tree cannot do — from there a file can be linked
to anything, and gain a second association later without moving.

"Every note that mentions this file" is the `filePath` condition, and it
searches every recorded location, not just the ones that resolve here — so a
file that only exists on the other laptop still turns up the note about it.

**What is still genuinely out of reach.** Watching the filesystem for changes,
and following a file link from a browser tab. The first is a real feature that
nobody has built here yet (a Rust file watcher emitting events would do it); the
second is the browser sandbox and always will be.

**What is left to design.** Reconciliation. Right now a re-import skips files
already referenced, so it will not duplicate, but it also will not notice a
rename, a move, or a deletion. The pieces are in place — `node.importFiles`
already writes `fields.source`, and `file_meta` returns size and mtime — but the
policy is not: when a file vanishes, is that a node to delete, a node to mark,
or a node to leave alone because the file is merely on a disk you have not
plugged in? The last one is why this is a design question rather than a bug.

## Sync, and the conflict you will eventually hit

Export/import through a cloud drive works today: the map is one JSON file, so
keep it in the synced folder. The failure mode is editing on two machines before
the drive catches up, which leaves one side's edits in a "conflicted copy" file
rather than merging them.

The cheap fix worth doing first is a revision counter plus a check that the file
on disk has not changed since it was loaded, so an overwrite becomes a prompt
instead of a silent loss. The real fix, if it keeps happening, is a file per
node — most conflicts then become non-overlapping writes that sync tools handle
by themselves. That is a format change, and the time to make it is when it
starts hurting. [PLATFORMS.md](PLATFORMS.md) has the longer version.

## Mobile

The native shell has iOS and Android targets and the mobile entry point is in
place, but **nothing has been built or run** — see
[PLATFORMS.md](PLATFORMS.md#mobile). Two things need designing rather than
porting: file locators, since phones use content URIs rather than paths, and
touch, since drag-to-link and a keyboard-first capture flow have no obvious
finger equivalent.

## Deliberately not planned

- **Sync, accounts, a server.** The file is the artefact. Put it in a folder
  that syncs, or in git. Conflict *handling* is worth improving; a sync service
  is not.
- **Real-time collaboration.** It would reshape the store from snapshots to
  operations, which is a different project.
- **A build step for the frontend,** until the absence of one actually hurts.
  A change still costs a reload, in the browser and in the native window alike,
  and that is the property keeping this thing easy to bend.
