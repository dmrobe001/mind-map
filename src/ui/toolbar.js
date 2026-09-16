/**
 * The top bar: the map's name, file operations, history, and zoom.
 *
 * File state is shown in words rather than an icon, because "is this actually
 * on disk yet?" is the one question a local-only tool must never leave
 * ambiguous.
 */

import { h } from './filterpanel.js';
import { supportsFileSystemAccess } from '../core/persistence.js';

export class Toolbar {
  constructor({ root, store, view, handlers }) {
    this.root = root;
    this.store = store;
    this.view = view;
    this.handlers = handlers;
    this.fileState = { name: null, dirty: false, message: '' };
  }

  setFileState(patch) {
    Object.assign(this.fileState, patch);
    this.render();
  }

  render() {
    const doc = this.store.doc;
    const { name, dirty, message } = this.fileState;
    this.root.innerHTML = '';

    const title = h('input', {
      class: 'doc-title',
      type: 'text',
      value: doc.title,
      title: 'Name of this map',
      'data-focus-key': 'doc-title',
      onchange: (event) => this.handlers.rename(event.target.value),
    });

    const fileLabel = name
      ? `${name}${dirty ? ' •' : ''}`
      : 'not saved to a file yet';

    const fileGroup = h('div', { class: 'toolbar-group' }, [
      h('button', { type: 'button', class: 'tool', text: 'New', title: 'Start an empty map', onclick: () => this.handlers.newMap() }),
      h('button', { type: 'button', class: 'tool', text: 'Open…', title: 'Open a map file', onclick: () => this.handlers.open() }),
      h('button', {
        type: 'button',
        class: 'tool primary',
        text: 'Save',
        title: supportsFileSystemAccess ? 'Write back to the open file (Ctrl+S)' : 'Download the map file (Ctrl+S)',
        onclick: () => this.handlers.save(),
      }),
      supportsFileSystemAccess
        ? h('button', { type: 'button', class: 'tool', text: 'Save as…', onclick: () => this.handlers.saveAs() })
        : null,
      h('span', { class: `file-state ${dirty ? 'is-dirty' : ''}`, text: fileLabel }),
    ]);

    const historyGroup = h('div', { class: 'toolbar-group' }, [
      h('button', {
        type: 'button',
        class: 'tool',
        text: '↶',
        title: this.store.canUndo ? `Undo ${this.store.undoLabel} (Ctrl+Z)` : 'Nothing to undo',
        disabled: !this.store.canUndo,
        onclick: () => this.handlers.undo(),
      }),
      h('button', {
        type: 'button',
        class: 'tool',
        text: '↷',
        title: this.store.canRedo ? `Redo ${this.store.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo',
        disabled: !this.store.canRedo,
        onclick: () => this.handlers.redo(),
      }),
    ]);

    const edgeTypeSelect = h('select', {
      class: 'tool-select',
      title: 'Type used for links you draw',
      onchange: (event) => this.view.set({ newEdgeType: event.target.value }),
    }, Object.values(doc.edgeTypes).map((type) => h('option', {
      value: type.id,
      text: type.label,
      selected: type.id === this.view.get('newEdgeType'),
    })));

    const viewGroup = h('div', { class: 'toolbar-group' }, [
      h('button', { type: 'button', class: 'tool', text: '+ Node', title: 'Add a node (n)', onclick: () => this.handlers.addNode() }),
      h('span', { class: 'tool-label', text: 'link as' }),
      edgeTypeSelect,
      h('button', { type: 'button', class: 'tool', text: '−', title: 'Zoom out', onclick: () => this.handlers.zoom(1 / 1.25) }),
      h('button', { type: 'button', class: 'tool', text: '+', title: 'Zoom in', onclick: () => this.handlers.zoom(1.25) }),
      h('button', { type: 'button', class: 'tool', text: 'Fit', title: 'Frame everything visible (f)', onclick: () => this.handlers.fit() }),
      h('button', { type: 'button', class: 'tool', text: '?', title: 'Keyboard shortcuts', onclick: () => this.handlers.help() }),
    ]);

    this.root.append(title, fileGroup, historyGroup, viewGroup);
    if (message) this.root.append(h('span', { class: 'toolbar-message', text: message }));
  }
}
