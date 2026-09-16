/**
 * The canvas: pan/zoom surface, node cards, edges, and all direct
 * manipulation.
 *
 * Node cards are ordinary HTML positioned in world coordinates; edges are a
 * single overflowing SVG layer behind them. That split is what lets a card
 * hold wrapped text, checkboxes and tag chips without any of the pain of
 * laying out text inside SVG.
 *
 * Both layers sit inside one transformed `.viewport`, so the camera is a
 * single CSS transform and world coordinates never have to be converted for
 * rendering — only for pointer input.
 */

import { runCommand } from '../core/commands.js';
import { rendererFor } from '../content/renderers.js';

const NODE_WIDTH = 190;
const CLICK_SLOP = 4;
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 4;

const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};

export class Canvas extends EventTarget {
  constructor({ root, store, view }) {
    super();
    this.root = root;
    this.store = store;
    this.view = view;

    this.nodeEls = new Map();
    this.sizes = new Map();
    this.match = { nodes: new Set(), edges: new Set() };
    this.drag = null;

    this.root.classList.add('canvas');
    this.root.innerHTML = '';

    this.viewport = document.createElement('div');
    this.viewport.className = 'viewport';

    // width/height of 1 with overflow visible: the SVG paints the whole plane
    // without allocating a surface the size of the plane.
    this.svg = svgEl('svg', { class: 'edge-layer', width: 1, height: 1 });
    this.defs = svgEl('defs');
    this.edgeGroup = svgEl('g', { class: 'edges' });
    this.overlayGroup = svgEl('g', { class: 'overlay' });
    this.svg.append(this.defs, this.edgeGroup, this.overlayGroup);

    this.nodeLayer = document.createElement('div');
    this.nodeLayer.className = 'node-layer';

    this.viewport.append(this.svg, this.nodeLayer);

    this.marquee = document.createElement('div');
    this.marquee.className = 'marquee hidden';

    this.root.append(this.viewport, this.marquee);

    this._bindEvents();
    this.applyCamera();
  }

  /* ================================================================ *
   * Camera
   * ================================================================ */

  get camera() {
    return this.view.get('camera');
  }

  applyCamera() {
    const { x, y, zoom } = this.camera;
    this.viewport.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    this.root.style.setProperty('--zoom', String(zoom));
    this._markTransforming();
  }

  /**
   * Flags the viewport as actively transforming so the compositor promotes
   * it to a GPU layer for smooth panning/zooming, then drops the flag once
   * the camera settles so it re-rasterizes node cards crisply at rest. See
   * the `.viewport.is-transforming` comment in styles.css for why this needs
   * to be transient rather than permanent.
   */
  _markTransforming() {
    this.viewport.classList.add('is-transforming');
    clearTimeout(this._transformSettleTimer);
    this._transformSettleTimer = setTimeout(() => {
      this.viewport.classList.remove('is-transforming');
    }, 200);
  }

  screenToWorld(clientX, clientY) {
    const rect = this.root.getBoundingClientRect();
    const { x, y, zoom } = this.camera;
    return {
      x: (clientX - rect.left - x) / zoom,
      y: (clientY - rect.top - y) / zoom,
    };
  }

  /** World coordinate at the middle of the visible area. */
  viewCenter() {
    const rect = this.root.getBoundingClientRect();
    return this.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  setCamera(patch, { quiet = true } = {}) {
    this.view.set({ camera: { ...this.camera, ...patch } }, { quiet });
    this.applyCamera();
  }

  zoomAt(factor, clientX, clientY) {
    const { zoom, x, y } = this.camera;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
    if (next === zoom) return;
    const rect = this.root.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    // Keep the world point under the cursor pinned to the cursor.
    this.setCamera({
      zoom: next,
      x: px - ((px - x) / zoom) * next,
      y: py - ((py - y) / zoom) * next,
    });
  }

  zoomBy(factor) {
    const rect = this.root.getBoundingClientRect();
    this.zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
    this.view.persist();
  }

  centerOn(worldX, worldY, zoom = this.camera.zoom) {
    const rect = this.root.getBoundingClientRect();
    this.setCamera({
      zoom,
      x: rect.width / 2 - worldX * zoom,
      y: rect.height / 2 - worldY * zoom,
    }, { quiet: false });
  }

  focusNode(id, { zoom } = {}) {
    const node = this.store.doc.nodes[id];
    if (!node) return;
    this.centerOn(node.x, node.y, zoom ?? Math.max(this.camera.zoom, 0.8));
  }

  /** Frame everything currently passing the filter, or everything if nothing does. */
  fitToContent(ids = null) {
    const nodes = Object.values(this.store.doc.nodes)
      .filter((n) => !ids || ids.has(n.id));
    if (!nodes.length) return;
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const pad = 140;
    const minX = Math.min(...xs) - pad;
    const maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad;
    const maxY = Math.max(...ys) + pad;
    const rect = this.root.getBoundingClientRect();
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min(rect.width / (maxX - minX), rect.height / (maxY - minY))),
    );
    this.centerOn((minX + maxX) / 2, (minY + maxY) / 2, zoom);
  }

  /* ================================================================ *
   * Rendering
   * ================================================================ */

  /**
   * @param {{nodes: Set<string>, edges: Set<string>}} match  filter results
   */
  render(match) {
    if (match) this.match = match;
    this.renderNodes();
    this.renderEdges();
  }

  renderNodes() {
    const doc = this.store.doc;
    const selected = new Set(this.view.selectedNodes);
    const dim = this.view.get('dimInsteadOfHide');
    const seen = new Set();

    for (const node of Object.values(doc.nodes)) {
      seen.add(node.id);
      let element = this.nodeEls.get(node.id);
      if (!element) {
        element = this.createNodeElement(node.id);
        this.nodeEls.set(node.id, element);
        this.nodeLayer.append(element);
      }
      this.updateNodeElement(element, node, doc);

      const matched = this.match.nodes.has(node.id);
      element.classList.toggle('is-dimmed', !matched && dim);
      element.classList.toggle('is-hidden', !matched && !dim);
      element.classList.toggle('is-selected', selected.has(node.id));
      element.style.left = `${node.x}px`;
      element.style.top = `${node.y}px`;

      this.sizes.set(node.id, { w: element.offsetWidth || NODE_WIDTH, h: element.offsetHeight || 60 });
    }

    for (const [id, element] of this.nodeEls) {
      if (seen.has(id)) continue;
      element.remove();
      this.nodeEls.delete(id);
      this.sizes.delete(id);
    }
  }

  createNodeElement(id) {
    const element = document.createElement('div');
    element.className = 'node';
    element.dataset.id = id;
    element.style.width = `${NODE_WIDTH}px`;
    element.innerHTML = `
      <button class="node-status" type="button" title="Cycle status (t)"></button>
      <div class="node-title" tabindex="0"></div>
      <div class="node-summary"></div>
      <div class="node-tags"></div>
      <div class="node-content-hint"></div>
      <button class="link-handle" type="button" title="Drag to link"></button>`;
    return element;
  }

  updateNodeElement(element, node, doc) {
    const title = element.querySelector('.node-title');
    if (!title.isContentEditable && title.textContent !== node.title) {
      title.textContent = node.title;
    }

    const summary = element.querySelector('.node-summary');
    summary.textContent = node.summary ?? '';
    summary.classList.toggle('hidden', !node.summary);

    const statusButton = element.querySelector('.node-status');
    const status = node.status ? doc.statusTypes[node.status] : null;
    statusButton.dataset.status = node.status ?? '';
    statusButton.textContent = status ? (status.done ? '✓' : '○') : '';
    statusButton.classList.toggle('hidden', !status);
    statusButton.style.setProperty('--status-color', status?.color ?? 'transparent');
    element.classList.toggle('is-done', Boolean(status?.done));

    const tags = element.querySelector('.node-tags');
    tags.innerHTML = '';
    for (const tagId of node.tags) {
      const tag = doc.tagTypes[tagId];
      const chip = document.createElement('span');
      chip.className = 'node-tag';
      chip.textContent = tag?.label ?? tagId;
      chip.style.setProperty('--tag-color', tag?.color ?? '#8a8f98');
      tags.append(chip);
    }
    tags.classList.toggle('hidden', node.tags.length === 0);

    const hint = element.querySelector('.node-content-hint');
    if (node.content?.length) {
      const first = node.content[0];
      const preview = rendererFor(first.type).preview?.(first) ?? first.type;
      hint.textContent = `${node.content.length} block${node.content.length > 1 ? 's' : ''} · ${preview || first.type}`;
      hint.classList.remove('hidden');
    } else {
      hint.classList.add('hidden');
    }

    element.style.setProperty('--node-accent', node.color ?? '');
    element.classList.toggle('has-accent', Boolean(node.color));
  }

  renderEdges() {
    const doc = this.store.doc;
    const dim = this.view.get('dimInsteadOfHide');
    const selected = new Set(this.view.selectedEdges);

    this.defs.innerHTML = '';
    for (const type of Object.values(doc.edgeTypes)) {
      const marker = svgEl('marker', {
        id: `arrow-${type.id}`,
        viewBox: '0 0 10 10',
        refX: 9,
        refY: 5,
        markerWidth: 6,
        markerHeight: 6,
        orient: 'auto-start-reverse',
      });
      marker.append(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: type.color ?? '#8a8f98' }));
      this.defs.append(marker);
    }

    this.edgeGroup.innerHTML = '';

    // Edges sharing a node pair fan out so none of them hide the others.
    const pairCounts = new Map();
    const pairKey = (a, b) => [a, b].sort().join('|');
    for (const edge of Object.values(doc.edges)) {
      const key = pairKey(edge.from, edge.to);
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
    const pairSeen = new Map();

    for (const edge of Object.values(doc.edges)) {
      const type = doc.edgeTypes[edge.type] ?? { color: '#8a8f98', directed: true };
      const key = pairKey(edge.from, edge.to);
      const index = pairSeen.get(key) ?? 0;
      pairSeen.set(key, index + 1);
      const spread = pairCounts.get(key) > 1
        ? (index - (pairCounts.get(key) - 1) / 2) * 26
        : 0;

      const geometry = this.edgeGeometry(edge, spread);
      if (!geometry) continue;

      const group = svgEl('g', { class: 'edge' });
      group.dataset.id = edge.id;

      const matched = this.match.edges.has(edge.id);
      if (!matched) group.classList.add(dim ? 'is-dimmed' : 'is-hidden');
      if (selected.has(edge.id)) group.classList.add('is-selected');

      // A fat transparent path underneath makes thin edges clickable.
      group.append(svgEl('path', { class: 'edge-hit', d: geometry.d }));
      const path = svgEl('path', {
        class: 'edge-line',
        d: geometry.d,
        stroke: type.color ?? '#8a8f98',
      });
      if (type.directed !== false) path.setAttribute('marker-end', `url(#arrow-${edge.type})`);
      group.append(path);

      if (edge.label) {
        const label = svgEl('text', {
          class: 'edge-label',
          x: geometry.mid.x,
          y: geometry.mid.y - 4,
          'text-anchor': 'middle',
        });
        label.textContent = edge.label;
        group.append(label);
      }

      this.edgeGroup.append(group);
    }
  }

  /** Straight segment between two cards, trimmed to their borders. */
  edgeGeometry(edge, spread = 0) {
    const from = this.store.doc.nodes[edge.from];
    const to = this.store.doc.nodes[edge.to];
    if (!from || !to) return null;

    const a = { x: from.x, y: from.y };
    const b = { x: to.x, y: to.y };
    if (spread) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy) || 1;
      const nx = -dy / length;
      const ny = dx / length;
      a.x += nx * spread * 0.4; a.y += ny * spread * 0.4;
      b.x += nx * spread * 0.4; b.y += ny * spread * 0.4;
    }

    const start = this.clipToBox(a, b, this.sizes.get(edge.from));
    const end = this.clipToBox(b, a, this.sizes.get(edge.to));
    return {
      d: `M ${start.x} ${start.y} L ${end.x} ${end.y}`,
      mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    };
  }

  /** Move `center` outward along the direction of `toward` to the card border. */
  clipToBox(center, toward, size) {
    const halfW = (size?.w ?? NODE_WIDTH) / 2 + 4;
    const halfH = (size?.h ?? 60) / 2 + 4;
    const dx = toward.x - center.x;
    const dy = toward.y - center.y;
    if (!dx && !dy) return { ...center };
    const scale = Math.min(
      Math.abs(dx) > 1e-6 ? halfW / Math.abs(dx) : Infinity,
      Math.abs(dy) > 1e-6 ? halfH / Math.abs(dy) : Infinity,
    );
    return { x: center.x + dx * scale, y: center.y + dy * scale };
  }

  /** Redraw only what a drag touched, so dragging stays smooth on big maps. */
  refreshDraggedEdges() {
    this.renderEdges();
  }

  /* ================================================================ *
   * Interaction
   * ================================================================ */

  _bindEvents() {
    this.root.addEventListener('pointerdown', (event) => this._onPointerDown(event));
    this.root.addEventListener('pointermove', (event) => this._onPointerMove(event));
    this.root.addEventListener('pointerup', (event) => this._onPointerUp(event));
    this.root.addEventListener('pointercancel', () => this._endDrag(null));
    this.root.addEventListener('wheel', (event) => this._onWheel(event), { passive: false });
    this.root.addEventListener('dblclick', (event) => this._onDoubleClick(event));
    this.root.addEventListener('contextmenu', (event) => this._onContextMenu(event));
  }

  _onWheel(event) {
    event.preventDefault();
    if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
      this.setCamera({ x: this.camera.x - event.deltaY, y: this.camera.y });
      return;
    }
    const factor = Math.exp(-event.deltaY * 0.0015);
    this.zoomAt(factor, event.clientX, event.clientY);
  }

  _onPointerDown(event) {
    if (event.button === 2) return;
    const nodeEl = event.target.closest('.node');
    const edgeEl = event.target.closest('.edge');

    if (event.target.closest('.node-title')?.isContentEditable) return;

    if (event.target.closest('.node-status') && nodeEl) {
      event.preventDefault();
      runCommand('node.cycleStatus', this.store, { ids: [nodeEl.dataset.id] });
      return;
    }

    if (event.target.closest('.link-handle') && nodeEl) {
      event.preventDefault();
      this.startLinkFrom(nodeEl.dataset.id, event);
      return;
    }

    if (nodeEl) {
      event.preventDefault();
      this._startNodeDrag(nodeEl, event);
      return;
    }

    if (edgeEl) {
      event.preventDefault();
      this.view.selectEdges([edgeEl.dataset.id], { additive: event.shiftKey });
      return;
    }

    // Background.
    event.preventDefault();
    if (event.shiftKey) this._startMarquee(event);
    else this._startPan(event);
  }

  _startPan(event) {
    this.root.setPointerCapture(event.pointerId);
    this.root.classList.add('is-panning');
    this.drag = {
      kind: 'pan',
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...this.camera },
      moved: false,
    };
  }

  _startMarquee(event) {
    this.root.setPointerCapture(event.pointerId);
    const rect = this.root.getBoundingClientRect();
    this.drag = {
      kind: 'marquee',
      startX: event.clientX - rect.left,
      startY: event.clientY - rect.top,
      additive: event.altKey,
      moved: false,
    };
    this.marquee.classList.remove('hidden');
  }

  _startNodeDrag(nodeEl, event) {
    const id = nodeEl.dataset.id;
    const selection = this.view.selectedNodes;

    if (event.shiftKey) {
      this.view.toggleNode(id);
    } else if (!selection.includes(id)) {
      this.view.selectNodes([id]);
    }

    const ids = this.view.selectedNodes.includes(id) ? this.view.selectedNodes : [id];
    const origin = {};
    for (const nodeId of ids) {
      const node = this.store.doc.nodes[nodeId];
      if (node) origin[nodeId] = { x: node.x, y: node.y };
    }

    this.root.setPointerCapture(event.pointerId);
    this.drag = {
      kind: 'node',
      id,
      ids,
      origin,
      startX: event.clientX,
      startY: event.clientY,
      live: {},
      moved: false,
    };
  }

  startLinkFrom(id, event) {
    const node = this.store.doc.nodes[id];
    if (!node) return;
    if (event) this.root.setPointerCapture(event.pointerId);
    this.drag = { kind: 'link', from: id, moved: false, target: null };
    this.linkPreview = svgEl('path', { class: 'link-preview', d: '' });
    this.overlayGroup.append(this.linkPreview);
    this.root.classList.add('is-linking');
    if (!event) {
      // Keyboard-initiated: follow the pointer until the next click.
      this.drag.keyboard = true;
    }
  }

  _onPointerMove(event) {
    const drag = this.drag;
    if (!drag) return;
    const dx = event.clientX - (drag.startX ?? event.clientX);
    const dy = event.clientY - (drag.startY ?? event.clientY);
    if (Math.abs(dx) > CLICK_SLOP || Math.abs(dy) > CLICK_SLOP) drag.moved = true;

    if (drag.kind === 'pan') {
      this.setCamera({ x: drag.origin.x + dx, y: drag.origin.y + dy });
      return;
    }

    if (drag.kind === 'node') {
      const { zoom } = this.camera;
      for (const id of drag.ids) {
        const start = drag.origin[id];
        if (!start) continue;
        const next = { x: start.x + dx / zoom, y: start.y + dy / zoom };
        drag.live[id] = next;
        const element = this.nodeEls.get(id);
        if (element) {
          element.style.left = `${next.x}px`;
          element.style.top = `${next.y}px`;
        }
        // Edge geometry reads positions from the document, so mirror the live
        // position there for redraw purposes only; the undoable move is
        // committed once, on pointerup.
        const node = this.store.doc.nodes[id];
        if (node) { node.x = next.x; node.y = next.y; }
      }
      this.refreshDraggedEdges();
      return;
    }

    if (drag.kind === 'link') {
      const from = this.store.doc.nodes[drag.from];
      const point = this.screenToWorld(event.clientX, event.clientY);
      const start = this.clipToBox({ x: from.x, y: from.y }, point, this.sizes.get(drag.from));
      this.linkPreview.setAttribute('d', `M ${start.x} ${start.y} L ${point.x} ${point.y}`);
      const hovered = document.elementFromPoint(event.clientX, event.clientY)?.closest('.node');
      const targetId = hovered?.dataset.id;
      if (drag.target !== targetId) {
        this.nodeEls.get(drag.target)?.classList.remove('is-link-target');
        drag.target = targetId && targetId !== drag.from ? targetId : null;
        if (drag.target) this.nodeEls.get(drag.target)?.classList.add('is-link-target');
      }
      return;
    }

    if (drag.kind === 'marquee') {
      const rect = this.root.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const left = Math.min(x, drag.startX);
      const top = Math.min(y, drag.startY);
      this.marquee.style.left = `${left}px`;
      this.marquee.style.top = `${top}px`;
      this.marquee.style.width = `${Math.abs(x - drag.startX)}px`;
      this.marquee.style.height = `${Math.abs(y - drag.startY)}px`;
      drag.rect = { left, top, right: Math.max(x, drag.startX), bottom: Math.max(y, drag.startY) };
    }
  }

  _onPointerUp(event) {
    const drag = this.drag;
    if (!drag) return;

    if (drag.kind === 'node') {
      if (drag.moved && Object.keys(drag.live).length) {
        // Put the document back before committing, so the command produces a
        // clean undo step from the original positions.
        for (const [id, pos] of Object.entries(drag.origin)) {
          const node = this.store.doc.nodes[id];
          if (node) { node.x = pos.x; node.y = pos.y; }
        }
        runCommand('node.move', this.store, { positions: drag.live });
      } else if (!drag.moved && !event.shiftKey) {
        this.view.selectNodes([drag.id]);
      }
    }

    if (drag.kind === 'link' && drag.target) {
      const id = runCommand('edge.add', this.store, {
        from: drag.from,
        to: drag.target,
        type: this.view.get('newEdgeType'),
      });
      if (id) this.dispatchEvent(new CustomEvent('edge-created', { detail: { id } }));
    }

    if (drag.kind === 'marquee' && drag.rect) {
      const ids = this._nodesInScreenRect(drag.rect);
      this.view.selectNodes(ids, { additive: drag.additive });
    }

    if (drag.kind === 'pan' && !drag.moved) {
      this.view.clearSelection();
    }

    this._endDrag(event);
  }

  _endDrag(event) {
    if (event && this.root.hasPointerCapture?.(event.pointerId)) {
      this.root.releasePointerCapture(event.pointerId);
    }
    if (this.drag?.target) this.nodeEls.get(this.drag.target)?.classList.remove('is-link-target');
    this.linkPreview?.remove();
    this.linkPreview = null;
    this.marquee.classList.add('hidden');
    this.root.classList.remove('is-panning', 'is-linking');
    this.drag = null;
    this.view.persist();
  }

  _nodesInScreenRect(rect) {
    const containerRect = this.root.getBoundingClientRect();
    const out = [];
    for (const [id, element] of this.nodeEls) {
      if (element.classList.contains('is-hidden')) continue;
      const box = element.getBoundingClientRect();
      const left = box.left - containerRect.left;
      const top = box.top - containerRect.top;
      if (left + box.width >= rect.left && left <= rect.right
        && top + box.height >= rect.top && top <= rect.bottom) {
        out.push(id);
      }
    }
    return out;
  }

  _onDoubleClick(event) {
    const nodeEl = event.target.closest('.node');
    if (nodeEl) {
      if (event.target.closest('.node-title')) {
        this.editTitle(nodeEl.dataset.id);
      } else {
        this.dispatchEvent(new CustomEvent('node-activated', { detail: { id: nodeEl.dataset.id } }));
      }
      return;
    }
    const edgeEl = event.target.closest('.edge');
    if (edgeEl) {
      this.view.selectEdges([edgeEl.dataset.id]);
      return;
    }
    const point = this.screenToWorld(event.clientX, event.clientY);
    this.dispatchEvent(new CustomEvent('create-requested', { detail: point }));
  }

  _onContextMenu(event) {
    const nodeEl = event.target.closest('.node');
    if (!nodeEl) return;
    event.preventDefault();
    this.view.selectNodes([nodeEl.dataset.id]);
    this.dispatchEvent(new CustomEvent('node-activated', { detail: { id: nodeEl.dataset.id } }));
  }

  /** Inline rename on the card itself — the fastest path for quick capture. */
  editTitle(id, { selectAll = true } = {}) {
    const element = this.nodeEls.get(id);
    if (!element) return;
    const title = element.querySelector('.node-title');
    const original = this.store.doc.nodes[id]?.title ?? '';
    title.contentEditable = 'plaintext-only';
    title.classList.add('is-editing');
    title.focus();

    if (selectAll) {
      const range = document.createRange();
      range.selectNodeContents(title);
      const selection = globalThis.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }

    const finish = (commit) => {
      title.contentEditable = 'false';
      title.classList.remove('is-editing');
      title.removeEventListener('keydown', onKeyDown);
      title.removeEventListener('blur', onBlur);
      const text = title.textContent.trim();
      if (commit && text && text !== original) {
        runCommand('node.update', this.store, { id, patch: { title: text } });
      } else {
        title.textContent = original;
      }
      this.dispatchEvent(new CustomEvent('title-edit-ended', { detail: { id, commit } }));
    };

    const onKeyDown = (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    };
    const onBlur = () => finish(true);

    title.addEventListener('keydown', onKeyDown);
    title.addEventListener('blur', onBlur);
  }

  get isEditingTitle() {
    return Boolean(this.nodeLayer.querySelector('.node-title.is-editing'));
  }
}

export { NODE_WIDTH };
