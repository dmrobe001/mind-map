#!/usr/bin/env node
/**
 * Copy just the web app into `src-tauri/frontend/` for bundling.
 *
 * Tauri embeds `frontendDist` wholesale, so it cannot be pointed at the repo
 * root — that would bake `.git`, the docs and the Rust source into every
 * binary. This copies the four things the UI actually needs.
 *
 * The staged directory is generated and gitignored; nothing should ever be
 * edited inside it.
 */

import { cp, rm, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(repo, 'src-tauri', 'frontend');

const INCLUDE = ['index.html', 'src', 'examples'];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const entry of INCLUDE) {
  await cp(join(repo, entry), join(out, entry), { recursive: true });
}

console.log(`staged ${INCLUDE.join(', ')} -> ${out}`);
