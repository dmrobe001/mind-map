/**
 * What an environment can do.
 *
 * The app runs in two places — a browser tab and a native window — and they
 * differ in exactly one respect that matters: whether a file path means
 * anything. Everything downstream asks `platform.can.*` rather than sniffing
 * for `window.__TAURI__`, so adding a third environment later (a mobile build,
 * a local helper process) means writing one adapter, not auditing the UI.
 *
 * Methods a platform cannot support are present and reject, rather than being
 * absent. Callers check the capability flag first; the rejection is the
 * backstop for the case where they forgot.
 */

export const CAPABILITIES = [
  /** Absolute paths resolve to real files that can be read. */
  'realPaths',
  /** A file can be handed to whatever program owns it. */
  'openExternally',
  /** A file can be shown in the system file manager. */
  'revealInFolder',
  /** Directories can be listed. */
  'browseDirectories',
  /** The open map file can be written back to in place. */
  'saveInPlace',
  /** This machine has a stable identity, so per-machine paths can be labelled. */
  'deviceIdentity',
];

export class Platform {
  constructor() {
    this.id = 'unknown';
    this.label = 'Unknown';
    this.can = Object.fromEntries(CAPABILITIES.map((key) => [key, false]));
    this.device = null;
    this.settings = {};
  }

  async init() {}

  unsupported(what) {
    return Promise.reject(new Error(`${this.label} cannot ${what}.`));
  }

  /* ---- the map file ---- */

  /** @returns {Promise<{doc, path, filename, problems}|null>} null if cancelled. */
  openMap() { return this.unsupported('open files'); }

  /** @returns {Promise<string>} the name or path written to. */
  saveMap() { return this.unsupported('save files'); }

  saveMapAs() { return this.unsupported('save files'); }

  /* ---- referenced files ---- */

  /** @returns {Promise<string[]>} absolute paths, empty if cancelled. */
  pickFiles() { return this.unsupported('browse for files'); }

  pickDirectory() { return this.unsupported('browse for folders'); }

  listDir() { return this.unsupported('list directories'); }

  /**
   * Batch existence check.
   * @returns {Promise<boolean[]>} one entry per input path, in order.
   */
  async pathsExist(paths) { return paths.map(() => false); }

  readTextFile() { return this.unsupported('read arbitrary files'); }

  openPath() { return this.unsupported('open files in other programs'); }

  revealPath() { return this.unsupported('show files in a file manager'); }

  /** Open a web link the way the environment prefers. */
  async openUrl(url) {
    globalThis.open(url, '_blank', 'noopener,noreferrer');
  }

  /* ---- per-machine settings ----
   *
   * These must never go in the document: where *this* machine keeps the cloud
   * drive is not a fact about your notes, and syncing it would break every
   * other machine.
   */

  async readSettings() { return this.settings; }

  async writeSettings(settings) { this.settings = settings; }
}
