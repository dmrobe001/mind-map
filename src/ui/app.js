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
import { saveAutosave, loadAutosave } from '../core/persistence.js';
import { FileIndex } from '../core/fileindex.js';
import { bestLocatorForPath, basename } from '../core/locators.js';
import { createPlatform } from '../platform/index.js';

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
    // What this environment can do with files. Everything else asks the
    // platform rather than sniffing for a native runtime.
    this.platform = createPlatform();
    this.fileIndex = new FileIndex(this.platform);
    this.dirty = false;
    this.pending = null;
    this.match = { nodes: new Set(), edges: new Set() };

    this.canvas = new Canvas({ root: this.elements.canvas, store: this.store, view: this.view });
    this.filters = new FilterPanel({ root: this.elements.left, store: this.store, view: this.view });
    this.inspector = new Inspector({
      root: this.elements.right,
      store: this.store,
      view: this.view,
      platform: this.platform,
      fileIndex: this.fileIndex,
    });
    this.palette = new Palette({ store: this.store, view: this.view });
    this.toolbar = new Toolbar({
      root: this.elements.toolbar,
      store: this.store,
      view: this.view,
      platform: this.platform,
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
        roots: () => this.showRoots(),
        importFolder: () => this.importFolder(),
      },
    });

    this._wireEvents();
  }

  /* ================================================================ *
   * Startup
   * ================================================================ */

  async start() {
    await this.platform.init().catch((err) => console.warn('Platform init failed', err));

    // Where the native build is concerned the file on disk is authoritative,
    // so reopening the last map beats restoring a browser-local snapshot of
    // it. Anything unsaved still lives in the autosave as a fallback.
    const lastPath = this.platform.settings?.lastMapPath;
    let opened = false;
    if (this.platform.can.realPaths && lastPath) {
      try {
        const result = await this.platform.openMapAt(lastPath);
        this.store.replaceDocument(result.doc, 'Reopen map');
        this.setMessage(`Reopened ${basename(lastPath)}.`);
        opened = true;
      } catch {
        this.setMessage(`Could not reopen ${basename(lastPath)}; it may have moved.`);
      }
    }

    if (!opened) {
      const autosaved = loadAutosave();
      if (autosaved) {
        this.store.replaceDocument(autosaved, 'Restore session');
        this.setMessage('Restored your last session.');
      } else {
        this.store.replaceDocument(createStarterDocument(), 'Starter map');
        this.setMessage('New map. Double-click the background to add a node.');
        requestAnimationFrame(() => this.canvas.fitToContent());
      }
    }

    this.dirty = false;
    this.toolbar.setFileState({ name: this.platform.connectedName, dirty: false });
    this.render();
    this.refreshFileIndex({ force: true });
  }

  /* ================================================================ *
   * Event wiring
   * ================================================================ */

  _wireEvents() {
    this.store.subscribe((doc, reason) => {
      this.dirty = true;
      this.toolbar.setFileState({ name: this.platform.connectedName, dirty: true });
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

    this.fileIndex.addEventListener('change', () => this.render());

    // A native window has no tabs to open a link into, so web links are handed
    // to the system browser instead of navigating the app away from itself.
    document.addEventListener('click', (event) => {
      const anchor = event.target.closest('a[href^="http"]');
      if (!anchor || this.platform.id === 'browser') return;
      event.preventDefault();
      this.platform.openUrl(anchor.href).catch((err) => this.setMessage(err.message));
    });

    document.addEventListener('keydown', (event) => this.onKeyDown(event));

    globalThis.addEventListener('beforeunload', (event) => {
      if (!this.dirty || !this.platform.connectedName) return;
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
      this.refreshFileIndex();
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
      this.fileSummaryElement(),
      this.message ? h('span', { class: 'status-message', text: this.message }) : null,
    ];
    this.elements.status.append(...parts.filter(Boolean));
  }

  /** "3 of 11 files here" — the one number that says whether links will work. */
  fileSummaryElement() {
    if (!this.platform.can.realPaths) return null;
    const { present, total } = this.fileIndex.summary();
    if (!total) return null;
    return h('button', {
      class: 'link-button',
      type: 'button',
      text: `${present} of ${total} files here`,
      title: 'Show only nodes that reference a file',
      onclick: () => this.view.set({ advanced: { op: 'and', clauses: [{ op: 'filePath', query: '' }] } }),
    });
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
    this.platform.forgetFile();
    this.rememberLastPath(null);
    this.store.replaceDocument(createDocument({ title: 'Untitled map' }), 'New map');
    this.view.resetFilters();
    this.dirty = false;
    this.toolbar.setFileState({ name: null, dirty: false });
    this.setMessage('New map.');
  }

  async openFile() {
    try {
      const result = await this.platform.openMap();
      if (!result?.doc) return;
      this.store.replaceDocument(result.doc, 'Open map');
      this.dirty = false;
      this.rememberLastPath(result.path ?? null);
      this.toolbar.setFileState({ name: this.platform.connectedName ?? result.filename, dirty: false });
      requestAnimationFrame(() => this.canvas.fitToContent());
      this.refreshFileIndex({ force: true });
      this.setMessage(result.problems?.length
        ? `Opened with ${result.problems.length} problem(s): ${result.problems[0]}`
        : `Opened ${result.filename ?? 'map'}.`);
    } catch (err) {
      if (err.name !== 'AbortError') this.setMessage(`Could not open: ${err.message}`);
    }
  }

  async save() {
    try {
      const name = await this.platform.saveMap(this.store.doc);
      this.dirty = false;
      this.rememberLastPath(this.platform.currentPath ?? null);
      this.toolbar.setFileState({ name: this.platform.connectedName ?? name, dirty: false });
      this.setMessage(this.platform.can.saveInPlace
        ? `Saved to ${name}.`
        : 'Downloaded. This browser cannot write back to a file in place.');
    } catch (err) {
      if (err.name !== 'AbortError') this.setMessage(`Could not save: ${err.message}`);
    }
  }

  async saveAs() {
    try {
      const name = await this.platform.saveMapAs(
        this.store.doc,
        `${(this.store.doc.title || 'map').replace(/[^\w.-]+/g, '-')}.mindmap.json`,
      );
      this.dirty = false;
      this.rememberLastPath(this.platform.currentPath ?? null);
      this.toolbar.setFileState({ name: this.platform.connectedName ?? name, dirty: false });
      this.setMessage(`Saved to ${name}.`);
    } catch (err) {
      if (err.name !== 'AbortError') this.setMessage(`Could not save: ${err.message}`);
    }
  }

  /** Per-machine, never in the document — see core/locators.js. */
  async rememberLastPath(path) {
    if (!this.platform.can.realPaths) return;
    await this.platform.writeSettings({ ...this.platform.settings, lastMapPath: path });
  }

  /* ================================================================ *
   * Files referenced by the map
   * ================================================================ */

  get locatorContext() {
    return {
      deviceRoots: this.platform.settings?.roots ?? {},
      separator: this.platform.device?.separator ?? '/',
    };
  }

  refreshFileIndex(options = {}) {
    this.fileIndex.refresh(this.store.doc, this.locatorContext, options);
  }

  /**
   * Point at a folder and get a node per file, hanging off the selection.
   *
   * This is the closest thing to the "a layer over my filesystem" idea that
   * holds up: the folder becomes a neighbourhood of the map, and from there
   * the files can be linked to anything, which is the part a directory tree
   * cannot do.
   */
  async importFolder() {
    if (!this.platform.can.browseDirectories) {
      this.setMessage('Only the desktop app can browse folders.');
      return;
    }
    const folder = await this.platform.pickDirectory();
    if (!folder) return;

    let listing;
    try {
      listing = await this.platform.listDir(folder, { includeHidden: false });
    } catch (err) {
      this.setMessage(`Could not read that folder: ${err.message}`);
      return;
    }

    const files = listing.filter((entry) => !entry.isDir);
    if (!files.length) {
      this.setMessage('That folder has no files in it.');
      return;
    }
    if (!globalThis.confirm(`Create ${files.length} node(s) from ${basename(folder)}?`)) return;

    let parentId = this.view.soleSelectedNode;
    if (!parentId) {
      const { x, y } = this.canvas.viewCenter();
      parentId = this.createNodeAt(x, y, { title: basename(folder), edit: false });
    }

    const entries = files.map((entry) => ({
      title: entry.name,
      fields: { source: 'folder-import' },
      locator: bestLocatorForPath(entry.path, {
        deviceRoots: this.locatorContext.deviceRoots,
        device: this.platform.device,
      }),
    }));

    const created = runCommand('node.importFiles', this.store, { parentId, entries });
    this.refreshFileIndex({ force: true });
    this.setMessage(created.length
      ? `Added ${created.length} node(s) from ${basename(folder)}.`
      : 'Everything in that folder was already on the map.');
  }

  /**
   * Map this machine's paths onto the document's named roots.
   *
   * The roots themselves belong to the document so they travel; the paths
   * belong to the machine so they do not.
   */
  showRoots() {
    const dialog = document.querySelector('#roots-dialog');
    const body = dialog.querySelector('.dialog-body');
    const deviceRoots = { ...(this.platform.settings?.roots ?? {}) };

    const persist = async () => {
      await this.platform.writeSettings({ ...this.platform.settings, roots: deviceRoots });
      this.refreshFileIndex({ force: true });
      this.render();
    };

    const draw = () => {
      body.innerHTML = '';
      for (const root of Object.values(this.store.doc.roots ?? {})) {
        body.append(h('div', { class: 'root-row' }, [
          h('div', { class: 'root-head' }, [
            h('strong', { text: root.label }),
            h('button', {
              type: 'button', class: 'mini danger', text: 'remove root',
              title: 'Remove this root from the map for every machine',
              onclick: () => {
                if (!globalThis.confirm(`Remove the "${root.label}" root from this map?`)) return;
                runCommand('root.delete', this.store, { id: root.id });
                draw();
              },
            }),
          ]),
          root.hint ? h('p', { class: 'hint', text: root.hint }) : null,
          h('div', { class: 'field-row' }, [
            h('input', {
              type: 'text',
              class: 'grow',
              value: deviceRoots[root.id] ?? '',
              placeholder: this.platform.can.realPaths
                ? 'not set on this machine'
                : 'a browser tab cannot resolve paths',
              oninput: (event) => { deviceRoots[root.id] = event.target.value.trim(); },
              onchange: persist,
            }),
            this.platform.can.browseDirectories
              ? h('button', {
                type: 'button', class: 'mini', text: 'browse…',
                onclick: async () => {
                  const picked = await this.platform.pickDirectory();
                  if (!picked) return;
                  deviceRoots[root.id] = picked;
                  await persist();
                  draw();
                },
              })
              : null,
          ]),
        ]));
      }

      body.append(h('form', {
        class: 'inline-form',
        onsubmit: (event) => {
          event.preventDefault();
          const input = event.target.querySelector('input');
          const label = input.value.trim();
          if (!label) return;
          runCommand('root.create', this.store, { label });
          input.value = '';
          draw();
        },
      }, [
        h('input', { type: 'text', placeholder: 'New root, e.g. "Work laptop"' }),
        h('button', { type: 'submit', class: 'mini', text: 'add' }),
      ]));

      const device = this.platform.device;
      body.append(h('p', {
        class: 'hint',
        text: device?.name
          ? `This machine is "${device.name}". Root names are saved in the map; these paths are not.`
          : 'Root names are saved in the map; the paths you set here stay on this machine.',
      }));
    };

    draw();
    dialog.showModal();
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
