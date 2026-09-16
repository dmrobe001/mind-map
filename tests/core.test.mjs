/**
 * Tests for the parts that have no DOM: the document model, the graph index
 * and the filter language.
 *
 * Runs on node's built-in runner with nothing installed:
 *
 *   node --test
 *
 * The UI is deliberately not covered here — it would need a browser, and a
 * dependency, and this project is trying not to have either.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDocument, createNode, createEdge, normalizeDocument, migrate, SCHEMA_VERSION } from '../src/core/model.js';
import { GraphIndex } from '../src/core/graph.js';
import { selectNodes, selectEdges, describeFilter, compileFilter } from '../src/core/query.js';
import { Store } from '../src/core/store.js';
import { runCommand } from '../src/core/commands.js';
import { renderMarkdown, escapeHtml, firstLine } from '../src/content/markdown.js';

/* ------------------------------------------------------------------ *
 * A small fixture: a → b → d, a → c, plus a non-hierarchical b ~ c.
 * ------------------------------------------------------------------ */

function fixture() {
  const doc = createDocument({ title: 'test' });
  const put = (id, props) => {
    doc.nodes[id] = createNode({ id, ...props });
  };
  put('a', { title: 'Alpha', tags: ['work'] });
  put('b', { title: 'Beta', tags: ['work', 'urgent'], status: 'todo' });
  put('c', { title: 'Gamma', tags: ['personal'] });
  put('d', { title: 'Delta', status: 'done', fields: { priority: '3' } });
  put('e', { title: 'Lonely Epsilon' });

  doc.edges.e1 = createEdge({ id: 'e1', from: 'a', to: 'b', type: 'child' });
  doc.edges.e2 = createEdge({ id: 'e2', from: 'b', to: 'd', type: 'child' });
  doc.edges.e3 = createEdge({ id: 'e3', from: 'a', to: 'c', type: 'child' });
  doc.edges.e4 = createEdge({ id: 'e4', from: 'b', to: 'c', type: 'relates' });
  return doc;
}

const ctxFor = (doc) => ({ doc, graph: new GraphIndex(doc) });
const ids = (set) => [...set].sort().join(',');
const matching = (spec, doc) => ids(selectNodes(spec, ctxFor(doc)));

/* ------------------------------------------------------------------ *
 * Graph
 * ------------------------------------------------------------------ */

test('reach respects hop limits', () => {
  const graph = new GraphIndex(fixture());
  assert.equal(ids(new Set(graph.reach(['a'], { depth: 1 }).keys())), 'a,b,c');
  assert.equal(ids(new Set(graph.reach(['a'], { depth: 2 }).keys())), 'a,b,c,d');
  assert.equal(graph.reach(['a'], { depth: 2 }).get('d'), 2);
});

test('an undirected edge is walkable from both ends', () => {
  const graph = new GraphIndex(fixture());
  // e4 (relates) is undirected, so c can be reached from b following 'out'.
  const fromB = graph.reach(['b'], { depth: 1, direction: 'out' });
  assert.ok(fromB.has('c'));
  const fromC = graph.reach(['c'], { depth: 1, direction: 'out' });
  assert.ok(fromC.has('b'));
});

test('descendants and ancestors follow only hierarchical types', () => {
  const graph = new GraphIndex(fixture());
  // c is a child of a, but its link to b is 'relates', so it is not under b.
  assert.equal(ids(new Set(graph.descendants('b').keys())), 'd');
  assert.equal(ids(new Set(graph.ancestors('d').keys())), 'a,b');
  assert.equal(ids(new Set(graph.descendants('a', { includeSelf: true }).keys())), 'a,b,c,d');
});

test('orphans finds unlinked nodes', () => {
  assert.deepEqual(new GraphIndex(fixture()).orphans(), ['e']);
});

test('degree counts both directions', () => {
  const graph = new GraphIndex(fixture());
  assert.equal(graph.degree('a'), 2);
  assert.equal(graph.degree('b'), 3);
  assert.equal(graph.degree('e'), 0);
});

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

test('tag filters include and exclude', () => {
  const doc = fixture();
  assert.equal(matching({ op: 'tag', tag: 'work' }, doc), 'a,b');
  assert.equal(matching({ op: 'not', clause: { op: 'anyTag', tags: ['work'] } }, doc), 'c,d,e');
  assert.equal(matching({ op: 'allTags', tags: ['work', 'urgent'] }, doc), 'b');
  assert.equal(matching({ op: 'untagged' }, doc), 'd,e');
});

test('status filters distinguish none, any and specific', () => {
  const doc = fixture();
  assert.equal(matching({ op: 'status', status: 'todo' }, doc), 'b');
  assert.equal(matching({ op: 'status', status: 'any' }, doc), 'b,d');
  assert.equal(matching({ op: 'status', status: 'none' }, doc), 'a,c,e');
});

test('and / or / not compose', () => {
  const doc = fixture();
  const spec = {
    op: 'and',
    clauses: [
      { op: 'anyTag', tags: ['work'] },
      { op: 'not', clause: { op: 'status', status: 'todo' } },
    ],
  };
  assert.equal(matching(spec, doc), 'a');
  assert.equal(matching({ op: 'or', clauses: [{ op: 'tag', tag: 'personal' }, { op: 'status', status: 'done' }] }, doc), 'c,d');
});

test('relationship filters resolve against the graph', () => {
  const doc = fixture();
  assert.equal(matching({ op: 'within', node: 'a', depth: 1 }, doc), 'a,b,c');
  assert.equal(matching({ op: 'within', node: 'a', depth: 1, includeSelf: false }, doc), 'b,c');
  assert.equal(matching({ op: 'descendants', node: 'a', includeSelf: true }, doc), 'a,b,c,d');
  // Relationship filters keep the anchor by default: focusing on a node and
  // then not seeing it would be nonsense. GraphIndex.ancestors() defaults the
  // other way, because there the caller usually wants strictly-above.
  assert.equal(matching({ op: 'ancestors', node: 'd' }, doc), 'a,b,d');
  assert.equal(matching({ op: 'ancestors', node: 'd', includeSelf: false }, doc), 'a,b');
  assert.equal(matching({ op: 'connected', node: 'a' }, doc), 'a,b,c,d');
  assert.equal(matching({ op: 'orphan' }, doc), 'e');
});

test('within can be restricted to particular edge types', () => {
  const doc = fixture();
  assert.equal(
    matching({ op: 'within', node: 'c', depth: 1, edgeTypes: ['relates'], includeSelf: false }, doc),
    'b',
  );
});

test('field conditions compare structured data', () => {
  const doc = fixture();
  assert.equal(matching({ op: 'field', key: 'priority', cmp: 'eq', value: '3' }, doc), 'd');
  assert.equal(matching({ op: 'field', key: 'priority', cmp: 'exists' }, doc), 'd');
  assert.equal(matching({ op: 'field', key: 'priority', cmp: 'gt', value: 2 }, doc), 'd');
});

test('text search covers title, summary, content and fields', () => {
  const doc = fixture();
  doc.nodes.a.content = [{ id: 'b1', type: 'markdown', value: 'a needle in here' }];
  assert.equal(matching({ op: 'text', query: 'needle' }, doc), 'a');
  assert.equal(matching({ op: 'text', query: 'epsilon' }, doc), 'e');
});

test('an unknown operator matches everything rather than throwing', () => {
  const doc = fixture();
  assert.equal(matching({ op: 'no-such-op' }, doc), 'a,b,c,d,e');
});

test('an edge survives only when both endpoints do', () => {
  const doc = fixture();
  const nodes = selectNodes({ op: 'descendants', node: 'a', includeSelf: true }, ctxFor(doc));
  assert.equal(ids(selectEdges(nodes, doc)), 'e1,e2,e3,e4');
  const narrow = selectNodes({ op: 'tag', tag: 'work' }, ctxFor(doc));
  assert.equal(ids(selectEdges(narrow, doc)), 'e1');
});

test('filters describe themselves', () => {
  const doc = fixture();
  const text = describeFilter({
    op: 'and',
    clauses: [{ op: 'tag', tag: 'work' }, { op: 'not', clause: { op: 'status', status: 'done' } }],
  }, ctxFor(doc));
  assert.equal(text, '#work AND NOT (Done)');
});

test('a compiled filter is a plain predicate', () => {
  const doc = fixture();
  const predicate = compileFilter({ op: 'tag', tag: 'work' }, ctxFor(doc));
  assert.equal(predicate(doc.nodes.a), true);
  assert.equal(predicate(doc.nodes.c), false);
});

/* ------------------------------------------------------------------ *
 * Model
 * ------------------------------------------------------------------ */

test('an unversioned document migrates to the current schema', () => {
  assert.equal(migrate({ nodes: {}, edges: {} }).version, SCHEMA_VERSION);
});

test('normalize drops edges whose endpoints are missing', () => {
  const { doc, problems } = normalizeDocument({
    version: 1,
    nodes: { a: { id: 'a', title: 'A' } },
    edges: { bad: { id: 'bad', from: 'a', to: 'ghost' } },
  });
  assert.deepEqual(Object.keys(doc.edges), []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ghost|isn't in the file/);
});

test('normalize declares tags that only appear on nodes', () => {
  const { doc } = normalizeDocument({
    version: 1,
    nodes: { a: { id: 'a', title: 'A', tags: ['undeclared'] } },
    edges: {},
  });
  assert.ok(doc.tagTypes.undeclared, 'an undeclared tag should still be filterable');
});

test('unknown block types and extra fields survive a round trip', () => {
  const { doc } = normalizeDocument({
    version: 1,
    nodes: {
      a: {
        id: 'a',
        title: 'A',
        content: [{ id: 'b1', type: 'from-the-future', value: 'keep me' }],
        fields: { anything: 'goes' },
      },
    },
    edges: {},
  });
  assert.equal(doc.nodes.a.content[0].type, 'from-the-future');
  assert.equal(doc.nodes.a.content[0].value, 'keep me');
  assert.equal(doc.nodes.a.fields.anything, 'goes');
});

test('a garbage file yields an empty document rather than an exception', () => {
  const { doc, problems } = normalizeDocument('not an object');
  assert.equal(Object.keys(doc.nodes).length, 0);
  assert.equal(problems.length, 1);
});

/* ------------------------------------------------------------------ *
 * Store and commands
 * ------------------------------------------------------------------ */

test('undo and redo walk the history', () => {
  const store = new Store(fixture());
  const id = runCommand('node.add', store, { title: 'New one', x: 5, y: 5 });
  assert.equal(Object.keys(store.doc.nodes).length, 6);
  store.undo();
  assert.equal(Object.keys(store.doc.nodes).length, 5);
  store.redo();
  assert.equal(store.doc.nodes[id].title, 'New one');
});

test('deleting a node takes its edges with it', () => {
  const store = new Store(fixture());
  runCommand('node.delete', store, { ids: ['b'] });
  assert.deepEqual(Object.keys(store.doc.edges).sort(), ['e3']);
});

test('coalesced updates collapse into one undo step', () => {
  const store = new Store(fixture());
  for (let i = 0; i < 10; i += 1) {
    runCommand('node.move', store, { positions: { a: { x: i, y: i } } });
  }
  assert.equal(store.doc.nodes.a.x, 9);
  store.undo();
  assert.equal(store.doc.nodes.a.x, 0, 'a drag should undo in one step');
});

test('toggling a tag adds it everywhere if any node lacks it', () => {
  const store = new Store(fixture());
  runCommand('node.toggleTag', store, { ids: ['a', 'c'], tag: 'work' });
  assert.ok(store.doc.nodes.a.tags.includes('work'));
  assert.ok(store.doc.nodes.c.tags.includes('work'));
  runCommand('node.toggleTag', store, { ids: ['a', 'c'], tag: 'work' });
  assert.ok(!store.doc.nodes.a.tags.includes('work'));
});

test('status cycles through the declared types and back to none', () => {
  const store = new Store(fixture());
  runCommand('node.cycleStatus', store, { ids: ['a'] });
  assert.equal(store.doc.nodes.a.status, 'todo');
  runCommand('node.cycleStatus', store, { ids: ['a'] });
  assert.equal(store.doc.nodes.a.status, 'done');
  runCommand('node.cycleStatus', store, { ids: ['a'] });
  assert.equal(store.doc.nodes.a.status, null);
});

test('adding a duplicate link returns the existing one', () => {
  const store = new Store(fixture());
  const again = runCommand('edge.add', store, { from: 'a', to: 'b', type: 'child' });
  assert.equal(again, 'e1');
  assert.equal(Object.keys(store.doc.edges).length, 4);
});

test('an undirected duplicate is caught in either orientation', () => {
  const store = new Store(fixture());
  const again = runCommand('edge.add', store, { from: 'c', to: 'b', type: 'relates' });
  assert.equal(again, 'e4');
});

test('a node cannot link to itself', () => {
  const store = new Store(fixture());
  assert.equal(runCommand('edge.add', store, { from: 'a', to: 'a' }), null);
});

test('the store never hands out the document it is about to replace', () => {
  const store = new Store(fixture());
  const before = store.doc;
  runCommand('node.update', store, { id: 'a', patch: { title: 'Changed' } });
  assert.equal(before.nodes.a.title, 'Alpha', 'the previous snapshot must stay intact');
  assert.equal(store.doc.nodes.a.title, 'Changed');
});

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

test('html in content is escaped, not executed', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('dangerous link schemes are neutralised', () => {
  const html = renderMarkdown('[click](javascript:alert(1))');
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('href="#"'));
});

test('ordinary markdown renders', () => {
  const html = renderMarkdown('# Title\n\n- one\n- two\n\n**bold** and `code`');
  assert.ok(html.includes('<h1>Title</h1>'));
  assert.ok(html.includes('<li>one</li>'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<code>code</code>'));
});

test('code spans are not reprocessed as markup', () => {
  const html = renderMarkdown('`**not bold**`');
  assert.ok(html.includes('<code>**not bold**</code>'));
});

test('task list items become checkboxes', () => {
  const html = renderMarkdown('- [x] done\n- [ ] not done');
  assert.ok(html.includes('checked'));
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2);
});

test('wiki links carry the target title', () => {
  const html = renderMarkdown('see [[Some Node]]');
  assert.ok(html.includes('data-node-title="Some Node"'));
});

test('escapeHtml and firstLine behave', () => {
  assert.equal(escapeHtml('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
  assert.equal(firstLine('\n\n# A heading\nmore'), 'A heading');
  assert.equal(firstLine('x'.repeat(200), 20).length, 20);
});
