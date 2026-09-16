/**
 * Portable file references.
 *
 * The problem: a path is a fact about one machine, but a map is a thing you
 * carry between machines. `/home/dan/notes.md` on the desktop is
 * `/Users/dan/notes.md` on the laptop and a content URI on the phone, and
 * plenty of files exist on exactly one of them.
 *
 * The answer here has two halves.
 *
 * **Named roots** are the good case. The document declares a root — say
 * `sync`, meaning "the cloud drive folder" — and each machine records
 * separately where that root actually lives. A reference of
 * `{ root: 'sync', path: 'projects/notes.md' }` then resolves everywhere,
 * because the machine-specific part was never written into the map. Root
 * *names* travel with the document; root *paths* never do.
 *
 * **Alternates** are the honest case. Some things really do live in one place
 * on one machine. A reference can carry several locators, each optionally
 * tagged with the machine it belongs to, and resolution takes the first one
 * that exists here. On any given machine some links open and some don't, and
 * the UI shows which is which instead of pretending.
 */

export const ABSOLUTE = 'absolute';

/** Normalise separators for comparison; Windows accepts either. */
function normalizePath(path) {
  return String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
}

export function joinPath(base, relative, separator = '/') {
  const cleanBase = String(base ?? '').replace(/[/\\]+$/, '');
  const cleanRelative = String(relative ?? '').replace(/^[/\\]+/, '');
  if (!cleanBase) return cleanRelative;
  if (!cleanRelative) return cleanBase;
  return `${cleanBase}${separator}${cleanRelative}`;
}

export function basename(path) {
  return String(path ?? '').split(/[/\\]/).filter(Boolean).pop() ?? '';
}

export function createLocator(props = {}) {
  return {
    root: props.root ?? ABSOLUTE,
    path: props.path ?? '',
    // Which machine this locator is known to work on. Advisory only — it is a
    // label for the human, never a reason to refuse to try the path.
    device: props.device ?? null,
    deviceName: props.deviceName ?? null,
  };
}

/**
 * Every locator on a block, primary first.
 *
 * The primary lives in `block.value` / `block.meta.root` so that a file block
 * stays a plain "type plus value" like every other content block, and older
 * builds still show something useful.
 */
export function locatorsFor(block) {
  const primary = createLocator({
    root: block.meta?.root ?? ABSOLUTE,
    path: block.value ?? '',
    device: block.meta?.device ?? null,
    deviceName: block.meta?.deviceName ?? null,
  });
  const alternates = (block.meta?.alternates ?? []).map(createLocator);
  return [primary, ...alternates];
}

/**
 * Turn a locator into a path on this machine.
 *
 * @returns {string|null} null when the root is one this machine hasn't mapped.
 */
export function resolveLocator(locator, { deviceRoots = {}, separator = '/' } = {}) {
  if (!locator?.path) return null;
  if (locator.root === ABSOLUTE) return locator.path;
  const base = deviceRoots[locator.root];
  if (!base) return null;
  return joinPath(base, locator.path, separator);
}

/**
 * Pick the locator to act on.
 *
 * `exists` answers "is this path on this machine right now?" and comes from
 * the file index; without it, the first resolvable locator wins.
 */
export function resolveBlock(block, context) {
  const candidates = locatorsFor(block)
    .map((locator) => ({ locator, path: resolveLocator(locator, context) }))
    .filter((entry) => entry.path);

  if (!candidates.length) return { path: null, locator: null, candidates: [] };

  const exists = context.exists ?? (() => null);
  const present = candidates.find((entry) => exists(entry.path) === true);
  return {
    path: (present ?? candidates[0]).path,
    locator: (present ?? candidates[0]).locator,
    resolved: Boolean(present),
    candidates,
  };
}

/**
 * Build the most portable locator for an absolute path.
 *
 * Prefers the deepest configured root that contains the path, so a file inside
 * the cloud drive is recorded relative to it and will open on every machine
 * that syncs it. Falls back to an absolute, device-tagged locator.
 */
export function bestLocatorForPath(absolutePath, { deviceRoots = {}, device = null } = {}) {
  const target = normalizePath(absolutePath);
  let best = null;

  for (const [rootId, base] of Object.entries(deviceRoots)) {
    if (!base) continue;
    const normalizedBase = normalizePath(base);
    if (!normalizedBase) continue;
    const inside = target === normalizedBase || target.startsWith(`${normalizedBase}/`);
    if (!inside) continue;
    if (!best || normalizedBase.length > best.baseLength) {
      best = {
        baseLength: normalizedBase.length,
        locator: createLocator({
          root: rootId,
          path: target.slice(normalizedBase.length).replace(/^\/+/, ''),
        }),
      };
    }
  }

  if (best) return best.locator;

  return createLocator({
    root: ABSOLUTE,
    path: absolutePath,
    device: device?.id ?? null,
    deviceName: device?.name ?? null,
  });
}

/** A short human phrase for a locator, for chips and tooltips. */
export function describeLocator(locator, doc) {
  if (locator.root === ABSOLUTE) {
    return locator.deviceName ? `${locator.path} (${locator.deviceName})` : locator.path;
  }
  const root = doc?.roots?.[locator.root];
  return `${root?.label ?? locator.root}: ${locator.path}`;
}

/** Every file locator in the document, with the block and node it came from. */
export function collectLocators(doc) {
  const out = [];
  for (const node of Object.values(doc.nodes)) {
    for (const block of node.content ?? []) {
      if (block.type !== 'file') continue;
      for (const locator of locatorsFor(block)) {
        if (locator.path) out.push({ node, block, locator });
      }
    }
  }
  return out;
}
