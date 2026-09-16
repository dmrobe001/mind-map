/**
 * The browser adapter.
 *
 * Keeps the app fully usable in a plain tab, which is both the fallback for
 * browsers without a native build and the fast development loop: edit a file,
 * reload, no compile.
 *
 * File *paths* are inert here. A reference recorded on a machine where the
 * native app runs still shows up, still filters, still searches — it just
 * can't be opened. That is the honest degradation, and the UI says so rather
 * than showing a dead button.
 */

import { Platform } from './platform.js';
import {
  FileBinding, supportsFileSystemAccess, downloadDocument, pickFileForUpload,
  loadDeviceSettings, saveDeviceSettings,
} from '../core/persistence.js';

export class BrowserPlatform extends Platform {
  constructor() {
    super();
    this.id = 'browser';
    this.label = 'The browser';
    this.file = new FileBinding();
    this.can = {
      ...this.can,
      // The File System Access API can write back to a file the user picked,
      // but it never yields a path — only an opaque handle.
      saveInPlace: supportsFileSystemAccess,
    };
  }

  async init() {
    this.settings = loadDeviceSettings();
    await this.file.restore().catch(() => false);
    this.device = {
      id: this.settings.deviceId ?? null,
      name: 'this browser',
      os: 'browser',
      home: '',
      separator: '/',
    };
  }

  get connectedName() {
    return this.file.name;
  }

  async openMap() {
    if (supportsFileSystemAccess) {
      const result = await this.file.open();
      return { ...result, path: null, filename: this.file.name };
    }
    const result = await pickFileForUpload();
    return result ? { ...result, path: null } : null;
  }

  async saveMap(doc) {
    if (!supportsFileSystemAccess) {
      downloadDocument(doc);
      return 'downloaded copy';
    }
    if (!this.file.connected) return this.saveMapAs(doc);
    return this.file.save(doc);
  }

  async saveMapAs(doc, suggested) {
    if (!supportsFileSystemAccess) {
      downloadDocument(doc, suggested);
      return 'downloaded copy';
    }
    return this.file.saveAs(doc, suggested);
  }

  forgetFile() {
    this.file.forget();
  }

  async readSettings() {
    this.settings = loadDeviceSettings();
    return this.settings;
  }

  async writeSettings(settings) {
    this.settings = settings;
    saveDeviceSettings(settings);
  }
}
