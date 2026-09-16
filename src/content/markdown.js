/**
 * A small, dependency-free Markdown renderer.
 *
 * Deliberately not CommonMark. It covers the subset that is useful in a note
 * on a mind map node and nothing else, because a 40kB parser is a poor trade
 * for a tool that has to keep working offline from a folder of static files.
 *
 * Everything is HTML-escaped before any markup is generated, and link targets
 * are checked against an allowlist of schemes, so node content can never
 * inject script into the page.
 */

const ALLOWED_SCHEMES = /^(https?:|mailto:|file:|#|\/|\.\/|\.\.\/)/i;

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHref(raw) {
  const href = String(raw).trim();
  return ALLOWED_SCHEMES.test(href) ? href : '#';
}

/**
 * Inline formatting. Input must already be HTML-escaped, which is also what
 * makes the code-span placeholder safe: `<` cannot survive escaping, so a
 * sentinel containing one can never collide with user text.
 */
function renderInline(text) {
  const codes = [];
  let out = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `<<CODE${codes.length - 1}>>`;
  });

  // [[Wiki link]] — resolved against node titles by the app.
  out = out.replace(/\[\[([^\]]+)\]\]/g, (_, title) => {
    const clean = title.trim();
    return `<a href="#" class="wikilink" data-node-title="${clean}">${clean}</a>`;
  });

  // [text](href) with an optional "title"
  out = out.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (_, label, href, title) => {
      const t = title ? ` title="${title}"` : '';
      return `<a href="${safeHref(href)}" target="_blank" rel="noopener noreferrer"${t}>${label || href}</a>`;
    });

  // Bare URLs, skipping any already turned into an anchor above.
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    (_, lead, url) => `${lead}<a href="${safeHref(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`);

  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  return out.replace(/&lt;&lt;CODE(\d+)&gt;&gt;|<<CODE(\d+)>>/g,
    (_, a, b) => `<code>${codes[Number(a ?? b)]}</code>`);
}

export function renderMarkdown(source) {
  const lines = escapeHtml(source ?? '').split(/\r?\n/);
  const html = [];
  let listType = null;
  let inCode = false;
  let codeBuffer = [];
  let paragraph = [];

  const closeList = () => {
    if (listType) { html.push(`</${listType}>`); listType = null; }
  };
  const closeParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${renderInline(paragraph.join('<br>'))}</p>`);
      paragraph = [];
    }
  };
  const flush = () => { closeParagraph(); closeList(); };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) {
        html.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`);
        codeBuffer = [];
        inCode = false;
      } else {
        flush();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuffer.push(line); continue; }

    if (!line.trim()) { flush(); continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flush(); html.push('<hr>'); continue; }

    // '>' has already been escaped to '&gt;' by this point.
    const quote = line.match(/^\s*&gt;\s?(.*)$/);
    if (quote) {
      flush();
      html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    // Task list items render as real checkboxes, read-only in the preview.
    const task = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (task) {
      closeParagraph();
      if (listType !== 'ul') { closeList(); html.push('<ul class="tasks">'); listType = 'ul'; }
      const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
      html.push(`<li><input type="checkbox" disabled${checked}> ${renderInline(task[2])}</li>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      closeParagraph();
      if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul'; }
      html.push(`<li>${renderInline(bullet[1])}</li>`);
      continue;
    }

    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      closeParagraph();
      if (listType !== 'ol') { closeList(); html.push('<ol>'); listType = 'ol'; }
      html.push(`<li>${renderInline(numbered[1])}</li>`);
      continue;
    }

    closeList();
    paragraph.push(line);
  }

  if (inCode && codeBuffer.length) html.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`);
  flush();
  return html.join('\n');
}

/** First non-empty line, stripped of markup — used for card previews. */
export function firstLine(source, limit = 120) {
  const line = String(source ?? '')
    .split(/\r?\n/)
    .find((l) => l.trim() && !/^\s*```/.test(l)) ?? '';
  const plain = line.replace(/[#>*_`~[\]]/g, '').trim();
  return plain.length > limit ? `${plain.slice(0, limit - 1)}…` : plain;
}
