// Fetch a public web page for "Create from link" without letting the request
// reach the NAS, the LAN or the tailnet (SSRF guard), then reduce it to text.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import sanitizeHtml from 'sanitize-html';
import { HttpError, decodeEntities } from './store.js';

export const MAX_BYTES = 3 * 1024 * 1024;
export const MAX_CHARS = 200_000;
export const TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 5;
const UA = 'CheatsheetVault/1.2 (+link import)';
const TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);

export const BLOCKED_MSG = 'This address is blocked (private or local network)';

// ---- address policy ----
const blocked = new net.BlockList();
for (const [net4, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(net4, bits, 'ipv4');
for (const [net6, bits] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  ['2001:db8::', 32], ['100::', 64], ['2001::', 32], // 2001::/32 = Teredo (embeds an IPv4 address)
]) blocked.addSubnet(net6, bits, 'ipv6');

// Expand an IPv6 address to 8 numeric groups.
function v6groups(ip) {
  let s = ip.toLowerCase().split('%')[0];
  const m = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const b = m[1].split('.').map(Number);
    s = s.slice(0, -m[1].length) + ((b[0] << 8) | b[1]).toString(16) + ':' + ((b[2] << 8) | b[3]).toString(16);
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  return [...h, ...Array(fill).fill('0'), ...t].map((g) => parseInt(g, 16));
}

const v4of = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

export function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family !== 6) return true; // not an IP at all: refuse
  if (blocked.check(ip.split('%')[0], 'ipv6')) return true;
  const g = v6groups(ip);
  // IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible ::a.b.c.d, NAT64 64:ff9b::/96: check the embedded IPv4.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return blocked.check(v4of(g[6], g[7]), 'ipv4');
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return blocked.check(v4of(g[6], g[7]), 'ipv4');
  if (g[0] === 0x2002) return blocked.check(v4of(g[1], g[2]), 'ipv4'); // 6to4
  return false;
}

// ---- URL policy ----
export function checkUrl(input, { ports = [80, 443] } = {}) {
  let u;
  try {
    u = new URL(String(input ?? '').trim());
  } catch {
    throw new HttpError(400, 'That is not a valid link');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'Only http and https links are allowed');
  if (u.username || u.password) throw new HttpError(400, 'Links with a user name or password are not allowed');
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (!ports.includes(port)) throw new HttpError(400, 'Only the standard web ports (80 and 443) are allowed');
  if (!u.hostname || u.hostname.length > 253) throw new HttpError(400, 'That is not a valid link');
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.ts.net') || !host.includes('.') && !net.isIP(host)) {
    throw new HttpError(400, BLOCKED_MSG);
  }
  if (net.isIP(host) && isBlockedIp(host)) throw new HttpError(400, BLOCKED_MSG);
  u.hash = '';
  return u;
}

// dns.lookup-compatible function that refuses the connection if ANY address
// the name resolves to is blocked, and hands the socket only checked addresses.
function guardedLookup({ resolve, isBlocked }) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') [cb, options] = [options, {}];
    resolve(hostname)
      .then((addrs) => {
        if (!addrs.length) throw Object.assign(new Error('no addresses'), { code: 'ENOTFOUND' });
        if (addrs.some((a) => isBlocked(a.address, hostname))) throw new HttpError(400, BLOCKED_MSG);
        if (options && options.all) cb(null, addrs);
        else cb(null, addrs[0].address, addrs[0].family);
      })
      .catch((err) => cb(err));
  };
}

const defaultResolve = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

function charsetOf(contentType, head) {
  const m = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType || '') || /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head);
  return m ? m[1] : 'utf-8';
}

function decode(buf, label) {
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

// One HTTP request, no redirects followed. Resolves {status, headers, body?}.
function requestOnce(u, { signal, lookup, maxBytes }) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET',
      lookup,
      agent: false, // no pooled sockets, no env proxy
      signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en;q=1, *;q=0.5',
      },
    });
    req.on('error', reject);
    req.on('response', (res) => {
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ status, headers: res.headers });
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return reject(new HttpError(502, `The site answered with an error (HTTP ${status})`));
      }
      const type = String(res.headers['content-type'] || 'text/html').split(';')[0].trim().toLowerCase();
      if (!TYPES.has(type)) {
        res.destroy();
        return reject(new HttpError(415, `Not a web page (type: ${type.slice(0, 60)})`));
      }
      const tooBig = () => new HttpError(413, `Page is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
      if (Number(res.headers['content-length']) > maxBytes) {
        res.destroy();
        return reject(tooBig());
      }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      // Count decoded bytes so neither a false Content-Length nor a compression bomb gets past the cap.
      const chunks = [];
      let size = 0;
      stream.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          res.destroy();
          stream.destroy();
          reject(tooBig());
        } else chunks.push(c);
      });
      stream.on('error', (e) => reject(e));
      res.on('error', (e) => reject(e));
      stream.on('end', () => resolve({ status, headers: res.headers, type, body: Buffer.concat(chunks) }));
    });
    req.end();
  });
}

/**
 * Fetch a public page. Returns {url, finalUrl, type, title, text}.
 * opts.signal aborts (client went away). resolve/isBlocked/ports exist for tests only.
 */
export async function fetchPage(input, opts = {}) {
  const {
    signal: outer,
    timeoutMs = TIMEOUT_MS,
    maxBytes = MAX_BYTES,
    maxChars = MAX_CHARS,
    resolve = defaultResolve,
    isBlocked = (ip) => isBlockedIp(ip),
    ports,
  } = opts;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
  const lookup = guardedLookup({ resolve, isBlocked });
  const first = checkUrl(input, { ports });
  let u = first;
  try {
    for (let hop = 0; ; hop++) {
      const host = u.hostname.replace(/^\[|\]$/g, '');
      // Node skips lookup() for IP literals, so check those here.
      if (net.isIP(host) && isBlocked(host, host)) throw new HttpError(400, BLOCKED_MSG);
      const r = await requestOnce(u, { signal, lookup, maxBytes });
      if (r.body) {
        const head = r.body.subarray(0, 2048).toString('latin1');
        const raw = decode(r.body, charsetOf(r.headers['content-type'], head));
        const { title, text } = r.type === 'text/plain' ? { title: '', text: raw.trim() } : extractText(raw);
        if (!text) throw new HttpError(422, 'The page has no readable text (it may need JavaScript to load)');
        if (text.length > maxChars) {
          throw new HttpError(413, `Page is too long to summarize (${text.length.toLocaleString('en')} characters, limit ${maxChars.toLocaleString('en')})`);
        }
        return { url: first.href, finalUrl: u.href, type: r.type, title, text };
      }
      if (hop >= MAX_REDIRECTS) throw new HttpError(508, 'Too many redirects');
      let next;
      try {
        next = new URL(r.headers.location, u);
      } catch {
        throw new HttpError(502, 'The site sent a broken redirect');
      }
      u = checkUrl(next.href, { ports });
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (outer?.aborted) throw new HttpError(499, 'Cancelled');
    if (timeout.aborted || err.name === 'TimeoutError') throw new HttpError(504, 'Page took too long to load');
    if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') throw new HttpError(502, 'Could not find that site (DNS lookup failed)');
    if (/CERT|SSL|TLS/i.test(err.code || '')) throw new HttpError(502, 'The site has an invalid HTTPS certificate');
    throw new HttpError(502, 'Could not reach the site');
  }
}

// ---- HTML -> plain text with light structure ----
const KEEP = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'pre', 'code', 'br', 'div', 'tr', 'td', 'th',
  'blockquote', 'dt', 'dd', 'table', 'section', 'article', 'main', 'kbd', 'header'];
const DROP = ['script', 'style', 'textarea', 'option', 'noscript', 'svg', 'nav', 'footer', 'form', 'template',
  'iframe', 'head', 'button', 'select', 'aside', 'canvas', 'object', 'math'];

export function extractText(html) {
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = tm ? decodeEntities(tm[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  const clean = sanitizeHtml(html, { allowedTags: KEEP, allowedAttributes: {}, nonTextTags: DROP });
  const pres = [];
  const text = clean
    // Keep code blocks verbatim (fenced), everything else gets whitespace-collapsed.
    .replace(/<pre>([\s\S]*?)<\/pre>/gi, (m, body) => {
      pres.push('\n```\n' + decodeEntities(body.replace(/<[^>]*>/g, '')).replace(/\n+$/, '') + '\n```\n');
      return `\u0000${pres.length - 1}\u0000`;
    })
    .replace(/<h([1-6])>/gi, (m, n) => '\n\n' + '#'.repeat(Number(n)) + ' ')
    .replace(/<li>/gi, '\n- ')
    .replace(/<(code|kbd)>([\s\S]*?)<\/\1>/gi, (m, t, body) => '`' + body.replace(/<[^>]*>/g, '') + '`')
    .replace(/<(td|th)>/gi, ' | ')
    .replace(/<\/?(p|div|tr|br|blockquote|dt|dd|table|section|article|main|header|h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  const out = decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\u0000(\d+)\u0000/g, (m, i) => pres[Number(i)])
    .trim();
  return { title, text: out };
}
