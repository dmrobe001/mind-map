#!/usr/bin/env node
/**
 * A static file server, in the spirit of the rest of the project: no
 * dependencies, no configuration.
 *
 * Used two ways — `npm run serve` for working on the UI in a browser, and as
 * Tauri's `beforeDevCommand` so `npm run tauri dev` has something to point a
 * window at.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const port = Number(process.argv[2] ?? 8000);
const root = resolve(process.argv[3] ?? new URL('..', import.meta.url).pathname);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    // normalize() collapses any ../ before it can escape the root.
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    let target = join(root, relative);

    if (!target.startsWith(root)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    if ((await stat(target)).isDirectory()) target = join(target, 'index.html');

    const body = await readFile(target);
    response.writeHead(200, {
      'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream',
      // Always re-read: the point of no build step is that a reload is enough.
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(port, () => {
  console.log(`mind-map dev server: http://localhost:${port}/  (serving ${root})`);
});
