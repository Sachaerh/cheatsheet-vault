// Server-side Markdown rendering (highlighted code, heading ids for the TOC,
// sanitized output) and full-text search with highlighted snippets.
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import sanitizeHtml from 'sanitize-html';

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(text) {
  return (
    text
      .toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/&[a-z0-9#]+;/gi, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-') || 'section'
  );
}

const SANITIZE = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    'img', 'h1', 'h2', 'del', 'ins', 'details', 'summary', 'input', 'kbd', 'sup', 'sub', 'mark',
  ]),
  allowedAttributes: {
    '*': ['id', 'class', 'title', 'align'],
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    input: ['type', 'checked', 'disabled'],
    ol: ['start'],
    td: ['align', 'colspan', 'rowspan'],
    th: ['align', 'colspan', 'rowspan'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  transformTags: {
    a: (tag, attribs) => {
      if (/^https?:/i.test(attribs.href || '')) {
        return { tagName: 'a', attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } };
      }
      return { tagName: 'a', attribs };
    },
    input: (tag, attribs) => ({
      tagName: 'input',
      attribs: attribs.type === 'checkbox' ? { ...attribs, disabled: '' } : {},
    }),
  },
};

export function renderMarkdown(src) {
  const toc = [];
  const used = new Map();
  const marked = new Marked(
    markedHighlight({
      emptyLangClass: 'hljs',
      langPrefix: 'hljs language-',
      highlight(code, lang) {
        const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
        return hljs.highlight(code, { language, ignoreIllegals: true }).value;
      },
    }),
    {
      gfm: true,
      renderer: {
        heading({ tokens, depth }) {
          const html = this.parser.parseInline(tokens);
          const plain = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} });
          let id = slugify(plain);
          const n = used.get(id) || 0;
          used.set(id, n + 1);
          if (n) id = `${id}-${n}`;
          toc.push({ depth, id, text: plain });
          return `<h${depth} id="${id}">${html}</h${depth}>\n`;
        },
      },
    }
  );
  const html = sanitizeHtml(marked.parse(src), SANITIZE);
  return { html, toc };
}

export function renderText(src) {
  return `<pre class="plain-text">${escapeHtml(src)}</pre>`;
}

// ---- search ----

export function parseQuery(q) {
  const terms = [];
  String(q || '')
    .toLowerCase()
    .replace(/"([^"]+)"|(\S+)/g, (m, phrase, word) => {
      const t = (phrase || word).trim();
      if (t) terms.push(t);
      return '';
    });
  return [...new Set(terms)].slice(0, 12);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlight(text, re) {
  // Escape piecewise so <mark> survives and nothing else becomes markup.
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += escapeHtml(text.slice(last, m.index)) + '<mark>' + escapeHtml(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

export function search(entries, q, { limit = 200 } = {}) {
  const terms = parseQuery(q);
  if (!terms.length) return [];
  const re = new RegExp(terms.map(escapeRe).join('|'), 'gi');
  const results = [];
  for (const e of entries) {
    const title = e.title.toLowerCase();
    const body = e.text.toLowerCase();
    const where = (e.category + ' ' + e.file).toLowerCase();
    let score = 0;
    let ok = true;
    for (const t of terms) {
      const inTitle = title.includes(t);
      const inWhere = where.includes(t);
      let count = 0;
      for (let i = body.indexOf(t); i !== -1 && count < 50; i = body.indexOf(t, i + t.length)) count++;
      if (!inTitle && !inWhere && !count) {
        ok = false;
        break;
      }
      score += (inTitle ? 20 : 0) + (inWhere ? 5 : 0) + Math.min(count, 20);
    }
    if (!ok) continue;

    const snippets = [];
    const flat = e.text.replace(/\s+/g, ' ');
    const flatLower = flat.toLowerCase();
    let from = 0;
    while (snippets.length < 3) {
      let best = -1;
      for (const t of terms) {
        const i = flatLower.indexOf(t, from);
        if (i !== -1 && (best === -1 || i < best)) best = i;
      }
      if (best === -1) break;
      const start = Math.max(0, best - 60);
      const end = Math.min(flat.length, best + 120);
      snippets.push((start ? '…' : '') + highlight(flat.slice(start, end), re) + (end < flat.length ? '…' : ''));
      from = end;
    }
    results.push({
      ...strip(e),
      score,
      titleHtml: highlight(e.title, re),
      snippets,
    });
  }
  results.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  return results.slice(0, limit);
}

export function strip(e) {
  const { text, ...rest } = e;
  return rest;
}
