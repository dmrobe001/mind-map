/**
 * Persistence.
 *
 * Two layers, deliberately:
 *
 *   1. A localStorage autosave, so closing the tab never loses work.
 *   2. A real file on disk, which is the actual artefact. The File System
 *      Access API lets the browser write back to the same file you opened;
 *      where it isn't available (Firefox, Safari) this degrades to
 *      download-and-upload, which is clumsier but loses nothing.
 *
 * The file is the source of truth. The autosave is a crash net.
 */

import { serializeDocument, normalizeDocument } from './model.js';

const AUTOSAVE_KEY = 'mindmap:autosave:v1';
const VIEWSTATE_KEY = 'mindmap:viewstate:v1';
const SETTINGS_KEY = 'mindmap:device:v1';
const IDB_NAME = 'mindmap';
const IDB_STORE = 'handles';

export const supportsFileSystemAccess = typeof globalThis.showOpenFilePicker === 'function';

/* ------------------------------------------------------------------ *
 * localStorage
 * ------------------------------------------------------------------ */

function safeLocalStorage() {
  try {
    const probe = '__mm__';
    globalThis.localStorage.setItem(probe, probe);
    globalThis.localStorage.removeItem(probe);
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function saveAutosave(doc) {
  const storage = safeLocalStorage();
  if (!storage) return false;
  try {
    storage.setItem(AUTOSAVE_KEY, serializeDocument(doc));
    return true;
  } catch (err) {
    // Quota exhausted on a large map. The file on disk is still authoritative.
    console.warn('Autosave failed', err);
    return false;
  }
}

export function loadAutosave() {
  const storage = safeLocalStorage();
  if (!storage) return null;
  const raw = storage.getItem(AUTOSAVE_KEY);
  if (!raw) return null;
  try {
    return normalizeDocument(JSON.parse(raw)).doc;
  } catch (err) {
    console.warn('Discarding unreadable autosave', err);
    return null;
  }
}

export function clearAutosave() {
  safeLocalStorage()?.removeItem(AUTOSAVE_KEY);
}

export function saveViewState(state) {
  try {
    safeLocalStorage()?.setItem(VIEWSTATE_KEY, JSON.stringify(state));
  } catch { /* view state is disposable */ }
}

export function loadViewState() {
  try {
    const raw = safeLocalStorage()?.getItem(VIEWSTATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Per-machine settings, in the browser's copy of them.
 *
 * The native build keeps the same shape in a config file instead. Either way
 * this never enters the document: where this machine keeps the cloud drive is
 * not a fact about your notes, and syncing it would break every other machine.
 */
export function loadDeviceSettings() {
  try {
    const raw = safeLocalStorage()?.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveDeviceSettings(settings) {
  try {
    safeLocalStorage()?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* settings are a convenience */ }
}

/* ------------------------------------------------------------------ *
 * File handle persistence
 *
 * A FileSystemFileHandle survives a reload if it is stored in IndexedDB, so
 * reopening the tab can offer to reconnect to the same file.
 * ------------------------------------------------------------------ */

function openDb() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('no indexedDB')); return; }
    const request = globalThis.indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(IDB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbSet(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* handle persistence is a convenience, not a requirement */ }
}

async function idbGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const request = tx.objectStore(IDB_STORE).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * File access
 * ------------------------------------------------------------------ */

const PICKER_TYPES = [{
  description: 'Mind map',
  accept: { 'application/json': ['.json', '.mindmap.json'] },
}];

export class FileBinding {
  constructor() {
    this.handle = null;
    this.name = null;
  }

  get connected() {
    return Boolean(this.handle);
  }

  async restore() {
    if (!supportsFileSystemAccess) return false;
    const handle = await idbGet('current');
    if (!handle) return false;
    // Permission is not persisted, only the handle; ask again on demand.
    const permission = await handle.queryPermission?.({ mode: 'readwrite' });
    this.handle = handle;
    this.name = handle.name;
    return permission === 'granted';
  }

  async ensurePermission() {
    if (!this.handle) return false;
    if (await this.handle.queryPermission?.({ mode: 'readwrite' }) === 'granted') return true;
    return (await this.handle.requestPermission?.({ mode: 'readwrite' })) === 'granted';
  }

  async open() {
    const [handle] = await globalThis.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
    this.handle = handle;
    this.name = handle.name;
    await idbSet('current', handle);
    const file = await handle.getFile();
    return normalizeDocument(JSON.parse(await file.text()));
  }

  async saveAs(doc, suggestedName) {
    const handle = await globalThis.showSaveFilePicker({
      types: PICKER_TYPES,
      suggestedName: suggestedName || 'map.mindmap.json',
    });
    this.handle = handle;
    this.name = handle.name;
    await idbSet('current', handle);
    return this.save(doc);
  }

  async save(doc) {
    if (!this.handle) throw new Error('No file connected');
    if (!(await this.ensurePermission())) throw new Error('Permission to write was declined');
    const writable = await this.handle.createWritable();
    await writable.write(serializeDocument(doc));
    await writable.close();
    return this.name;
  }

  async reload() {
    if (!this.handle) throw new Error('No file connected');
    const file = await this.handle.getFile();
    return normalizeDocument(JSON.parse(await file.text()));
  }

  forget() {
    this.handle = null;
    this.name = null;
    idbSet('current', undefined);
  }
}

/* ---- Fallback path: download / upload ---- */

export function downloadDocument(doc, filename) {
  const blob = new Blob([serializeDocument(doc)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || `${(doc.title || 'map').replace(/[^\w.-]+/g, '-')}.mindmap.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFileForUpload() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      try {
        resolve({ ...normalizeDocument(JSON.parse(await file.text())), filename: file.name });
      } catch (err) {
        resolve({ doc: null, problems: [`Could not read ${file.name}: ${err.message}`] });
      }
    });
    input.click();
  });
}
