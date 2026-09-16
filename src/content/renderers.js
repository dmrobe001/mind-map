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
  editor: 'line',
  placeholder: '/home/you/projects/notes.txt',
  hint: 'A path to a file on this machine. Browsers will not open it from a web '
    + 'page, but recording it here means "every note that mentions this file" is '
    + 'a text search away.',
  render: (block) => {
    const wrap = el('div', 'block-body file');
    const path = el('code', 'file-path');
    path.textContent = block.value || '(no path)';
    const copy = el('button', 'mini');
    copy.type = 'button';
    copy.textContent = 'copy path';
    copy.addEventListener('click', () => {
      navigator.clipboard?.writeText(block.value ?? '');
      copy.textContent = 'copied';
      setTimeout(() => { copy.textContent = 'copy path'; }, 1200);
    });
    wrap.append(path, copy);
    return wrap;
  },
  preview: (block) => block.value?.split('/').pop() ?? '',
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
