/**
 * The inspector: everything about one node (or one edge) that doesn't fit on
 * a card.
 *
 * Content blocks and structured fields are both open-ended by design, so this
 * panel is built from the registries rather than from a fixed form. Register a
 * content type and it appears in the "add" menu with a working editor.
 */

import { runCommand } from '../core/commands.js';
import { contentRenderers } from '../core/registry.js';
import { rendererFor } from '../content/renderers.js';
import { h } from './filterpanel.js';

const section = (title, ...children) => h('section', { class: 'panel-section' }, [
  h('h3', { class: 'panel-heading', text: title }),
  ...children,
]);

export class Inspector extends EventTarget {
  constructor({ root, store, view }) {
    super();
    this.root = root;
    this.store = store;
    this.view = view;
    /** Block ids currently open in source mode rather than preview. */
    this.editing = new Set();
  }

  render() {
    const scrollTop = this.root.scrollTop;
    const activeKey = document.activeElement?.dataset?.focusKey;
    const caret = document.activeElement?.selectionStart;

    this.root.innerHTML = '';

    const nodeIds = this.view.selectedNodes;
    const edgeIds = this.view.selectedEdges;

    if (nodeIds.length === 1) this.renderNode(this.store.doc.nodes[nodeIds[0]]);
    else if (nodeIds.length > 1) this.renderMultiNode(nodeIds);
    else if (edgeIds.length) this.renderEdge(this.store.doc.edges[edgeIds[0]]);
    else this.renderEmpty();

    if (activeKey) {
      const restored = this.root.querySelector(`[data-focus-key="${activeKey}"]`);
      if (restored) {
        restored.focus();
        if (caret !== undefined && restored.setSelectionRange) {
          restored.setSelectionRange(caret, caret);
        }
      }
    }
    this.root.scrollTop = scrollTop;
  }

  renderEmpty() {
    this.root.append(h('div', { class: 'empty-state' }, [
      h('p', { text: 'Nothing selected.' }),
      h('ul', { class: 'shortcut-list' }, [
        h('li', { html: '<kbd>double-click</kbd> the background to add a node' }),
        h('li', { html: '<kbd>Tab</kbd> adds a child of the selected node' }),
        h('li', { html: '<kbd>Ctrl</kbd>+<kbd>K</kbd> jumps to any node' }),
      ]),
    ]));
  }

  renderMultiNode(ids) {
    const doc = this.store.doc;
    this.root.append(section(`${ids.length} nodes selected`,
      h('div', { class: 'button-row wrap' }, [
        ...Object.values(doc.statusTypes).map((status) => h('button', {
          type: 'button',
          class: 'mini',
          text: `mark ${status.label.toLowerCase()}`,
          onclick: () => runCommand('node.setStatus', this.store, { ids, status: status.id }),
        })),
        h('button', {
          type: 'button',
          class: 'mini',
          text: 'clear status',
          onclick: () => runCommand('node.setStatus', this.store, { ids, status: null }),
        }),
      ]),
      h('h4', { class: 'sub-heading', text: 'Toggle labels' }),
      h('div', { class: 'chip-row' }, Object.values(doc.tagTypes).map((tag) => h('button', {
        type: 'button',
        class: 'chip chip-neutral',
        style: `--tag-color: ${tag.color}`,
        text: tag.label,
        onclick: () => runCommand('node.toggleTag', this.store, { ids, tag: tag.id }),
      }))),
      h('div', { class: 'button-row' }, [
        h('button', {
          type: 'button',
          class: 'mini',
          text: 'link in a chain',
          title: 'Link each selected node to the next, in selection order',
          onclick: () => {
            for (let i = 0; i < ids.length - 1; i += 1) {
              runCommand('edge.add', this.store, {
                from: ids[i], to: ids[i + 1], type: this.view.get('newEdgeType'),
              });
            }
          },
        }),
        h('button', {
          type: 'button',
          class: 'mini danger',
          text: 'delete',
          onclick: () => this.confirmDelete(ids),
        }),
      ])));
  }

  confirmDelete(ids) {
    const count = ids.length;
    const message = count === 1
      ? `Delete "${this.store.doc.nodes[ids[0]]?.title}" and its links?`
      : `Delete ${count} nodes and their links?`;
    if (!globalThis.confirm(message)) return;
    runCommand('node.delete', this.store, { ids });
    this.view.clearSelection();
  }

  /* ---------------------------------------------------------------- */

  renderNode(node) {
    if (!node) { this.renderEmpty(); return; }
    const doc = this.store.doc;
    const patch = (changes, coalesceKey) => runCommand('node.update', this.store, {
      id: node.id, patch: changes, coalesceKey,
    });

    /* Title and summary */
    this.root.append(section('Node',
      h('input', {
        class: 'title-input',
        type: 'text',
        value: node.title,
        'data-focus-key': 'node-title',
        oninput: (event) => patch({ title: event.target.value }, `title:${node.id}`),
      }),
      h('textarea', {
        class: 'summary-input',
        rows: 2,
        placeholder: 'One-line summary shown on the card…',
        'data-focus-key': 'node-summary',
        oninput: (event) => patch({ summary: event.target.value }, `summary:${node.id}`),
      }, [document.createTextNode(node.summary ?? '')]),
    ));

    /* Status */
    const statusButtons = [
      h('button', {
        type: 'button',
        class: `mini ${!node.status ? 'is-on' : ''}`,
        text: 'none',
        onclick: () => runCommand('node.setStatus', this.store, { ids: [node.id], status: null }),
      }),
      ...Object.values(doc.statusTypes)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((status) => h('button', {
          type: 'button',
          class: `mini ${node.status === status.id ? 'is-on' : ''}`,
          style: `--status-color: ${status.color}`,
          text: status.label,
          onclick: () => runCommand('node.setStatus', this.store, { ids: [node.id], status: status.id }),
        })),
    ];
    this.root.append(section('Status', h('div', { class: 'button-row wrap' }, statusButtons)));

    /* Labels */
    this.root.append(section('Labels',
      h('div', { class: 'chip-row' }, Object.values(doc.tagTypes).map((tag) => h('button', {
        type: 'button',
        class: `chip ${node.tags.includes(tag.id) ? 'chip-include' : 'chip-neutral'}`,
        style: `--tag-color: ${tag.color}`,
        text: tag.label,
        onclick: () => runCommand('node.toggleTag', this.store, { ids: [node.id], tag: tag.id }),
      }))),
      h('form', {
        class: 'inline-form',
        onsubmit: (event) => {
          event.preventDefault();
          const input = event.target.querySelector('input');
          const label = input.value.trim();
          if (!label) return;
          const id = runCommand('tag.create', this.store, { label });
          runCommand('node.toggleTag', this.store, { ids: [node.id], tag: id });
          input.value = '';
        },
      }, [
        h('input', { type: 'text', placeholder: 'New label…' }),
        h('button', { type: 'submit', class: 'mini', text: 'add' }),
      ])));

    /* Content blocks */
    this.root.append(this.renderContent(node));

    /* Structured fields */
    this.root.append(this.renderFields(node));

    /* Links */
    this.root.append(this.renderLinks(node));

    /* Footer */
    this.root.append(section('Node actions',
      h('div', { class: 'button-row wrap' }, [
        h('button', {
          type: 'button',
          class: 'mini',
          text: 'focus on this',
          onclick: () => this.view.set({
            focus: { ...this.view.get('focus'), node: node.id, mode: 'within' },
          }),
        }),
        h('button', {
          type: 'button',
          class: 'mini danger',
          text: 'delete node',
          onclick: () => this.confirmDelete([node.id]),
        }),
      ]),
      h('p', {
        class: 'hint',
        text: `Created ${new Date(node.created).toLocaleString()} · updated ${new Date(node.updated).toLocaleString()}`,
      })));
  }

  renderContent(node) {
    const blocks = node.content ?? [];
    const rows = blocks.map((block) => this.renderBlock(node, block));

    const adder = h('select', {
      class: 'mini-select',
      onchange: (event) => {
        const type = event.target.value;
        event.target.value = '';
        if (!type) return;
        const id = runCommand('block.add', this.store, { nodeId: node.id, type });
        this.editing.add(id);
        this.render();
      },
    }, [
      h('option', { value: '', text: '+ add content', selected: true }),
      ...contentRenderers.sorted().map((renderer) => h('option', {
        value: renderer.id, text: renderer.label,
      })),
    ]);

    return section('Content', ...rows, adder);
  }

  renderBlock(node, block) {
    const renderer = rendererFor(block.type);
    const isEditing = this.editing.has(block.id);

    const head = h('div', { class: 'block-head' }, [
      h('span', { class: 'block-type', text: renderer.label ?? block.type }),
      h('input', {
        class: 'block-label',
        type: 'text',
        placeholder: 'label (optional)',
        value: block.label ?? '',
        oninput: (event) => runCommand('block.update', this.store, {
          nodeId: node.id,
          blockId: block.id,
          patch: { label: event.target.value },
          coalesceKey: `blocklabel:${block.id}`,
        }),
      }),
      h('button', {
        type: 'button',
        class: 'mini',
        text: isEditing ? 'done' : 'edit',
        onclick: () => {
          if (isEditing) this.editing.delete(block.id);
          else this.editing.add(block.id);
          this.render();
        },
      }),
      h('button', {
        type: 'button', class: 'mini', text: '↑', title: 'Move up',
        onclick: () => runCommand('block.move', this.store, { nodeId: node.id, blockId: block.id, delta: -1 }),
      }),
      h('button', {
        type: 'button', class: 'mini', text: '↓', title: 'Move down',
        onclick: () => runCommand('block.move', this.store, { nodeId: node.id, blockId: block.id, delta: 1 }),
      }),
      h('button', {
        type: 'button', class: 'mini danger', text: '×', title: 'Remove block',
        onclick: () => {
          this.editing.delete(block.id);
          runCommand('block.delete', this.store, { nodeId: node.id, blockId: block.id });
        },
      }),
    ]);

    let body;
    if (isEditing) {
      const commit = (event) => runCommand('block.update', this.store, {
        nodeId: node.id,
        blockId: block.id,
        patch: { value: event.target.value },
        coalesceKey: `block:${block.id}`,
      });
      body = renderer.editor === 'line'
        ? h('input', {
          class: 'block-input',
          type: 'text',
          placeholder: renderer.placeholder ?? '',
          value: block.value ?? '',
          'data-focus-key': `block-${block.id}`,
          oninput: commit,
        })
        : h('textarea', {
          class: 'block-input',
          rows: Math.min(20, Math.max(4, String(block.value ?? '').split('\n').length + 1)),
          placeholder: renderer.placeholder ?? '',
          spellcheck: 'false',
          'data-focus-key': `block-${block.id}`,
          oninput: commit,
        }, [document.createTextNode(block.value ?? '')]);
    } else {
      body = renderer.render(block, { doc: this.store.doc });
      body.addEventListener('click', (event) => {
        const link = event.target.closest('.wikilink');
        if (!link) return;
        event.preventDefault();
        this.dispatchEvent(new CustomEvent('navigate-title', {
          detail: { title: link.dataset.nodeTitle, from: node.id },
        }));
      });
    }

    const children = [head, body];
    if (isEditing && renderer.hint) children.push(h('p', { class: 'hint', text: renderer.hint }));
    return h('div', { class: 'block' }, children);
  }

  renderFields(node) {
    const entries = Object.entries(node.fields ?? {});
    const rows = entries.map(([key, value]) => h('div', { class: 'field-row' }, [
      h('span', { class: 'field-label mono', text: key }),
      h('input', {
        type: 'text',
        value: String(value ?? ''),
        'data-focus-key': `field-${key}`,
        oninput: (event) => runCommand('node.setField', this.store, {
          id: node.id, key, value: event.target.value,
        }),
      }),
      h('button', {
        type: 'button', class: 'mini danger', text: '×',
        onclick: () => runCommand('node.deleteField', this.store, { id: node.id, key }),
      }),
    ]));

    const adder = h('form', {
      class: 'inline-form',
      onsubmit: (event) => {
        event.preventDefault();
        const [keyInput, valueInput] = event.target.querySelectorAll('input');
        const key = keyInput.value.trim();
        if (!key) return;
        runCommand('node.setField', this.store, { id: node.id, key, value: valueInput.value });
        keyInput.value = '';
        valueInput.value = '';
      },
    }, [
      h('input', { type: 'text', placeholder: 'key' }),
      h('input', { type: 'text', placeholder: 'value' }),
      h('button', { type: 'submit', class: 'mini', text: 'set' }),
    ]);

    return section('Fields',
      ...rows,
      adder,
      h('p', { class: 'hint', text: 'Arbitrary key/value data. Queryable with the "field" condition.' }));
  }

  renderLinks(node) {
    const doc = this.store.doc;
    const links = this.store.graph.neighbors(node.id);

    const rows = links.map(({ edge, other, direction }) => {
      const type = doc.edgeTypes[edge.type];
      const otherNode = doc.nodes[other];
      return h('div', { class: 'link-row' }, [
        h('span', {
          class: 'link-type',
          style: `--tag-color: ${type?.color ?? '#8a8f98'}`,
          text: type?.directed === false ? '—' : (direction === 'out' ? '→' : '←'),
          title: type?.label ?? edge.type,
        }),
        h('button', {
          type: 'button',
          class: 'link-button grow',
          text: otherNode?.title ?? '(missing)',
          onclick: () => this.dispatchEvent(new CustomEvent('navigate', { detail: { id: other } })),
        }),
        h('select', {
          class: 'mini-select',
          onchange: (event) => runCommand('edge.update', this.store, {
            id: edge.id, patch: { type: event.target.value },
          }),
        }, Object.values(doc.edgeTypes).map((t) => h('option', {
          value: t.id, text: t.label, selected: t.id === edge.type,
        }))),
        h('button', {
          type: 'button', class: 'mini', text: '⇄', title: 'Reverse direction',
          onclick: () => runCommand('edge.reverse', this.store, { id: edge.id }),
        }),
        h('button', {
          type: 'button', class: 'mini danger', text: '×', title: 'Remove link',
          onclick: () => runCommand('edge.delete', this.store, { ids: [edge.id] }),
        }),
      ]);
    });

    return section(`Links (${links.length})`,
      ...(rows.length ? rows : [h('p', { class: 'muted', text: 'Not linked to anything yet.' })]),
      h('p', { class: 'hint', text: 'Drag the dot on the right edge of a card onto another card to link them.' }));
  }

  renderEdge(edge) {
    if (!edge) { this.renderEmpty(); return; }
    const doc = this.store.doc;
    const from = doc.nodes[edge.from];
    const to = doc.nodes[edge.to];

    this.root.append(section('Link',
      h('div', { class: 'link-ends' }, [
        h('button', {
          type: 'button', class: 'link-button', text: from?.title ?? '?',
          onclick: () => this.dispatchEvent(new CustomEvent('navigate', { detail: { id: edge.from } })),
        }),
        h('span', { class: 'arrow', text: doc.edgeTypes[edge.type]?.directed === false ? '—' : '→' }),
        h('button', {
          type: 'button', class: 'link-button', text: to?.title ?? '?',
          onclick: () => this.dispatchEvent(new CustomEvent('navigate', { detail: { id: edge.to } })),
        }),
      ]),
      h('label', { class: 'field-row' }, [
        h('span', { class: 'field-label', text: 'Type' }),
        h('select', {
          onchange: (event) => runCommand('edge.update', this.store, {
            id: edge.id, patch: { type: event.target.value },
          }),
        }, Object.values(doc.edgeTypes).map((t) => h('option', {
          value: t.id, text: t.label, selected: t.id === edge.type,
        }))),
      ]),
      h('label', { class: 'field-row' }, [
        h('span', { class: 'field-label', text: 'Label' }),
        h('input', {
          type: 'text',
          value: edge.label ?? '',
          'data-focus-key': 'edge-label',
          oninput: (event) => runCommand('edge.update', this.store, {
            id: edge.id, patch: { label: event.target.value },
          }),
        }),
      ]),
      h('div', { class: 'button-row' }, [
        h('button', {
          type: 'button', class: 'mini', text: 'reverse',
          onclick: () => runCommand('edge.reverse', this.store, { id: edge.id }),
        }),
        h('button', {
          type: 'button', class: 'mini danger', text: 'delete link',
          onclick: () => {
            runCommand('edge.delete', this.store, { ids: [edge.id] });
            this.view.clearSelection();
          },
        }),
      ])));

    this.root.append(this.renderEdgeTypeEditor());
  }

  renderEdgeTypeEditor() {
    const doc = this.store.doc;
    const rows = Object.values(doc.edgeTypes).map((type) => h('div', { class: 'link-row' }, [
      h('span', { class: 'link-type', style: `--tag-color: ${type.color}`, text: '●' }),
      h('span', { class: 'grow', text: type.label }),
      h('label', { class: 'check-row tight' }, [
        h('input', {
          type: 'checkbox',
          checked: type.hierarchical,
          onchange: (event) => runCommand('edgeType.update', this.store, {
            id: type.id, patch: { hierarchical: event.target.checked },
          }),
        }),
        h('span', { text: 'hierarchy' }),
      ]),
    ]));

    return section('Edge types',
      ...rows,
      h('form', {
        class: 'inline-form',
        onsubmit: (event) => {
          event.preventDefault();
          const input = event.target.querySelector('input');
          if (!input.value.trim()) return;
          runCommand('edgeType.create', this.store, { label: input.value.trim() });
          input.value = '';
        },
      }, [
        h('input', { type: 'text', placeholder: 'New edge type…' }),
        h('button', { type: 'submit', class: 'mini', text: 'add' }),
      ]),
      h('p', {
        class: 'hint',
        text: 'Types marked "hierarchy" are the ones the "everything under / above" filters walk.',
      }));
  }
}
