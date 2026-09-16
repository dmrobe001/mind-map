/**
 * Application wiring.
 *
 * Everything here is glue: create the store and the panels, recompute the
 * filter when either the document or the view changes, and translate keyboard
 * input into commands. Behaviour lives in `core/`; this file decides when it
 * runs.
 */

import { Store } from '../core/store.js';
import { runCommand } from '../core/commands.js';
import { selectNodes, selectEdges } from '../core/query.js';
import { createStarterDocument } from '../core/starter.js';
import { createDocument } from '../core/model.js';
import {
  FileBinding, supportsFileSystemAccess, saveAutosave, loadAutosave,
  downloadDocument, pickFileForUpload,
} from '../core/persistence.js';

import { ViewState, buildEffectiveFilter } from './viewstate.js';
import { Canvas } from './canvas.js';
import { FilterPanel, h } from './filterpanel.js';
import { Inspector } from './inspector.js';
import { Palette } from './palette.js';
import { Toolbar } from './toolbar.js';

const AUTOSAVE_DELAY = 500;
const CHILD_OFFSET_X = 250;
const CHILD_OFFSET_Y = 110;

export class App {
  constructor(root) {
    this.elements = {
      toolbar: root.querySelector('#toolbar'),
      left: root.querySelector('#left-panel'),
      canvas: root.querySelector('#canvas'),
      right: root.querySelector('#right-panel'),
      status: root.querySelector('#status-bar'),
    };

    this.store = new Store(createDocument());
    this.view = ViewState.restore();
    this.file = new FileBinding();
    this.dirty = false;
    this.pending = null;
    this.match = { nodes: new Set(), edges: new Set() };

    this.canvas = new Canvas({ root: this.elements.canvas, store: this.store, view: this.view });
    this.filters = new FilterPanel({ root: this.elements.left, store: this.store, view: this.view });
    this.inspector = new Inspector({ root: this.elements.right, store: this.store, view: this.view });
    this.palette = new Palette({ store: this.store, view: this.view });
    this.toolbar = new Toolbar({
      root: this.elements.toolbar,
      store: this.store,
      view: this.view,
      handlers: {
        newMap: () => this.newMap(),
        open: () => this.openFile(),
        save: () => this.save(),
        saveAs: () => this.saveAs(),
        undo: () => { this.store.undo(); },
        redo: () => { this.store.redo(); },
        rename: (title) => runCommand('doc.rename', this.store, { title }),
        addNode: () => this.addNodeAtCenter(),
        zoom: (factor) => this.canvas.zoomBy(factor),
        fit: () => this.canvas.fitToContent(this.match.nodes),
        help: () => this.showHelp(),
      },
    });

    this._wireEvents();
  }

  /* ================================================================ *
   * Startup
   * ================================================================ */

  async start() {
    const restoredHandle = await this.file.restore().catch(() => false);
    const autosaved = loadAutosave();

    if (autosaved) {
      this.store.replaceDocument(autosaved, 'Restore session');
      this.setMessage(restoredHandle
        ? `Restored your last session. Connected to ${this.file.name}.`
        : 'Restored your last session from this browser.');
    } else {
      this.store.replaceDocument(createStarterDocument(), 'Starter map');
      this.setMessage('New map. Double-click the background to add a node.');
      requestAnimationFrame(() => this.canvas.fitToContent());
    }

    this.toolbar.setFileState({ name: this.file.name, dirty: false });
    this.render();
  }

  /* ================================================================ *
   * Event wiring
   * ================================================================ */

  _wireEvents() {
    this.store.subscribe((doc, reason) => {
      this.dirty = true;
      this.toolbar.setFileState({ name: this.file.name, dirty: true });
      this.queueAutosave(doc);
      if (reason?.replaced) this.view.clearSelection();
      this.render();
    });

    this.view.addEventListener('change', () => this.render());

    this.canvas.addEventListener('create-requested', (event) => {
      const { x, y } = event.detail;
      this.createNodeAt(x, y);
    });
    this.canvas.addEventListener('node-activated', (event) => {
      this.view.selectNodes([event.detail.id]);
    });
    this.canvas.addEventListener('edge-created', () => this.render());

    this.inspector.addEventListener('navigate', (event) => this.goTo(event.detail.id));
    this.inspector.addEventListener('navigate-title', (event) => {
      this.goToTitle(event.detail.title, event.detail.from);
    });

    this.palette.addEventListener('navigate', (event) => this.goTo(event.detail.id));
    this.palette.addEventListener('create', (event) => {
      const { x, y } = this.canvas.viewCenter();
      this.createNodeAt(x, y, { title: event.detail.title, edit: false });
    });

    document.addEventListener('keydown', (event) => this.onKeyDown(event));

    globalThis.addEventListener('beforeunload', (event) => {
      if (!this.dirty || !this.file.connected) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  /* ================================================================ *
   * Rendering
   * ================================================================ */

  render() {
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = null;
      this.recomputeMatch();
      this.canvas.render(this.match);
      this.filters.setStats(this.match.nodes.size, Object.keys(this.store.doc.nodes).length);
      this.filters.render();
      this.inspector.render();
      this.toolbar.render();
      this.renderStatus();
    });
  }

  recomputeMatch() {
    const spec = buildEffectiveFilter(this.view);
    try {
      const nodes = selectNodes(spec, this.store.queryContext);
      this.match = { nodes, edges: selectEdges(nodes, this.store.doc) };
    } catch (err) {
      console.error('Filter failed', err);
      const nodes = new Set(Object.keys(this.store.doc.nodes));
      this.match = { nodes, edges: new Set(Object.keys(this.store.doc.edges)) };
      this.setMessage(`Filter error: ${err.message}`);
    }
  }

  renderStatus() {
    const doc = this.store.doc;
    const selected = this.view.selectedNodes.length;
    const orphans = this.store.graph.orphans().length;
    this.elements.status.innerHTML = '';
    const parts = [
      h('span', { text: `${Object.keys(doc.nodes).length} nodes · ${Object.keys(doc.edges).length} links` }),
      h('span', { text: `${this.match.nodes.size} shown` }),
      selected ? h('span', { text: `${selected} selected` }) : null,
      orphans ? h('button', {
        class: 'link-button',
        type: 'button',
        text: `${orphans} unlinked`,
        title: 'Show only nodes with no links',
        onclick: () => this.view.set({ advanced: { op: 'and', clauses: [{ op: 'orphan' }] } }),
      }) : null,
      this.message ? h('span', { class: 'status-message', text: this.message }) : null,
    ];
    this.elements.status.append(...parts.filter(Boolean));
  }

  setMessage(text) {
    this.message = text;
    clearTimeout(this._messageTimer);
    this._messageTimer = setTimeout(() => {
      this.message = '';
      this.render();
    }, 6000);
    this.render();
  }

  /* ================================================================ *
   * Node creation and navigation
   * ================================================================ */

  /**
   * Nudge a new node clear of existing cards.
   *
   * The test is the card's footprint rather than its centre point, because a
   * node dropped underneath another one is a node you will never find again.
   * The search steps downward first so a run of new siblings stacks in a
   * column instead of wandering off diagonally.
   */
  freeSpot(x, y) {
    const nodes = Object.values(this.store.doc.nodes);
    const clashes = (spot) => nodes.some(
      (n) => Math.abs(n.x - spot.x) < 205 && Math.abs(n.y - spot.y) < 86,
    );
    let candidate = { x, y };
    for (let attempt = 0; attempt < 60 && clashes(candidate); attempt += 1) {
      candidate = attempt % 5 === 4
        ? { x: candidate.x + 225, y }
        : { x: candidate.x, y: candidate.y + 96 };
    }
    return candidate;
  }

  createNodeAt(x, y, { title = '', tags, edit = true } = {}) {
    const spot = this.freeSpot(x, y);
    const id = runCommand('node.add', this.store, {
      title,
      x: spot.x,
      y: spot.y,
      // A node created while a label filter is on should satisfy that filter,
      // otherwise it vanishes the moment it is made.
      tags: tags ?? this.view.get('quick').include,
    });
    this.view.selectNodes([id]);
    if (edit) requestAnimationFrame(() => this.canvas.editTitle(id));
    return id;
  }

  addNodeAtCenter() {
    const { x, y } = this.canvas.viewCenter();
    return this.createNodeAt(x, y);
  }

  addChildOfSelected() {
    const parentId = this.view.soleSelectedNode;
    if (!parentId) { this.addNodeAtCenter(); return; }
    const parent = this.store.doc.nodes[parentId];
    const siblings = this.store.graph
      .neighbors(parentId, { direction: 'out', edgeTypes: this.store.graph.hierarchicalTypes() });
    const id = this.createNodeAt(
      parent.x + CHILD_OFFSET_X,
      parent.y + siblings.length * CHILD_OFFSET_Y,
      { tags: parent.tags },
    );
    runCommand('edge.add', this.store, { from: parentId, to: id, type: 'child' });
    return id;
  }

  addSiblingOfSelected() {
    const id = this.view.soleSelectedNode;
    if (!id) { this.addNodeAtCenter(); return; }
    const node = this.store.doc.nodes[id];
    const parents = this.store.graph
      .neighbors(id, { direction: 'in', edgeTypes: this.store.graph.hierarchicalTypes() });
    const created = this.createNodeAt(node.x, node.y + CHILD_OFFSET_Y, { tags: node.tags });
    for (const { other } of parents) {
      runCommand('edge.add', this.store, { from: other, to: created, type: 'child' });
    }
    return created;
  }

  goTo(id) {
    if (!this.store.doc.nodes[id]) return;
    this.view.selectNodes([id]);
    this.canvas.focusNode(id);
  }

  /** Follow a [[wiki link]]; offer to create the node if it doesn't exist. */
  goToTitle(title, fromId) {
    const target = Object.values(this.store.doc.nodes)
      .find((n) => n.title.toLowerCase() === String(title).toLowerCase());
    if (target) { this.goTo(target.id); return; }
    if (!globalThis.confirm(`No node called "${title}". Create it?`)) return;
    const from = this.store.doc.nodes[fromId];
    const id = this.createNodeAt(
      (from?.x ?? 0) + CHILD_OFFSET_X,
      (from?.y ?? 0) + CHILD_OFFSET_Y,
      { title, edit: false },
    );
    if (fromId) runCommand('edge.add', this.store, { from: fromId, to: id, type: 'references' });
    this.goTo(id);
  }

  /* ================================================================ *
   * Files
   * ================================================================ */

  queueAutosave(doc) {
    clearTimeout(this._autosaveTimer);
    this._autosaveTimer = setTimeout(() => saveAutosave(doc), AUTOSAVE_DELAY);
  }

  newMap() {
    if (this.dirty && !globalThis.confirm('Start a new map? Anything unsaved in this one is lost.')) return;
    this.file.forget();
    this.store.replaceDocument(createDocument({ title: 'Untitled map' }), 'New map');
    this.view.resetFilters();
    this.dirty = false;
    this.toolbar.setFileState({ name: null, dirty: false });
    this.setMessage('New map.');
  }

  async openFile() {
    try {
      const result = supportsFileSystemAccess ? await this.file.open() : await pickFileForUpload();
      if (!result?.doc) return;
      this.store.replaceDocument(result.doc, 'Open map');
      this.dirty = false;
      this.toolbar.setFileState({ name: this.file.name ?? result.filename ?? null, dirty: false });
      requestAnimationFrame(() => this.canvas.fitToContent());
      this.setMessage(result.problems?.length
        ? `Opened with ${result.problems.length} problem(s): ${result.problems[0]}`
        : `Opened ${this.file.name ?? result.filename ?? 'map'}.`);
    } catch (err) {
      if (err.name !== 'AbortError') this.setMessage(`Could not open: ${err.message}`);
    }
  }

  async save() {
    if (!supportsFileSystemAccess) {
      downloadDocument(this.store.doc);
      this.dirty = false;
      this.toolbar.setFileState({ name: 'downloaded copy', dirty: false });
      this.setMessage('Downloaded. This browser cannot write back to a file in place.');
      return;
    }
    if (!this.file.connected) { await this.saveAs(); return; }
    try {
      await this.file.save(this.store.doc);
      this.dirty = false;
      this.toolbar.setFileState({ name: this.file.name, dirty: false });
      this.setMessage(`Saved to ${this.file.name}.`);
    } catch (err) {
      this.setMessage(`Could not save: ${err.message}`);
    }
  }

  async saveAs() {
    if (!supportsFileSystemAccess) { this.save(); return; }
    try {
      const name = await this.file.saveAs(
        this.store.doc,
        `${(this.store.doc.title || 'map').replace(/[^\w.-]+/g, '-')}.mindmap.json`,
      );
      this.dirty = false;
      this.toolbar.setFileState({ name, dirty: false });
      this.setMessage(`Saved to ${name}.`);
    } catch (err) {
      if (err.name !== 'AbortError') this.setMessage(`Could not save: ${err.message}`);
    }
  }

  /* ================================================================ *
   * Keyboard
   * ================================================================ */

  /**
   * Single-letter shortcuts only apply when attention is on the map. Without
   * this, Tab would create a node instead of moving between panel controls.
   */
  isCanvasFocus() {
    const element = document.activeElement;
    return !element || element === document.body || this.elements.canvas.contains(element);
  }

  isTyping() {
    const element = document.activeElement;
    if (!element) return false;
    return element.matches('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]');
  }

  onKeyDown(event) {
    const mod = event.ctrlKey || event.metaKey;

    if (mod && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.palette.open();
      return;
    }
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.save();
      return;
    }
    if (mod && event.key.toLowerCase() === 'z') {
      // Let the browser handle undo inside a text field.
      if (this.isTyping()) return;
      event.preventDefault();
      if (event.shiftKey) this.store.redo();
      else this.store.undo();
      return;
    }

    if (this.palette.isOpen || this.canvas.isEditingTitle) return;
    if (this.isTyping()) {
      if (event.key === 'Escape') document.activeElement.blur();
      return;
    }

    const selected = this.view.selectedNodes;

    if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      this.view.selectNodes([...this.match.nodes]);
      return;
    }

    if (event.key === 'Escape') {
      this.canvas._endDrag(null);
      this.view.clearSelection();
      return;
    }
    if (!this.isCanvasFocus()) return;

    switch (event.key) {
      case 'n':
        event.preventDefault();
        this.addNodeAtCenter();
        return;
      case 'Tab':
        event.preventDefault();
        this.addChildOfSelected();
        return;
      case 'Enter':
        if (selected.length === 1) {
          event.preventDefault();
          if (event.shiftKey) this.addSiblingOfSelected();
          else this.canvas.editTitle(selected[0]);
        }
        return;
      case 'Delete':
      case 'Backspace':
        if (selected.length) {
          event.preventDefault();
          this.inspector.confirmDelete(selected);
        } else if (this.view.selectedEdges.length) {
          event.preventDefault();
          runCommand('edge.delete', this.store, { ids: this.view.selectedEdges });
          this.view.clearSelection();
        }
        return;
      case 't':
        if (selected.length) {
          event.preventDefault();
          runCommand('node.cycleStatus', this.store, { ids: selected });
        }
        return;
      case 'l':
        if (selected.length === 1) {
          event.preventDefault();
          this.canvas.startLinkFrom(selected[0]);
          this.setMessage('Drag onto another card to link. Escape cancels.');
        }
        return;
      case 'e':
        if (selected.length === 1) {
          event.preventDefault();
          this.view.set({ focus: { ...this.view.get('focus'), node: selected[0], mode: 'within' } });
        }
        return;
      case 'f':
        event.preventDefault();
        this.canvas.fitToContent(this.match.nodes);
        return;
      case '=':
      case '+':
        event.preventDefault();
        this.canvas.zoomBy(1.25);
        return;
      case '-':
        event.preventDefault();
        this.canvas.zoomBy(1 / 1.25);
        return;
      case '0':
        event.preventDefault();
        this.canvas.setCamera({ zoom: 1 }, { quiet: false });
        return;
      default:
        break;
    }

    if (event.key.startsWith('Arrow')) {
      const step = event.shiftKey ? 50 : 10;
      const delta = {
        ArrowUp: { x: 0, y: -step },
        ArrowDown: { x: 0, y: step },
        ArrowLeft: { x: -step, y: 0 },
        ArrowRight: { x: step, y: 0 },
      }[event.key];
      event.preventDefault();
      if (selected.length) {
        const positions = {};
        for (const id of selected) {
          const node = this.store.doc.nodes[id];
          if (node) positions[id] = { x: node.x + delta.x, y: node.y + delta.y };
        }
        runCommand('node.move', this.store, { positions });
      } else {
        this.canvas.setCamera({
          x: this.canvas.camera.x - delta.x,
          y: this.canvas.camera.y - delta.y,
        }, { quiet: false });
      }
    }
  }

  showHelp() {
    const dialog = document.querySelector('#help-dialog');
    if (dialog?.showModal) dialog.showModal();
  }
}
