// Full-text search in a kiwix-serve instance (the "Offline library").
// The vault server calls kiwix-serve and hands the browser plain-text results, so the
// browser never talks to Kiwix for search, and a slow or stopped Kiwix only empties
// the "Offline library" section instead of breaking sheet search.

export const MAX_QUERY = 200;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SNIPPET = 300;

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
  const total = Number(plain(tag(xml, 'opensearch:totalResults'))) || 0;
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
  return { total: Math.max(total, results.length), results };
}

// Searches every book in the library. Never throws for Kiwix trouble: returns
// { available: false } when kiwix-serve is down, slow, or answers with junk.
export async function searchLibrary(base, q, { limit = 10, timeoutMs = 3000, fetchImpl = fetch } = {}) {
  const pattern = String(q ?? '').trim().slice(0, MAX_QUERY);
  if (!pattern) return { available: true, total: 0, results: [] };
  const url = `${base}/search?${new URLSearchParams({ pattern, format: 'xml', pageLength: String(limit) })}`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    // 400/404 = nothing searchable for this query (e.g. no full-text index), not an outage.
    if (res.status === 400 || res.status === 404) {
      await res.body?.cancel();
      return { available: true, total: 0, results: [] };
    }
    if (!res.ok) throw new Error(`kiwix-serve answered ${res.status}`);
    const xml = await readLimited(res, MAX_BYTES);
    return { available: true, ...parseSearchXml(xml) };
  } catch (err) {
    console.warn(`library-search: ${err.name === 'TimeoutError' ? 'kiwix-serve timed out' : err.message}`);
    return { available: false, total: 0, results: [] };
  }
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
