/**
 * The filter panel.
 *
 * Three tiers, all compiling to the same filter language:
 *
 *   1. Label chips and a status picker — one click, covers "hide work stuff".
 *   2. Focus — pick a node and show only what relates to it.
 *   3. A compound query builder — rows of conditions joined by AND or OR,
 *      with a raw JSON escape hatch for anything the rows can't express.
 *
 * The condition rows are generated from `filterOps`: an operator's `fields`
 * declaration is enough to give it a UI, so a new operator registered anywhere
 * shows up here with no changes to this file.
 */

import { filterOps } from '../core/registry.js';
import { describeFilter } from '../core/query.js';
import { runCommand } from '../core/commands.js';
import { FOCUS_MODES } from './viewstate.js';

const h = (tag, props = {}, children = []) => {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key === 'html') element.innerHTML = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== null && value !== undefined && value !== false) element.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child) element.append(child);
  }
  return element;
};

const section = (title, ...children) => h('section', { class: 'panel-section' }, [
  h('h3', { class: 'panel-heading', text: title }),
  ...children,
]);

export class FilterPanel {
  constructor({ root, store, view }) {
    this.root = root;
    this.store = store;
    this.view = view;
    this.stats = { matched: 0, total: 0 };
    this.showJson = false;
  }

  setStats(matched, total) {
    this.stats = { matched, total };
  }

  render() {
    const scrollTop = this.root.scrollTop;
    const activeKey = document.activeElement?.dataset?.focusKey;
    const selectionStart = document.activeElement?.selectionStart;

    this.root.innerHTML = '';
    this.root.append(
      this.renderSummary(),
      this.renderSearch(),
      this.renderLabels(),
      this.renderStatus(),
      this.renderFocus(),
      this.renderAdvanced(),
      this.renderViews(),
      this.renderDisplay(),
    );

    if (activeKey) {
      const restored = this.root.querySelector(`[data-focus-key="${activeKey}"]`);
      if (restored) {
        restored.focus();
        if (selectionStart !== undefined && restored.setSelectionRange) {
          restored.setSelectionRange(selectionStart, selectionStart);
        }
      }
    }
    this.root.scrollTop = scrollTop;
  }

  /* ---------------------------------------------------------------- */

  renderSummary() {
    const { matched, total } = this.stats;
    const active = this.view.hasActiveFilter;
    return h('div', { class: `filter-summary ${active ? 'is-active' : ''}` }, [
      h('div', { class: 'filter-count', text: active ? `${matched} of ${total} nodes` : `${total} nodes` }),
      active
        ? h('button', {
          class: 'link-button',
          type: 'button',
          text: 'clear all',
          onclick: () => this.view.resetFilters(),
        })
        : null,
    ]);
  }

  renderSearch() {
    const input = h('input', {
      type: 'search',
      class: 'search-input',
      placeholder: 'Search text…',
      value: this.view.get('search'),
      'data-focus-key': 'search',
      oninput: (event) => this.view.set({ search: event.target.value }),
    });
    return section('Search', input);
  }

  renderLabels() {
    const doc = this.store.doc;
    const tags = Object.values(doc.tagTypes).sort((a, b) => a.label.localeCompare(b.label));

    const counts = new Map();
    for (const node of Object.values(doc.nodes)) {
      for (const tag of node.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }

    const chips = tags.map((tag) => {
      const state = this.view.tagState(tag.id);
      return h('button', {
        class: `chip chip-${state}`,
        type: 'button',
        title: `${tag.label} — click to require, again to exclude`,
        style: `--tag-color: ${tag.color}`,
        onclick: () => this.view.cycleTag(tag.id),
        oncontextmenu: (event) => {
          event.preventDefault();
          this.editTag(tag);
        },
      }, [
        h('span', { class: 'chip-dot' }),
        h('span', { text: tag.label }),
        h('span', { class: 'chip-count', text: String(counts.get(tag.id) ?? 0) }),
      ]);
    });

    const adder = h('form', {
      class: 'inline-form',
      onsubmit: (event) => {
        event.preventDefault();
        const input = event.target.querySelector('input');
        const label = input.value.trim();
        if (!label) return;
        const id = runCommand('tag.create', this.store, { label });
        input.value = '';
        // A label you just made is almost always one you want to apply.
        const selected = this.view.selectedNodes;
        if (selected.length) runCommand('node.toggleTag', this.store, { ids: selected, tag: id });
      },
    }, [
      h('input', { type: 'text', placeholder: 'New label…', 'data-focus-key': 'new-tag' }),
      h('button', { type: 'submit', class: 'mini', text: 'add' }),
    ]);

    return section('Labels',
      chips.length ? h('div', { class: 'chip-row' }, chips) : h('p', { class: 'muted', text: 'No labels yet.' }),
      adder,
      h('p', { class: 'hint', text: 'Click to require, click again to exclude. Right-click to rename or recolour.' }));
  }

  editTag(tag) {
    const label = globalThis.prompt('Label name', tag.label);
    if (label === null) return;
    if (label.trim() === '') {
      if (globalThis.confirm(`Delete the label "${tag.label}" from every node?`)) {
        runCommand('tag.delete', this.store, { id: tag.id });
      }
      return;
    }
    const color = globalThis.prompt('Colour (any CSS colour)', tag.color) ?? tag.color;
    runCommand('tag.update', this.store, { id: tag.id, patch: { label: label.trim(), color } });
  }

  renderStatus() {
    const doc = this.store.doc;
    const current = this.view.get('quick').status;
    const options = [
      ['all', 'Any'],
      ['any', 'Has a status'],
      ['none', 'No status'],
      ...Object.values(doc.statusTypes)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((s) => [s.id, s.label]),
    ];
    const select = h('select', {
      class: 'full',
      'data-focus-key': 'status-filter',
      onchange: (event) => this.view.set({
        quick: { ...this.view.get('quick'), status: event.target.value },
      }),
    }, options.map(([value, label]) => h('option', { value, text: label, selected: value === current })));
    return section('Status', select);
  }

  renderFocus() {
    const focus = this.view.get('focus');
    const doc = this.store.doc;
    const selected = this.view.soleSelectedNode;
    const anchor = focus.node ? doc.nodes[focus.node] : null;

    const patch = (changes) => this.view.set({ focus: { ...this.view.get('focus'), ...changes } });

    const modeSelect = h('select', {
      class: 'full',
      'data-focus-key': 'focus-mode',
      onchange: (event) => patch({
        mode: event.target.value,
        node: focus.node ?? selected,
      }),
    }, Object.entries(FOCUS_MODES).map(([id, mode]) => h('option', {
      value: id, text: mode.label, selected: id === focus.mode,
    })));

    const rows = [
      h('div', { class: 'field-row' }, [
        h('span', { class: 'field-label', text: 'Anchor' }),
        h('span', { class: 'anchor-name', text: anchor ? anchor.title : '— none —' }),
      ]),
      h('div', { class: 'button-row' }, [
        h('button', {
          type: 'button',
          class: 'mini',
          text: 'use selected',
          disabled: !selected,
          onclick: () => patch({ node: selected, mode: focus.mode === 'off' ? 'within' : focus.mode }),
        }),
        h('button', {
          type: 'button',
          class: 'mini',
          text: 'clear',
          disabled: !focus.node,
          onclick: () => patch({ node: null, mode: 'off' }),
        }),
      ]),
      modeSelect,
    ];

    const mode = FOCUS_MODES[focus.mode];
    if (mode?.usesDepth) {
      rows.push(h('label', { class: 'field-row' }, [
        h('span', { class: 'field-label', text: focus.mode === 'within' ? 'Links' : 'Levels' }),
        h('input', {
          type: 'number',
          min: focus.mode === 'within' ? 1 : 0,
          max: 12,
          value: String(focus.depth),
          'data-focus-key': 'focus-depth',
          oninput: (event) => patch({ depth: Number(event.target.value) }),
        }),
      ]));
      if (focus.mode !== 'within') {
        rows.push(h('p', { class: 'hint', text: '0 means no limit.' }));
      }
    }
    if (mode?.usesDirection) {
      rows.push(h('label', { class: 'field-row' }, [
        h('span', { class: 'field-label', text: 'Follow' }),
        h('select', {
          'data-focus-key': 'focus-direction',
          onchange: (event) => patch({ direction: event.target.value }),
        }, [
          ['any', 'links either way'],
          ['out', 'outgoing only'],
          ['in', 'incoming only'],
        ].map(([value, label]) => h('option', { value, text: label, selected: value === focus.direction }))),
      ]));
    }
    if (focus.mode !== 'off') {
      rows.push(h('label', { class: 'check-row' }, [
        h('input', {
          type: 'checkbox',
          checked: focus.includeSelf,
          onchange: (event) => patch({ includeSelf: event.target.checked }),
        }),
        h('span', { text: 'include the anchor itself' }),
      ]));
    }

    return section('Focus', ...rows);
  }

  /* ---------------------------------------------------------------- *
   * Compound query builder
   * ---------------------------------------------------------------- */

  get advanced() {
    return this.view.get('advanced') ?? { op: 'and', clauses: [] };
  }

  setAdvanced(spec) {
    const empty = !spec || !spec.clauses?.length;
    this.view.set({ advanced: empty ? null : spec });
  }

  renderAdvanced() {
    const spec = this.advanced;
    const rows = (spec.clauses ?? []).map((clause, index) => this.renderClause(clause, index, spec));

    const combinator = h('select', {
      class: 'mini-select',
      onchange: (event) => this.setAdvanced({ ...spec, op: event.target.value }),
    }, [
      h('option', { value: 'and', text: 'match all', selected: spec.op === 'and' }),
      h('option', { value: 'or', text: 'match any', selected: spec.op === 'or' }),
    ]);

    const addable = filterOps.sorted().filter((op) => !op.structural);
    const adder = h('select', {
      class: 'mini-select',
      'data-focus-key': 'add-condition',
      onchange: (event) => {
        const op = filterOps.get(event.target.value);
        event.target.value = '';
        if (!op) return;
        const clause = { op: op.id };
        for (const field of op.fields ?? []) {
          if (field.default !== undefined) clause[field.key] = field.default;
        }
        if ((op.fields ?? []).some((f) => f.type === 'node')) {
          clause.node = this.view.soleSelectedNode ?? null;
        }
        this.setAdvanced({ ...spec, clauses: [...(spec.clauses ?? []), clause] });
      },
    }, [
      h('option', { value: '', text: '+ add condition', selected: true }),
      ...addable.map((op) => h('option', { value: op.id, text: `${op.category}: ${op.label}` })),
    ]);

    const children = [
      h('div', { class: 'builder-head' }, [combinator, adder]),
      ...rows,
    ];

    if (spec.clauses?.length) {
      children.push(h('p', {
        class: 'query-description hint',
        text: describeFilter(spec, this.store.queryContext),
      }));
    }

    children.push(h('button', {
      class: 'link-button',
      type: 'button',
      text: this.showJson ? 'hide JSON' : 'edit as JSON',
      onclick: () => { this.showJson = !this.showJson; this.render(); },
    }));

    if (this.showJson) children.push(this.renderJsonEditor());

    return section('Query', ...children);
  }

  renderClause(clause, index, parent) {
    const op = filterOps.get(clause.op);
    const update = (changes) => {
      const clauses = [...parent.clauses];
      clauses[index] = { ...clause, ...changes };
      this.setAdvanced({ ...parent, clauses });
    };
    const remove = () => {
      this.setAdvanced({ ...parent, clauses: parent.clauses.filter((_, i) => i !== index) });
    };

    const negated = clause.op === 'not';
    const inner = negated ? clause.clause ?? { op: 'all' } : clause;
    const innerOp = filterOps.get(inner.op);

    const updateInner = (changes) => {
      const next = { ...inner, ...changes };
      update(negated ? { clause: next } : changes);
    };

    return h('div', { class: 'clause' }, [
      h('div', { class: 'clause-head' }, [
        h('button', {
          type: 'button',
          class: `mini toggle ${negated ? 'is-on' : ''}`,
          title: 'Negate this condition',
          text: 'not',
          onclick: () => {
            if (negated) {
              const clauses = [...parent.clauses];
              clauses[index] = inner;
              this.setAdvanced({ ...parent, clauses });
            } else {
              const clauses = [...parent.clauses];
              clauses[index] = { op: 'not', clause: clause };
              this.setAdvanced({ ...parent, clauses });
            }
          },
        }),
        h('span', { class: 'clause-label', text: innerOp?.label ?? inner.op }),
        h('button', { type: 'button', class: 'mini danger', text: '×', title: 'Remove', onclick: remove }),
      ]),
      ...(innerOp?.fields ?? []).map((field) => this.renderField(field, inner, updateInner)),
      op ? null : h('p', { class: 'hint', text: `Unknown operator "${clause.op}".` }),
    ]);
  }

  /** Build an input for one declared operator field. */
  renderField(field, clause, update) {
    const doc = this.store.doc;
    const value = clause[field.key];
    let control;

    switch (field.type) {
      case 'number':
        control = h('input', {
          type: 'number',
          min: field.min,
          max: field.max,
          value: String(value ?? field.default ?? 0),
          'data-focus-key': `f-${field.key}-${clause.op}`,
          oninput: (event) => update({ [field.key]: Number(event.target.value) }),
        });
        break;
      case 'boolean':
        control = h('input', {
          type: 'checkbox',
          checked: value !== false,
          onchange: (event) => update({ [field.key]: event.target.checked }),
        });
        break;
      case 'select':
        control = h('select', {
          onchange: (event) => update({ [field.key]: event.target.value }),
        }, (field.options ?? []).map((option) => h('option', {
          value: option, text: option, selected: option === (value ?? field.default),
        })));
        break;
      case 'tag':
        control = h('select', {
          onchange: (event) => update({ [field.key]: event.target.value }),
        }, [
          h('option', { value: '', text: '—' }),
          ...Object.values(doc.tagTypes).map((tag) => h('option', {
            value: tag.id, text: tag.label, selected: tag.id === value,
          })),
        ]);
        break;
      case 'tagList':
        control = h('div', { class: 'chip-row tight' }, Object.values(doc.tagTypes).map((tag) => {
          const on = (value ?? []).includes(tag.id);
          return h('button', {
            type: 'button',
            class: `chip ${on ? 'chip-include' : 'chip-neutral'}`,
            style: `--tag-color: ${tag.color}`,
            text: tag.label,
            onclick: () => {
              const next = on ? (value ?? []).filter((t) => t !== tag.id) : [...(value ?? []), tag.id];
              update({ [field.key]: next });
            },
          });
        }));
        break;
      case 'edgeTypeList':
        control = h('div', { class: 'chip-row tight' }, Object.values(doc.edgeTypes).map((type) => {
          const on = (value ?? []).includes(type.id);
          return h('button', {
            type: 'button',
            class: `chip ${on ? 'chip-include' : 'chip-neutral'}`,
            style: `--tag-color: ${type.color}`,
            text: type.label,
            onclick: () => {
              const next = on ? (value ?? []).filter((t) => t !== type.id) : [...(value ?? []), type.id];
              update({ [field.key]: next });
            },
          });
        }));
        break;
      case 'status':
        control = h('select', {
          onchange: (event) => update({ [field.key]: event.target.value }),
        }, [
          h('option', { value: 'none', text: 'no status', selected: value === 'none' }),
          h('option', { value: 'any', text: 'any status', selected: value === 'any' }),
          ...Object.values(doc.statusTypes).map((s) => h('option', {
            value: s.id, text: s.label, selected: s.id === value,
          })),
        ]);
        break;
      case 'node': {
        const nodes = Object.values(doc.nodes).sort((a, b) => a.title.localeCompare(b.title));
        control = h('div', { class: 'node-picker' }, [
          h('select', {
            onchange: (event) => update({ [field.key]: event.target.value || null }),
          }, [
            h('option', { value: '', text: '— pick a node —' }),
            ...nodes.map((node) => h('option', {
              value: node.id, text: node.title, selected: node.id === value,
            })),
          ]),
          h('button', {
            type: 'button',
            class: 'mini',
            text: 'selected',
            disabled: !this.view.soleSelectedNode,
            onclick: () => update({ [field.key]: this.view.soleSelectedNode }),
          }),
        ]);
        break;
      }
      default:
        control = h('input', {
          type: 'text',
          value: value ?? '',
          'data-focus-key': `f-${field.key}-${clause.op}`,
          oninput: (event) => update({ [field.key]: event.target.value }),
        });
    }

    return h('label', { class: 'field-row' }, [
      h('span', { class: 'field-label', text: field.label ?? field.key }),
      control,
    ]);
  }

  renderJsonEditor() {
    const area = h('textarea', {
      class: 'json-editor',
      rows: 10,
      spellcheck: 'false',
      'data-focus-key': 'json-editor',
    });
    area.value = JSON.stringify(this.view.get('advanced') ?? { op: 'and', clauses: [] }, null, 2);
    const error = h('p', { class: 'hint error hidden' });
    const apply = h('button', {
      type: 'button',
      class: 'mini',
      text: 'apply',
      onclick: () => {
        try {
          this.setAdvanced(JSON.parse(area.value));
          error.classList.add('hidden');
        } catch (err) {
          error.textContent = err.message;
          error.classList.remove('hidden');
        }
      },
    });
    return h('div', { class: 'json-block' }, [
      area,
      h('div', { class: 'button-row' }, [apply]),
      error,
      h('p', {
        class: 'hint',
        text: `Operators: ${filterOps.sorted().map((o) => o.id).join(', ')}`,
      }),
    ]);
  }

  /* ---------------------------------------------------------------- */

  renderViews() {
    const views = this.store.doc.views ?? [];
    const list = views.map((saved) => h('div', { class: 'saved-view' }, [
      h('button', {
        type: 'button',
        class: 'link-button grow',
        text: saved.name,
        title: describeFilter(saved.filter, this.store.queryContext),
        onclick: () => this.applyView(saved),
      }),
      h('button', {
        type: 'button',
        class: 'mini danger',
        text: '×',
        title: 'Delete this view',
        onclick: () => runCommand('view.delete', this.store, { id: saved.id }),
      }),
    ]));

    const save = h('button', {
      type: 'button',
      class: 'mini',
      text: 'save current filter',
      onclick: () => {
        const name = globalThis.prompt('Name this view', 'Untitled view');
        if (!name) return;
        runCommand('view.save', this.store, {
          name,
          filter: {
            quick: this.view.get('quick'),
            focus: this.view.get('focus'),
            advanced: this.view.get('advanced'),
            search: this.view.get('search'),
          },
        });
      },
    });

    return section('Saved views',
      list.length ? h('div', { class: 'view-list' }, list) : h('p', { class: 'muted', text: 'None saved.' }),
      save);
  }

  applyView(saved) {
    const filter = saved.filter ?? {};
    this.view.set({
      quick: filter.quick ?? { include: [], exclude: [], status: 'all' },
      focus: { ...this.view.get('focus'), ...(filter.focus ?? {}) },
      advanced: filter.advanced ?? null,
      search: filter.search ?? '',
    });
  }

  renderDisplay() {
    return section('Display', h('label', { class: 'check-row' }, [
      h('input', {
        type: 'checkbox',
        checked: this.view.get('dimInsteadOfHide'),
        onchange: (event) => this.view.set({ dimInsteadOfHide: event.target.checked }),
      }),
      h('span', { text: 'fade filtered-out nodes instead of hiding them' }),
    ]));
  }
}

export { h };
