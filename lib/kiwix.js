// Full-text search in a kiwix-serve instance (the "Offline library").
// The vault server calls kiwix-serve and hands the browser plain-text results, so the
// browser never talks to Kiwix for search, and a slow or stopped Kiwix only empties
// the "Offline library" section instead of breaking sheet search.

export const MAX_QUERY = 200;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SNIPPET = 300;
// Hits are fetched a page at a time until `limit` remain after hiding machine translations
// (for "tourniquet", only 4 of the first 50 hits are English).
const PAGE = 50;
const MAX_PAGES = 3;

// WikEM ships a machine-translated copy of most pages at <Page>/<lang> (15 languages; <Page>/en is the
// English source and stays). They crowd out the English articles, so search hides them; Kiwix still serves them.
const MACHINE_TRANSLATED = /^\/content\/wikem_[^/]*\/.+\/(?:ar|de|es|fr|hi|id|it|ja|ko|pl|pt|ru|tr|vi|zh)$/;
export const isMachineTranslated = (path) => MACHINE_TRANSLATED.test(path);

// Returns the kiwix-serve base URL (no trailing slash), or '' when not configured.
export function kiwixBase(value) {
  if (!value) return '';
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`KIWIX_URL is not a valid URL: ${value}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('KIWIX_URL must be http(s)');
  return u.href.replace(/\/+$/, '');
}

// Port of KIWIX_URL, used for the plain-HTTP "Offline library" link.
export function kiwixPort(base) {
  const u = new URL(base);
  return Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

// Plain-text XML field (title, link, book): undo the XML escaping only.
const plain = (s) => decode(s ?? '').replace(/\s+/g, ' ').trim();

// Snippet: undo the XML escaping, drop the snippet's HTML tags, then undo its HTML escaping.
const text = (s) =>
  decode(
    decode(s ?? '')
      .replace(/<\/?(?:b|i|em|strong|span)\b[^>]*>/gi, '')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();

const tag = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1] : null;
};

// Parses kiwix-serve's /search?format=xml (RSS 2.0 + OpenSearch) into plain data.
// Only same-server content links are kept: anything else is dropped.
export function parseSearchXml(xml) {
  if (typeof xml !== 'string' || !/<rss[\s>]/.test(xml) || !/<channel[\s>]/.test(xml)) {
    throw new Error('Not a kiwix search response');
  }
  const results = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const link = plain(tag(item, 'link'));
    if (!link.startsWith('/') || link.startsWith('//')) continue;
    const bookXml = tag(item, 'book');
    let snippet = text(tag(item, 'description'));
    if (snippet.length > MAX_SNIPPET) snippet = snippet.slice(0, MAX_SNIPPET).replace(/\s+\S*$/, '') + '…';
    results.push({
      title: plain(tag(item, 'title')) || link,
      book: bookXml ? plain(tag(bookXml, 'title')) : '',
      path: link,
      snippet,
    });
  }
  return { results };
}

// Searches every book in the library and returns up to `limit` hits, machine translations left out.
// No total: kiwix-serve's totalResults is unreliable across several books (3 while returning 50 hits).
// Never throws for Kiwix trouble: returns { available: false } when kiwix-serve is down, slow, or
// answers with junk. One deadline covers all pages; if a later page fails, the hits so far are kept.
export async function searchLibrary(base, q, { limit = 10, timeoutMs = 3000, fetchImpl = fetch } = {}) {
  const pattern = String(q ?? '').trim().slice(0, MAX_QUERY);
  if (!pattern) return { available: true, results: [] };
  const signal = AbortSignal.timeout(timeoutMs);
  const kept = [];
  for (let page = 0; page < MAX_PAGES && kept.length < limit; page++) {
    let results;
    try {
      results = await fetchPage(base, pattern, page * PAGE, signal, fetchImpl);
    } catch (err) {
      console.warn(`library-search: ${err.name === 'TimeoutError' ? 'kiwix-serve timed out' : err.message}`);
      if (page === 0) return { available: false, results: [] };
      break;
    }
    kept.push(...results.filter((r) => !isMachineTranslated(r.path)));
    if (results.length < PAGE) break;
  }
  return { available: true, results: kept.slice(0, limit) };
}

async function fetchPage(base, pattern, start, signal, fetchImpl) {
  const params = { pattern, format: 'xml', start: String(start), pageLength: String(PAGE) };
  const res = await fetchImpl(`${base}/search?${new URLSearchParams(params)}`, { signal, redirect: 'error' });
  // 400/404 = nothing searchable for this query (e.g. no full-text index), not an outage.
  if (res.status === 400 || res.status === 404) {
    await res.body?.cancel();
    return [];
  }
  if (!res.ok) throw new Error(`kiwix-serve answered ${res.status}`);
  return parseSearchXml(await readLimited(res, MAX_BYTES)).results;
}

async function readLimited(res, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > max) throw new Error('kiwix-serve response too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
