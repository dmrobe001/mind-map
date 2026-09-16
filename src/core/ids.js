/**
 * Identifier generation.
 *
 * Ids are opaque strings. Nothing in the app may parse meaning out of them —
 * the prefix exists purely to make raw JSON readable when you open a map in a
 * text editor.
 */

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < bytes; i += 1) buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function uid(prefix = 'x') {
  return `${prefix}_${randomHex(8)}`;
}

/** Slug used for tag and type keys, which are human-facing and must be stable. */
export function slug(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
