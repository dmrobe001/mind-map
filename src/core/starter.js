/**
 * The map you get on first run.
 *
 * It is a real map about the tool itself rather than lorem ipsum, so the first
 * thing you do is read something useful, and deleting it costs one Ctrl+A and
 * one Delete.
 */

import { createDocument, createNode, createEdge, createTagType, createBlock } from './model.js';

export function createStarterDocument() {
  const doc = createDocument({ title: 'Getting started' });

  doc.tagTypes = {
    work: createTagType('work', { id: 'work', color: '#5b8def' }),
    personal: createTagType('personal', { id: 'personal', color: '#4aa96c' }),
    reference: createTagType('reference', { id: 'reference', color: '#b07cd6' }),
  };

  const add = (props) => {
    const node = createNode(props);
    doc.nodes[node.id] = node;
    return node.id;
  };
  const link = (from, to, type = 'child') => {
    const edge = createEdge({ from, to, type });
    doc.edges[edge.id] = edge;
    return edge.id;
  };

  const root = add({
    title: 'This map',
    summary: 'Drag me. Double-click the background to add a node.',
    x: 0,
    y: 0,
    tags: ['reference'],
    content: [createBlock({
      type: 'markdown',
      value: [
        'Everything here is an ordinary node. Delete it all when you are done reading.',
        '',
        '- **Link two nodes** by dragging the dot on a card\'s right edge onto another card.',
        '- **Add a child** with `Tab` while a node is selected.',
        '- **Find anything** with `Ctrl`+`K`.',
      ].join('\n'),
    })],
  });

  const capture = add({
    title: 'Quick capture',
    summary: 'Ctrl+K, type a name, Shift+Enter.',
    x: -300,
    y: 160,
    content: [createBlock({
      type: 'markdown',
      value: 'If the quick switcher finds nothing, Enter creates a node with what you typed.\n\n'
        + 'A thought you cannot file in five seconds is a thought you will not file.',
    })],
  });

  const filtering = add({
    title: 'Filtering',
    summary: 'Labels, status, focus, and compound queries.',
    x: 0,
    y: 200,
    tags: ['reference'],
    content: [createBlock({
      type: 'markdown',
      value: [
        'Label chips cycle **neutral → require → exclude**, so hiding everything tagged',
        '`work` is two clicks.',
        '',
        'Focus does the relationship filters: everything within N links of a node,',
        'everything under it, everything above it, or its whole cluster.',
        '',
        'The Query section stacks conditions with AND/OR and a per-row NOT, and drops',
        'to raw JSON when you need nesting.',
      ].join('\n'),
    })],
  });

  const labels = add({
    title: 'Labels are yours',
    summary: 'work / personal are just two examples.',
    x: -260,
    y: 380,
    tags: ['work', 'personal'],
  });

  const focusDemo = add({
    title: 'Relationship filters',
    summary: 'Select a node, then "use selected" under Focus.',
    x: 250,
    y: 380,
    tags: ['reference'],
  });

  const todo = add({
    title: 'Try marking this done',
    summary: 'Press t, or click the dot on the card.',
    x: 330,
    y: 170,
    status: 'todo',
  });

  const content = add({
    title: 'Node contents',
    summary: 'Markdown, links, code, files, LaTeX.',
    x: 320,
    y: -140,
    tags: ['reference'],
    content: [
      createBlock({ type: 'markdown', label: 'notes', value: 'Blocks stack up inside a node.\n\n> Anything the app does not recognise is kept as-is on save.' }),
      createBlock({ type: 'link', label: 'somewhere useful', value: 'https://example.com' }),
      createBlock({
        type: 'file',
        label: 'a file on disk',
        // Relative to the "Cloud drive" root, so it resolves on every machine
        // that has pointed that root somewhere. Toolbar → Roots… sets it.
        value: 'notes/reading-list.md',
        meta: { root: 'sync' },
      }),
    ],
  });

  const fields = add({
    title: 'Structured fields',
    summary: 'Arbitrary key/value data, queryable.',
    x: 40,
    y: -200,
    fields: { source: 'manual', priority: '2' },
  });

  const files = add({
    title: 'Files live where they live',
    summary: 'One reference, several locations.',
    x: 560,
    y: 40,
    tags: ['reference'],
    content: [createBlock({
      type: 'markdown',
      value: [
        'A file reference holds every place that file exists. A location recorded',
        'relative to a **named root** resolves on every machine that has mapped that',
        'root; an absolute one only works where it was recorded.',
        '',
        'The dot says which: green is here, red is missing, hollow means this machine',
        'has never been told where that root is.',
        '',
        'In a browser tab paths are recorded but inert. The desktop build opens them.',
      ].join('\n'),
    })],
  });

  const graph = add({
    title: 'It is a graph, not a tree',
    summary: 'Draw a second line whenever something gains a new meaning.',
    x: -330,
    y: -110,
    content: [createBlock({
      type: 'markdown',
      value: 'Nothing has to move to gain a new association. Add the edge and keep both.',
    })],
  });

  link(root, capture);
  link(root, filtering);
  link(root, content);
  link(root, graph);
  link(filtering, labels);
  link(filtering, focusDemo);
  link(content, fields);
  link(content, files);
  link(capture, todo);
  link(graph, filtering, 'relates');
  link(fields, filtering, 'references');

  doc.views = [
    { id: 'v_open', name: 'Open to-dos', filter: { quick: { include: [], exclude: [], status: 'todo' }, advanced: null, search: '' } },
    { id: 'v_nowork', name: 'No work stuff', filter: { quick: { include: [], exclude: ['work'], status: 'all' }, advanced: null, search: '' } },
  ];

  return doc;
}
