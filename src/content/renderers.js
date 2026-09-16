/**
 * Content block renderers.
 *
 * A node holds an ordered list of typed blocks. The type is a registry key, so
 * teaching the app a new kind of attachment means registering one entry here —
 * no changes to the node card, the inspector, or the document schema.
 *
 * A block whose type is not registered still round-trips through save/load and
 * is shown as raw text rather than being dropped.
 */

import { contentRenderers } from '../core/registry.js';
import { renderMarkdown, escapeHtml, firstLine } from './markdown.js';
import { locatorsFor, resolveLocator, describeLocator, basename } from '../core/locators.js';

const el = (tag, className, html) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
};

contentRenderers.register('markdown', {
  label: 'Markdown',
  order: 1,
  editor: 'textarea',
  placeholder: 'Markdown. [[Double brackets]] link to another node by title.',
  render: (block) => el('div', 'block-body markdown', renderMarkdown(block.value)),
  preview: (block) => firstLine(block.value),
});

contentRenderers.register('text', {
  label: 'Plain text',
  order: 2,
  editor: 'textarea',
  placeholder: 'Plain text, rendered exactly as typed.',
  render: (block) => el('pre', 'block-body plain', escapeHtml(block.value)),
  preview: (block) => firstLine(block.value),
});

contentRenderers.register('link', {
  label: 'Link',
  order: 3,
  editor: 'line',
  placeholder: 'https://…',
  render: (block) => {
    const wrap = el('div', 'block-body link');
    const anchor = el('a');
    const href = String(block.value || '').trim();
    anchor.href = /^(https?:|mailto:)/i.test(href) ? href : '#';
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = block.label || href || '(empty link)';
    wrap.append(anchor);
    return wrap;
  },
  preview: (block) => block.label || block.value,
});

contentRenderers.register('file', {
  label: 'File reference',
  order: 4,
  editor: 'locators',
  placeholder: '/home/you/projects/notes.md',
  hint: 'One file, in as many places as it lives. A location relative to a named '
    + 'root resolves on every machine that has mapped that root; an absolute one '
    + 'only works where it was recorded.',
  render: (block, ctx = {}) => {
    const wrap = el('div', 'block-body file');
    const locators = locatorsFor(block).filter((locator) => locator.path);

    if (!locators.length) {
      wrap.append(el('div', 'block-note', 'No location recorded yet.'));
      return wrap;
    }

    const platform = ctx.platform;
    for (const [index, locator] of locators.entries()) {
      const path = resolveLocator(locator, ctx);
      // null = unmapped root, false = mapped but not here, true = present.
      const present = path ? (ctx.exists?.(path) ?? null) : null;

      const row = el('div', `locator ${index === 0 ? 'is-primary' : ''}`);
      const dot = el('span', 'locator-dot');
      dot.dataset.state = present === true ? 'here' : present === false ? 'elsewhere' : 'unknown';
      dot.title = present === true
        ? 'On this machine'
        : present === false
          ? 'Not on this machine'
          : path
            ? 'Not checked — this build cannot see the filesystem'
            : `No path configured for the "${locator.root}" root on this machine`;

      const text = el('code', 'file-path');
      text.textContent = describeLocator(locator, ctx.doc);
      text.title = path ?? '(unresolved)';

      // Buttons live in their own group so the path gets a full line to wrap
      // in rather than being squeezed into whatever the buttons leave over.
      const actions = el('div', 'locator-actions');
      row.append(dot, text, actions);

      if (present === true && platform?.can.openExternally) {
        const open = el('button', 'mini');
        open.type = 'button';
        open.textContent = 'open';
        open.addEventListener('click', () => {
          platform.openPath(path).catch((err) => { text.textContent = err.message; });
        });
        actions.append(open);

        if (platform.can.revealInFolder) {
          const reveal = el('button', 'mini');
          reveal.type = 'button';
          reveal.textContent = 'show';
          reveal.title = 'Show in the file manager';
          reveal.addEventListener('click', () => { platform.revealPath(path).catch(() => {}); });
          actions.append(reveal);
        }
      }

      const copy = el('button', 'mini');
      copy.type = 'button';
      copy.textContent = 'copy';
      copy.title = 'Copy the resolved path';
      copy.addEventListener('click', () => {
        navigator.clipboard?.writeText(path ?? locator.path);
        copy.textContent = 'copied';
        setTimeout(() => { copy.textContent = 'copy'; }, 1200);
      });
      actions.append(copy);

      wrap.append(row);
    }

    if (!platform?.can.realPaths) {
      wrap.append(el('div', 'block-note',
        'Paths are recorded but cannot be opened here — a browser tab has no filesystem. '
        + 'The desktop build opens them.'));
    }
    return wrap;
  },
  preview: (block) => basename(block.value) || block.label,
});

contentRenderers.register('code', {
  label: 'Code',
  order: 5,
  editor: 'textarea',
  placeholder: 'Code, shown verbatim in a monospace block.',
  render: (block) => {
    const pre = el('pre', 'block-body code');
    const code = el('code');
    code.textContent = block.value;
    pre.append(code);
    return pre;
  },
  preview: (block) => firstLine(block.value),
});

contentRenderers.register('latex', {
  label: 'LaTeX',
  order: 6,
  editor: 'textarea',
  placeholder: String.raw`\frac{a}{b} = c`,
  hint: 'Typeset with KaTeX when vendor/katex is present; shown as source otherwise. '
    + 'See docs/EXTENDING.md.',
  render: (block) => {
    const wrap = el('div', 'block-body latex');
    // KaTeX is optional and loaded locally if at all — this tool must keep
    // working with no network and no package manager.
    if (globalThis.katex?.renderToString) {
      try {
        wrap.innerHTML = globalThis.katex.renderToString(block.value ?? '', {
          displayMode: true,
          throwOnError: false,
        });
        return wrap;
      } catch (err) {
        wrap.classList.add('render-error');
        wrap.textContent = `LaTeX error: ${err.message}`;
        return wrap;
      }
    }
    const pre = el('pre', 'latex-source');
    pre.textContent = block.value;
    wrap.append(pre, el('div', 'block-note', 'KaTeX not installed — showing source.'));
    return wrap;
  },
  preview: (block) => firstLine(block.value),
});

/** Renderer used when a block's type is unknown to this build. */
export const FALLBACK_RENDERER = {
  id: 'unknown',
  label: 'Unknown',
  editor: 'textarea',
  render: (block) => {
    const wrap = el('div', 'block-body unknown');
    wrap.append(el('div', 'block-note', `Unrecognised block type "${escapeHtml(block.type)}" — shown as text.`));
    const pre = el('pre');
    pre.textContent = block.value;
    wrap.append(pre);
    return wrap;
  },
  preview: (block) => firstLine(block.value),
};

export function rendererFor(type) {
  return contentRenderers.get(type) ?? FALLBACK_RENDERER;
}

export { contentRenderers };
