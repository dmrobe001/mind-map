/**
 * The native adapter.
 *
 * Talks to the Rust commands in `src-tauri/src/lib.rs` through the global
 * `invoke` that `withGlobalTauri` provides. Going through the global rather
 * than the `@tauri-apps/api` npm package is what lets the very same files run
 * unmodified in a browser tab — there is no bundler in this project and no
 * import that only resolves in one of the two environments.
 */

import { Platform } from './platform.js';
import { normalizeDocument, serializeDocument } from '../core/model.js';

const invoke = (command, args) => globalThis.__TAURI__.core.invoke(command, args);

export function isTauri() {
  return typeof globalThis.__TAURI__?.core?.invoke === 'function';
}

export class TauriPlatform extends Platform {
  constructor() {
    super();
    this.id = 'tauri';
    this.label = 'The desktop app';
    this.can = {
      realPaths: true,
      openExternally: true,
      revealInFolder: true,
      browseDirectories: true,
      saveInPlace: true,
      deviceIdentity: true,
    };
    this.currentPath = null;
  }

  async init() {
    this.device = await invoke('device_info');
    this.settings = await invoke('read_device_settings');
  }

  get connectedName() {
    if (!this.currentPath) return null;
    return this.currentPath.split(/[/\\]/).pop();
  }

  /* ---- the map file ---- */

  async openMap() {
    const path = await invoke('pick_map_file');
    if (!path) return null;
    const raw = await invoke('read_text_file', { path });
    const result = normalizeDocument(JSON.parse(raw));
    this.currentPath = path;
    return { ...result, path, filename: path.split(/[/\\]/).pop() };
  }

  /** Open a specific path with no dialog — used to reopen the last map. */
  async openMapAt(path) {
    const raw = await invoke('read_text_file', { path });
    const result = normalizeDocument(JSON.parse(raw));
    this.currentPath = path;
    return { ...result, path, filename: path.split(/[/\\]/).pop() };
  }

  async saveMap(doc) {
    if (!this.currentPath) return this.saveMapAs(doc);
    await invoke('write_text_file', {
      path: this.currentPath,
      contents: serializeDocument(doc),
    });
    return this.currentPath;
  }

  async saveMapAs(doc, suggested) {
    const path = await invoke('pick_map_save_path', { suggested });
    if (!path) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    this.currentPath = path;
    await invoke('write_text_file', { path, contents: serializeDocument(doc) });
    return path;
  }

  forgetFile() {
    this.currentPath = null;
  }

  /* ---- referenced files ---- */

  pickFiles() {
    return invoke('pick_files');
  }

  pickDirectory() {
    return invoke('pick_directory');
  }

  listDir(path, options = {}) {
    return invoke('list_dir', { path, options });
  }

  async pathsExist(paths) {
    if (!paths.length) return [];
    return invoke('paths_exist', { paths });
  }

  readTextFile(path) {
    return invoke('read_text_file', { path });
  }

  openPath(path) {
    return invoke('open_path', { path });
  }

  revealPath(path) {
    return invoke('reveal_path', { path });
  }

  openUrl(url) {
    // A webview has no tabs to open into, so the system browser handles it.
    return invoke('open_url', { url });
  }

  /* ---- per-machine settings ---- */

  async readSettings() {
    this.settings = await invoke('read_device_settings');
    return this.settings;
  }

  async writeSettings(settings) {
    this.settings = settings;
    await invoke('write_device_settings', { settings });
  }
}
