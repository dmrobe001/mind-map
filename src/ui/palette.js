/**
 * Quick switcher.
 *
 * The point of the whole tool is being able to find the thing again, so this
 * is deliberately the shortest path to any node: one chord, type a few
 * letters, Enter. If nothing matches, Enter creates a node with what you typed
 * as its title, so a search that fails turns straight into capture.
 */

import { runCommand } from '../core/commands.js';
import { searchableText } from '../core/query.js';
import { h } from './filterpanel.js';

/** Subsequence match, so "mtg nts" finds "Meeting notes". */
function fuzzyScore(needle, haystack) {
  if (!needle) return 0;
  const target = haystack.toLowerCase();
  const query = needle.toLowerCase();
  const direct = target.indexOf(query);
  if (direct === 0) return 1000;
  if (direct > 0) return 800 - direct;

  let score = 0;
  let index = 0;
  let streak = 0;
  for (const char of query) {
    const found = target.indexOf(char, index);
    if (found === -1) return -1;
    streak = found === index ? streak + 1 : 0;
    score += 10 + streak * 5 - Math.min(found - index, 20);
    index = found + 1;
  }
  return score;
}

export class Palette extends EventTarget {
  constructor({ store, view }) {
    super();
    this.store = store;
    this.view = view;
    this.results = [];
    this.active = 0;

    this.root = h('div', { class: 'palette hidden' });
    this.input = h('input', {
      class: 'palette-input',
      type: 'text',
      placeholder: 'Jump to a node, or type a new name…',
      spellcheck: 'false',
    });
    this.list = h('ul', { class: 'palette-results' });
    this.hintEl = h('p', { class: 'palette-hint', text: '↑↓ to move · Enter to open · Shift+Enter to create' });

    this.root.append(h('div', { class: 'palette-box' }, [this.input, this.list, this.hintEl]));
    document.body.append(this.root);

    this.input.addEventListener('input', () => this.update());
    this.input.addEventListener('keydown', (event) => this.onKeyDown(event));
    this.root.addEventListener('pointerdown', (event) => {
      if (event.target === this.root) this.close();
    });
  }

  get isOpen() {
    return !this.root.classList.contains('hidden');
  }

  open(initial = '') {
    this.root.classList.remove('hidden');
    this.input.value = initial;
    this.update();
    this.input.focus();
    this.input.select();
  }

  close() {
    this.root.classList.add('hidden');
  }

  update() {
    const query = this.input.value.trim();
    const nodes = Object.values(this.store.doc.nodes);

    this.results = nodes
      .map((node) => {
        const titleScore = fuzzyScore(query, node.title);
        // Body matches count, but never outrank a title match.
        const bodyScore = query && titleScore < 0 && searchableText(node).includes(query.toLowerCase())
          ? 1
          : -1;
        return { node, score: Math.max(titleScore, bodyScore) };
      })
      .filter((entry) => query === '' || entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.node.title.localeCompare(b.node.title))
      .slice(0, 40);

    this.active = 0;
    this.renderResults(query);
  }

  renderResults(query) {
    const doc = this.store.doc;
    this.list.innerHTML = '';

    if (query && !this.results.length) {
      this.list.append(h('li', { class: 'palette-empty', text: `No match. Enter creates "${query}".` }));
      return;
    }

    this.results.forEach((entry, index) => {
      const { node } = entry;
      const status = node.status ? doc.statusTypes[node.status] : null;
      const item = h('li', {
        class: `palette-item ${index === this.active ? 'is-active' : ''}`,
        onpointerdown: (event) => { event.preventDefault(); this.choose(index); },
        onpointerenter: () => { this.active = index; this.renderResults(query); },
      }, [
        h('span', { class: 'palette-title', text: node.title }),
        status ? h('span', { class: 'palette-status', style: `--status-color:${status.color}`, text: status.label }) : null,
        h('span', { class: 'palette-tags', text: node.tags.map((t) => doc.tagTypes[t]?.label ?? t).join(' · ') }),
      ]);
      this.list.append(item);
    });
  }

  onKeyDown(event) {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); this.close(); return; }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.active = Math.min(this.active + 1, this.results.length - 1);
      this.renderResults(this.input.value.trim());
      this.list.children[this.active]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.active = Math.max(this.active - 1, 0);
      this.renderResults(this.input.value.trim());
      this.list.children[this.active]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey || !this.results.length) this.create();
      else this.choose(this.active);
    }
  }

  choose(index) {
    const entry = this.results[index];
    if (!entry) { this.create(); return; }
    this.close();
    this.dispatchEvent(new CustomEvent('navigate', { detail: { id: entry.node.id } }));
  }

  create() {
    const title = this.input.value.trim();
    if (!title) return;
    this.close();
    this.dispatchEvent(new CustomEvent('create', { detail: { title } }));
  }
}
