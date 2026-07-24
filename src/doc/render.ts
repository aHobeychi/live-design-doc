import type { Block } from '../types.js';

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function safeHref(href: string): string {
  const h = href.trim();
  if (/^(https?:|mailto:|#|\/|\.)/i.test(h)) return h;
  return '#';
}

/** Inline markdown on already-escaped text: code spans, bold, italic, links. */
export function renderInline(md: string): string {
  let s = escapeHtml(md);
  // Code spans first so formatting is not applied inside them.
  const codeSpans: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_, code: string) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) => {
    return `<a href="${safeHref(href)}" target="_blank" rel="noopener">${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])_([^_\s][^_]*)_/g, '$1<em>$2</em>');
  // @file references become preview chips. The boundary excludes word chars
  // so emails (user@host) stay plain text; code spans are already extracted.
  s = s.replace(
    /(^|[\s(])@([\w./-]*[\w/])/g,
    '$1<span class="fileref" data-path="$2">@$2</span>'
  );
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codeSpans[Number(i)]);
  return s;
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

// Injected into every mockup iframe so bare HTML fragments look intentional and
// stay readable in dark mode (the srcdoc document can't see the page's tokens;
// colors mirror --ink/--paper in index.html for both schemes).
const MOCKUP_BASE_CSS =
  '*{box-sizing:border-box}' +
  'body{margin:16px;font-family:system-ui,sans-serif;font-size:14px;color:#1a1a14;background:#fdfdfc}' +
  '@media (prefers-color-scheme:dark){body{color:#ece9e2;background:#17160f}}';

/**
 * Mockup fences: ```mockup renders as an ASCII wireframe, ```mockup:html renders
 * the body inside a fully sandboxed iframe (empty sandbox: no scripts, no origin),
 * so the agent can sketch real HTML/CSS. The source stays plain text inside the
 * fence, so mockups anchor, diff, and freeze into approved-*.md like any block.
 */
function renderMockup(info: string, body: string): string {
  if (/^mockup:html(\s|$)/.test(info)) {
    const h = /(?:^|\s)height=(\d{2,4})(?:\s|$)/.exec(info);
    const doc = `<style>${MOCKUP_BASE_CSS}</style>${body}`;
    // The iframe swallows pointer events and offers no selectable text, so the
    // selection→note flow can't reach this block — the button is the only way
    // to attach a (block-level, empty-quote) note to an HTML mockup.
    return (
      `<button class="mock-note" title="Add a note on this mockup">+ note</button>` +
      `<iframe class="mockup" sandbox="" title="UI mockup" loading="lazy" ` +
      `height="${h ? h[1] : 320}" srcdoc="${escapeHtml(doc)}"></iframe>`
    );
  }
  return `<pre class="mockup"><code>${escapeHtml(body)}</code></pre>`;
}

function renderTable(text: string): string {
  const rows = text
    .split('\n')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
  let html = '<table>';
  let headerDone = false;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].every((c) => /^:?-{2,}:?$/.test(c) || c === '')) {
      headerDone = true;
      continue;
    }
    const tag = headerDone || i > 0 ? 'td' : 'th';
    html += '<tr>' + rows[i].map((c) => `<${tag}>${renderInline(c)}</${tag}>`).join('') + '</tr>';
  }
  return html + '</table>';
}

function renderListItem(b: Block): string {
  const lines = b.text.split('\n');
  const first = LIST_RE.exec(lines[0]);
  let content = first ? first[3] : lines[0];
  let checkboxHtml = '';
  if (b.checkbox) {
    content = content.replace(/^\[[ xX]\]\s*/, '');
    checkboxHtml = `<span class="tick" data-state="${b.checkbox}"></span>`;
  }
  const markerText = b.marker && /\d/.test(b.marker) ? b.marker : '';
  const nested = lines
    .slice(1)
    .map((l) => `<div class="li-sub">${renderInline(l.trim().replace(LIST_RE, '$2 $3'))}</div>`)
    .join('');
  return (
    `<span class="li-marker">${markerText || '–'}</span>` +
    `<span class="li-body">${checkboxHtml}${renderInline(content)}${nested}</span>`
  );
}

export function renderBlockInner(b: Block): string {
  switch (b.type) {
    case 'heading':
      return renderInline(b.text.replace(/^#{1,6}\s+/, ''));
    case 'code': {
      const lines = b.text.split('\n');
      const body = lines
        .slice(1, lines.at(-1)?.trimStart().match(/^(```|~~~)/) ? -1 : undefined)
        .join('\n');
      const info = lines[0].trim().replace(/^(`{3,}|~{3,})\s*/, '');
      if (/^mockup(:|\s|$)/.test(info)) return renderMockup(info, body);
      return `<pre><code>${escapeHtml(body)}</code></pre>`;
    }
    case 'table':
      return renderTable(b.text);
    case 'blockquote':
      return renderInline(
        b.text
          .split('\n')
          .map((l) => l.replace(/^\s*>\s?/, ''))
          .join(' ')
      );
    case 'listItem':
      return renderListItem(b);
    case 'paragraph':
      return renderInline(b.text.split('\n').join(' '));
  }
}

/** One addressable element per block, tagged with its id for anchoring. */
export function renderBlock(b: Block): string {
  const inner = renderBlockInner(b);
  const attrs = `class="block ${b.type}" data-id="${escapeHtml(b.id)}"`;
  switch (b.type) {
    case 'heading': {
      const level = Math.min(b.level ?? 1, 6);
      return `<h${level} ${attrs}>${inner}</h${level}>`;
    }
    case 'blockquote':
      return `<blockquote ${attrs}>${inner}</blockquote>`;
    case 'listItem':
      return `<div ${attrs} data-group="${b.listGroup ?? 0}">${inner}</div>`;
    default:
      return `<div ${attrs}>${inner}</div>`;
  }
}
