/**
 * Pick an adapter for wherever this happens to be running.
 */

import { BrowserPlatform } from './browser.js';
import { TauriPlatform, isTauri } from './tauri.js';

export function createPlatform() {
  return isTauri() ? new TauriPlatform() : new BrowserPlatform();
}

export { Platform } from './platform.js';
