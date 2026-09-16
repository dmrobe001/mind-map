/**
 * Graph indexing and traversal.
 *
 * Built fresh from a document and treated as disposable — the document stays
 * the single source of truth and this is only ever a derived cache. Maps are
 * small enough (tens of thousands of nodes) that rebuilding on change is
 * cheaper than keeping an index correct incrementally.
 */

export class GraphIndex {
  constructor(doc) {
    this.doc = doc;
    /** id -> [{ edge, other, direction }] where direction is 'out' | 'in'. */
    this.adjacency = new Map();
    for (const id of Object.keys(doc.nodes)) this.adjacency.set(id, []);

    for (const edge of Object.values(doc.edges)) {
      const type = doc.edgeTypes[edge.type];
      const directed = type ? type.directed !== false : true;
      const fromList = this.adjacency.get(edge.from);
      const toList = this.adjacency.get(edge.to);
      if (!fromList || !toList) continue;
      // An undirected edge is recorded as 'out' from both ends so that
      // direction-sensitive traversals treat it as freely walkable.
      fromList.push({ edge, other: edge.to, direction: 'out' });
      toList.push({ edge, other: edge.from, direction: directed ? 'in' : 'out' });
    }
  }

  neighbors(id, { direction = 'any', edgeTypes = null } = {}) {
    const links = this.adjacency.get(id) ?? [];
    return links.filter((link) => {
      if (direction !== 'any' && link.direction !== direction) return false;
      if (edgeTypes && edgeTypes.length && !edgeTypes.includes(link.edge.type)) return false;
      return true;
    });
  }

  /**
   * Breadth-first set of node ids reachable from `startIds`.
   *
   * @param {string[]} startIds
   * @param {object}   opts
   * @param {number}   opts.depth        max hops; Infinity walks the component
   * @param {string}   opts.direction    'any' | 'out' | 'in'
   * @param {string[]} opts.edgeTypes    restrict to these edge types
   * @param {boolean}  opts.includeSelf  keep the start nodes in the result
   * @returns {Map<string, number>} id -> hop distance from the nearest start
   */
  reach(startIds, { depth = Infinity, direction = 'any', edgeTypes = null, includeSelf = true } = {}) {
    const distance = new Map();
    let frontier = [];
    for (const id of startIds) {
      if (!this.adjacency.has(id)) continue;
      distance.set(id, 0);
      frontier.push(id);
    }
    let hop = 0;
    while (frontier.length && hop < depth) {
      hop += 1;
      const next = [];
      for (const id of frontier) {
        for (const link of this.neighbors(id, { direction, edgeTypes })) {
          if (distance.has(link.other)) continue;
          distance.set(link.other, hop);
          next.push(link.other);
        }
      }
      frontier = next;
    }
    if (!includeSelf) for (const id of startIds) distance.delete(id);
    return distance;
  }

  /** Edge types flagged hierarchical, used by the children/ancestors filters. */
  hierarchicalTypes() {
    return Object.values(this.doc.edgeTypes)
      .filter((t) => t.hierarchical)
      .map((t) => t.id);
  }

  /** Nodes below `id` via hierarchical edges. */
  descendants(id, { depth = Infinity, includeSelf = false, edgeTypes = null } = {}) {
    return this.reach([id], {
      depth,
      direction: 'out',
      edgeTypes: edgeTypes ?? this.hierarchicalTypes(),
      includeSelf,
    });
  }

  /** Nodes above `id` via hierarchical edges. */
  ancestors(id, { depth = Infinity, includeSelf = false, edgeTypes = null } = {}) {
    return this.reach([id], {
      depth,
      direction: 'in',
      edgeTypes: edgeTypes ?? this.hierarchicalTypes(),
      includeSelf,
    });
  }

  degree(id) {
    return (this.adjacency.get(id) ?? []).length;
  }

  /** Every node in the same connected component, ignoring direction. */
  component(id) {
    return this.reach([id], { direction: 'any', includeSelf: true });
  }

  /** Nodes with no edges at all — easy to lose track of, so worth surfacing. */
  orphans() {
    return [...this.adjacency.entries()]
      .filter(([, links]) => links.length === 0)
      .map(([id]) => id);
  }
}
