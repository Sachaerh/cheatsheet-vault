// Full-text search in a kiwix-serve instance (the "Offline library").
// The vault server calls kiwix-serve and hands the browser plain-text results, so the
// browser never talks to Kiwix for search, and a slow or stopped Kiwix only empties
// the "Offline library" section instead of breaking sheet search.

export const MAX_QUERY = 200;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SNIPPET = 300;
// Hits are fetched a page at a time until `limit` remain after hiding translations
// (for "tourniquet", only 4 of the first 50 hits are English).
const PAGE = 50;
const MAX_PAGES = 3;

// Translated copies of English articles crowd them out of search, so search hides them; Kiwix still serves them.
// WikEM: machine translations at <Page>/<lang> (15 languages; <Page>/en is the English source and stays).
const WIKEM_TRANSLATION = /^\/content\/wikem_[^/]*\/.+\/(?:ar|de|es|fr|hi|id|it|ja|ko|pl|pt|ru|tr|vi|zh)$/;
// ArchWiki: "<Page> (<Language>)", and anything under such a page ("Translation Team (Português)/Terminologia"). Only these names,
// since English pages also end in parentheses ("(Gen 2)", "(AMD)"). Taken from the 2026-07 ZIM, including
// misspelled redirect titles ("Magya", "Epspañol", "Russian").
const ARCH_LANGUAGES = [
  'العربية', 'Bahasa Indonesia', 'Bahasa Melayu', 'বাংলা', 'Bosanski', 'Български', 'Català', 'Česky', 'Čeština',
  'Czech', 'Dansk', 'Deutsch', 'Ελληνικά', 'Epspañol', 'Español', 'Esperanto', 'فارسی', 'Français',
  'עברית', 'हिन्दी', 'Hrvatski', 'Indonesia', 'Italiano', '日本語', '한국어', 'Latviešu', 'Lietuviškai', 'Lietuvių',
  'Magya', 'Magyar', 'Nederlands', 'Norsk Bokmål', 'Polski', 'Português', 'Português do Brasil', 'Qhichwa',
  'Română', 'Russian', 'Русский', 'Slovenčina', 'Slovenský', 'Slovensky', 'Slovenščina', 'Српски', 'Suomi',
  'Svenska', 'ไทย', 'Tiếng Việt', 'Türkçe', 'Українська', '文言文', '粵語', '简体中文', '正體中文', '繁體中文',
];
const ARCH_TRANSLATION = new RegExp(
  `^/content/archlinux_[^/]*/.*\\([ _]*(?:${ARCH_LANGUAGES.map((l) => l.replace(/ /g, '[ _]')).join('|')})[ _]*\\)(?:/|$)`,
  'iu',
);
export function isTranslation(path) {
  let p = path;
  try {
    p = decodeURIComponent(path); // kiwix-serve percent-encodes non-ASCII titles
  } catch {}
  return WIKEM_TRANSLATION.test(p) || ARCH_TRANSLATION.test(p);
}

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

// Searches every book in the library and returns up to `limit` hits, translations left out.
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
    kept.push(...results.filter((r) => !isTranslation(r.path)));
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
