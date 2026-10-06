// Offline library (kiwix-serve) search: XML parsing, failure handling, and the vault API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseSearchXml, searchLibrary, kiwixBase } from '../lib/kiwix.js';

// Shape of kiwix-serve 3.8 /search?format=xml output (snippets carry raw <b> tags).
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Search: pacman</title>
    <link>/search?pattern=pacman&amp;format=xml</link>
    <description>Search result for pacman</description>
    <opensearch:totalResults>42</opensearch:totalResults>
    <opensearch:startIndex>0</opensearch:startIndex>
    <opensearch:itemsPerPage>2</opensearch:itemsPerPage>
    <item>
      <title>Pacman</title>
      <link>/content/archlinux_en_all_maxi_2026-07/Pacman</link>
      <description>...<b>pacman</b> is the package manager &amp; more...</description>
      <book><title>ArchWiki</title></book>
      <wordCount>5000</wordCount>
    </item>
    <item>
      <title>Mirrors &amp; you</title>
      <link>/content/archlinux_en_all_maxi_2026-07/Mirrors</link>
      <description>Some builds escape it: &lt;b&gt;mirrors&lt;/b&gt; &amp;amp; &amp;lt;tag&amp;gt;</description>
      <book><title>ArchWiki</title></book>
    </item>
    <item>
      <title>std::vector&lt;T&gt; &lt;b&gt;</title>
      <link>/content/x/A</link>
    </item>
    <item>
      <title>Evil</title>
      <link>https://evil.example/x</link>
    </item>
    <item>
      <title>Evil 2</title>
      <link>//evil.example/x</link>
    </item>
  </channel>
</rss>`;

test('parses kiwix search XML into plain text and drops foreign links', () => {
  const { total, results } = parseSearchXml(XML);
  assert.equal(total, 42);
  assert.deepEqual(results, [
    {
      title: 'Pacman',
      book: 'ArchWiki',
      path: '/content/archlinux_en_all_maxi_2026-07/Pacman',
      snippet: '...pacman is the package manager & more...',
    },
    {
      title: 'Mirrors & you',
      book: 'ArchWiki',
      path: '/content/archlinux_en_all_maxi_2026-07/Mirrors',
      snippet: 'Some builds escape it: mirrors & <tag>',
    },
    { title: 'std::vector<T> <b>', book: '', path: '/content/x/A', snippet: '' },
  ]);
});

test('rejects non-RSS responses', () => {
  assert.throws(() => parseSearchXml('<html><body>oops</body></html>'));
  assert.throws(() => parseSearchXml(''));
});

test('kiwixBase validates and trims KIWIX_URL', () => {
  assert.equal(kiwixBase(''), '');
  assert.equal(kiwixBase(undefined), '');
  assert.equal(kiwixBase('http://10.0.0.5:30236/'), 'http://10.0.0.5:30236');
  assert.throws(() => kiwixBase('ftp://x'));
  assert.throws(() => kiwixBase('not a url'));
});

// ---- a fake kiwix-serve ----
let mode = 'ok';
let lastQuery = null;
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/search') return res.writeHead(404).end();
  lastQuery = Object.fromEntries(u.searchParams);
  if (mode === 'ok') return res.writeHead(200, { 'Content-Type': 'application/rss+xml' }).end(XML);
  if (mode === 'error') return res.writeHead(500).end('boom');
  if (mode === 'noindex') return res.writeHead(400).end('no full-text index');
  if (mode === 'junk') return res.writeHead(200).end('<html>not rss</html>');
  if (mode === 'huge') return res.writeHead(200).end('<rss><channel>' + 'x'.repeat(3 * 1024 * 1024));
  if (mode === 'slow') return setTimeout(() => res.writeHead(200).end(XML), 2000);
});
let fakeBase;

const PORT = 39500 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = 'Basic ' + Buffer.from('u:p').toString('base64');
let dir, proc;
const api = (p) => fetch(BASE + p, { headers: { Authorization: AUTH, 'X-Vault': '1' } });

before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakeBase = `http://127.0.0.1:${fake.address().port}`;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cv-kiwix-'));
  proc = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      SHEETS_DIR: dir,
      AUTH_USER: 'u',
      AUTH_PASS: 'p',
      ANTHROPIC_API_KEY: '',
      KIWIX_URL: fakeBase + '/',
      KIWIX_HTTPS_PORT: '8444',
    },
    stdio: 'inherit',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE + '/healthz')).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(async () => {
  proc.kill();
  fake.closeAllConnections();
  fake.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('searchLibrary: results, and the query reaches kiwix-serve', async () => {
  mode = 'ok';
  const r = await searchLibrary(fakeBase, '  pacman  ', { limit: 7 });
  assert.equal(r.available, true);
  assert.equal(r.results.length, 3);
  assert.deepEqual(lastQuery, { pattern: 'pacman', format: 'xml', pageLength: '7' });
});

test('searchLibrary: empty query does not call kiwix-serve', async () => {
  lastQuery = null;
  assert.deepEqual(await searchLibrary(fakeBase, '   '), { available: true, total: 0, results: [] });
  assert.equal(lastQuery, null);
});

test('searchLibrary: errors, junk, huge and slow answers mean "unavailable", never a throw', async () => {
  for (const m of ['error', 'junk', 'huge']) {
    mode = m;
    assert.deepEqual(await searchLibrary(fakeBase, 'x'), { available: false, total: 0, results: [] }, m);
  }
  mode = 'slow';
  const t0 = Date.now();
  assert.equal((await searchLibrary(fakeBase, 'x', { timeoutMs: 300 })).available, false);
  assert.ok(Date.now() - t0 < 1500, 'timeout is enforced');
  // Nothing listening at all.
  assert.equal((await searchLibrary('http://127.0.0.1:1', 'x')).available, false);
});

test('searchLibrary: 400 from kiwix (nothing searchable) is "no results", not an outage', async () => {
  mode = 'noindex';
  assert.deepEqual(await searchLibrary(fakeBase, 'x'), { available: true, total: 0, results: [] });
});

test('API: /api/sheets advertises the library ports', async () => {
  const data = await (await api('/api/sheets')).json();
  assert.deepEqual(data.library, { port: fake.address().port, httpsPort: 8444 });
});

test('API: /api/library-search proxies kiwix and survives it failing', async () => {
  mode = 'ok';
  let r = await api('/api/library-search?q=pacman');
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.equal(body.available, true);
  assert.equal(body.results[0].title, 'Pacman');
  mode = 'error';
  r = await api('/api/library-search?q=pacman');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).available, false);
  // Sheet search is unaffected while kiwix is failing.
  r = await api('/api/search?q=welcome');
  assert.equal(r.status, 200);
  // Same API guard as the rest: no X-Vault header, no answer.
  r = await fetch(BASE + '/api/library-search?q=x', { headers: { Authorization: AUTH } });
  assert.equal(r.status, 403);
});
