/**
 * Which referenced files are actually on this machine.
 *
 * Resolution has to be synchronous at render time — a card either shows an
 * openable link or a greyed-out one — but asking the filesystem is async and
 * a map can hold hundreds of references. So every path in the document is
 * checked in one batched call and the answers are cached here for the
 * renderers to read.
 *
 * The cache is advisory. A stale "missing" only means a button is disabled
 * until the next refresh, and acting on a stale "present" just surfaces the
 * real error from the OS.
 */

import { collectLocators, resolveLocator } from './locators.js';

const REFRESH_INTERVAL_MS = 15000;

export class FileIndex extends EventTarget {
  constructor(platform) {
    super();
    this.platform = platform;
    /** absolute path -> boolean */
    this.status = new Map();
    this.checking = false;
    this.lastRun = 0;
  }

  /** @returns {boolean|null} null means "not checked yet". */
  exists(path) {
    if (!this.platform.can.realPaths) return null;
    return this.status.has(path) ? this.status.get(path) : null;
  }

  /** Bound method, for handing straight to the locator resolver. */
  get lookup() {
    return (path) => this.exists(path);
  }

  /**
   * Re-check every path the document mentions.
   *
   * @param {object} doc
   * @param {object} context  { deviceRoots, separator }
   * @param {boolean} force   ignore the rate limit
   */
  async refresh(doc, context, { force = false } = {}) {
    if (!this.platform.can.realPaths) return;
    if (this.checking) return;
    if (!force && Date.now() - this.lastRun < REFRESH_INTERVAL_MS) return;

    const paths = [...new Set(
      collectLocators(doc)
        .map(({ locator }) => resolveLocator(locator, context))
        .filter(Boolean),
    )];

    this.checking = true;
    try {
      const results = await this.platform.pathsExist(paths);
      const next = new Map();
      paths.forEach((path, index) => next.set(path, Boolean(results[index])));

      const changed = next.size !== this.status.size
        || [...next].some(([path, value]) => this.status.get(path) !== value);

      this.status = next;
      this.lastRun = Date.now();
      if (changed) this.dispatchEvent(new CustomEvent('change'));
    } catch (err) {
      console.warn('File check failed', err);
      this.lastRun = Date.now();
    } finally {
      this.checking = false;
    }
  }

  /** Counts for the status bar: how much of the map is reachable from here. */
  summary() {
    let present = 0;
    let missing = 0;
    for (const value of this.status.values()) {
      if (value) present += 1;
      else missing += 1;
    }
    return { present, missing, total: present + missing };
  }
}
