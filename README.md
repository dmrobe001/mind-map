# mind-map

A browser-based mind map editor and viewer. Local-only, serverless, no build step.

## Why this exists

Directory trees don't work for everyone. You create a folder in the place that makes
sense *today*, and six months later the thing you filed has taken on a second identity
and you can't find it. A tree forces one parent; reality has many.

This is a place to **drop things next to the topic they're relevant to**, spatially, so
your memory has something to grab onto — and to **draw a new line later** when something
gains a new association, without moving or copying anything.

Design consequences of that goal:

- **A graph, not a tree.** Any node can link to any node. Hierarchy is just one kind of
  edge among several, not the structure of the data.
- **Position is meaningful.** Node coordinates are saved. Where you put something is part
  of how you remember it, so nothing silently re-arranges itself.
- **Additive, never destructive.** New connections are new edges. You don't have to give
  up the old association to record a new one.
- **Everything is filterable.** With many overlapping associations in one map, the ability
  to hide what you're not thinking about right now is the feature that makes the rest
  usable.

## Status

Early. The data model and the extension points are the parts designed to last; the UI is
expected to churn as the tool finds its shape.

## Principles

1. **Local-only and serverless.** Static files. No account, no sync service, no backend.
   Your map is a JSON file on your disk.
2. **Your data outlives this app.** The document format is plain, versioned JSON that is
   readable and diffable without the app. Export is not an afterthought.
3. **Extensible by design.** Filters, content types, and commands are registries. Adding a
   capability should mean registering a function, not editing the renderer.
4. **Room to grow.** Nodes and edges carry a free-form `fields` object so structured data
   can be attached before the app knows what to do with it.

## Roadmap sketch

Known wants, roughly in the order they matter:

- [ ] Fast node creation and linking, keyboard-first
- [ ] Customizable labels/tags with include/exclude filtering
- [ ] Relationship filters — children of X, everything within N links of X
- [ ] To-do / done state on nodes
- [ ] Compound queries: multiple conditions, AND/OR/NOT
- [ ] Rich node content — markdown, links, LaTeX
- [ ] Structured fields on nodes
- [ ] References to files on the local filesystem, and a view of every note touching a file

## License

MIT. See [LICENSE](LICENSE).
