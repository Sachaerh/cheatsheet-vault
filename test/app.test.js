// Integration tests: start the server against a temp folder and drive the API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PORT = 39000 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = 'Basic ' + Buffer.from('u:p').toString('base64');
let dir, proc;

const req = (p, opts = {}) =>
  fetch(BASE + p, { ...opts, headers: { Authorization: AUTH, 'X-Vault': '1', ...(opts.headers || {}) } });
const json = (method, p, body) =>
  req(p, { method, body: body && JSON.stringify(body), headers: body ? { 'Content-Type': 'application/json' } : {} });

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cv-'));
  await fs.writeFile(path.join(os.tmpdir(), 'cv-outside.md'), '# secret');
  proc = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT), SHEETS_DIR: dir, AUTH_USER: 'u', AUTH_PASS: 'p', ANTHROPIC_API_KEY: '' },
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
  await fs.rm(dir, { recursive: true, force: true });
});

test('seeds a welcome sheet and requires auth', async () => {
  assert.equal((await fetch(BASE + '/')).status, 401);
  assert.equal((await fetch(BASE + '/', { headers: { Authorization: 'Basic ' + Buffer.from('u:x').toString('base64') } })).status, 401);
  const { sheets } = await (await req('/api/sheets')).json();
  assert.deepEqual(sheets.map((s) => s.title), ['Getting Started']);
});

test('offline library is off without KIWIX_URL', async () => {
  const data = await (await req('/api/sheets')).json();
  assert.equal(data.library, null);
  assert.equal((await req('/api/library-search?q=x')).status, 404);
});

test('API refuses requests without X-Vault or from a null origin', async () => {
  assert.equal((await fetch(BASE + '/api/sheets', { headers: { Authorization: AUTH } })).status, 403);
  assert.equal((await req('/api/sheets', { headers: { Origin: 'null' } })).status, 403);
  assert.equal((await req('/api/sheets', { headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await req('/api/sheets', { headers: { Origin: BASE } })).status, 200);
});

test('paste: detects markdown and html, titles and categories', async () => {
  let r = await json('POST', '/api/sheets', { content: '# Git Tricks\n\n```bash\ngit rebase -i HEAD~3\n```\n', category: 'code/git' });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).path, 'code/git/Git Tricks.md');
  r = await json('POST', '/api/sheets', { content: '<!doctype html><html><head><title>Vim &amp; More</title></head><body><script>1</script><p>zebra</p></body></html>' });
  assert.equal((await r.json()).path, 'Vim & More.html');
  const s = await (await req('/api/sheet?path=' + encodeURIComponent('Vim & More.html'))).json();
  assert.equal(s.type, 'html');
  assert.equal(s.title, 'Vim & More');
});

test('search finds body text with highlighted, escaped snippets', async () => {
  const { results } = await (await req('/api/search?q=rebase')).json();
  assert.equal(results[0].title, 'Git Tricks');
  assert.match(results[0].snippets[0], /<mark>rebase<\/mark>/);
  const html = await (await req('/api/search?q=zebra')).json();
  assert.equal(html.results.length, 1);
  const none = await (await req('/api/search?q=' + encodeURIComponent('"nothing like this"'))).json();
  assert.equal(none.results.length, 0);
});

test('upload, edit, move and delete', async () => {
  const fd = new FormData();
  fd.append('category', 'misc');
  fd.append('files', new Blob(['plain words here']), 'notes.txt');
  fd.append('files', new Blob(['nope']), 'evil.exe');
  let r = await req('/api/upload', { method: 'POST', body: fd });
  const up = await r.json();
  assert.deepEqual(up.created, ['misc/notes.txt']);
  assert.equal(up.skipped[0].name, 'evil.exe');

  r = await json('PUT', '/api/sheet', { path: 'misc/notes.txt', content: 'edited words' });
  assert.equal(r.status, 200);
  assert.equal(await fs.readFile(path.join(dir, 'misc/notes.txt'), 'utf8'), 'edited words');

  r = await json('POST', '/api/move', { path: 'misc/notes.txt', name: 'Notes', category: 'other/deep' });
  assert.equal((await r.json()).path, 'other/deep/Notes.txt');
  await assert.rejects(fs.stat(path.join(dir, 'misc')), 'empty category removed');

  r = await req('/api/sheet?path=' + encodeURIComponent('other/deep/Notes.txt'), { method: 'DELETE' });
  assert.equal(r.status, 200);
  const trash = await fs.readdir(path.join(dir, '.trash'));
  assert.equal(trash.length, 1);
  const { sheets } = await (await req('/api/sheets')).json();
  assert.ok(!sheets.some((s) => s.path.includes('Notes')));
});

test('paths cannot escape SHEETS_DIR', async () => {
  for (const p of ['../cv-outside.md', '..%2fcv-outside.md', '/etc/passwd', 'a/../../cv-outside.md', '.trash/x.md']) {
    const r = await req('/api/sheet?path=' + encodeURIComponent(p));
    assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
  }
  assert.ok([400, 404].includes((await req('/raw/..%2f..%2fetc%2fpasswd')).status));
  await fs.symlink(path.join(os.tmpdir(), 'cv-outside.md'), path.join(dir, 'link.md'));
  assert.equal((await req('/raw/link.md')).status, 403);
  let r = await json('POST', '/api/sheets', { content: 'x', title: '../../escape', category: '../../../tmp' });
  const created = (await r.json()).path;
  assert.ok(!created.includes('..'), created);
  r = await json('POST', '/api/move', { path: created, category: '../..' });
  assert.ok(!(await r.json()).path.includes('..'));
});

test('html sheets are served with a CSP sandbox; markdown is sanitized', async () => {
  const raw = await req('/raw/' + encodeURIComponent('Vim & More.html'));
  assert.match(raw.headers.get('content-security-policy'), /^sandbox allow-scripts/);
  const r = await json('POST', '/api/sheets', { content: '# XSS\n\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n\n## A\n## B\n## C\n' });
  const p = (await r.json()).path;
  const view = await (await req('/view/' + encodeURIComponent(p))).text();
  assert.ok(!view.includes('<script>alert'));
  assert.doesNotMatch(view, /<img[^>]*onerror/);
  assert.doesNotMatch(view, /<script>alert/);
  assert.match(view, /class="toc"/);
  const md = await (await req('/view/code/git/Git%20Tricks.md')).text();
  assert.match(md, /hljs language-bash/);
});

// ---- folders ----
const exists = (p) => fs.stat(path.join(dir, p)).then(() => true, () => false);
const sheetsNow = async () => (await (await req('/api/sheets')).json());

test('folders: create empty folders that survive, list them, refuse duplicates', async () => {
  let r = await json('POST', '/api/folders', { path: 'notes' });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).path, 'notes');
  assert.ok(await exists('notes/.keep'));
  r = await json('POST', '/api/folders', { path: 'notes/empty sub' });
  assert.equal(r.status, 201);
  assert.equal((await json('POST', '/api/folders', { path: 'notes' })).status, 409);
  assert.equal((await json('POST', '/api/folders', { path: 'missing/parent' })).status, 404);
  const { folders } = await sheetsNow();
  assert.ok(folders.includes('notes') && folders.includes('notes/empty sub'));
  assert.ok(!folders.some((f) => f.startsWith('.')));

  // Moving the only sheet out of a .keep folder leaves the folder in place.
  r = await json('POST', '/api/sheets', { content: '# Temp\n', category: 'notes' });
  assert.equal((await r.json()).path, 'notes/Temp.md');
  r = await json('POST', '/api/move', { path: 'notes/Temp.md', category: '' });
  assert.equal((await r.json()).path, 'Temp.md');
  assert.ok(await exists('notes'));
});

test('folders: paths are validated and cannot leave the data folder', async () => {
  const bad = ['..', '../outside', 'a/../../x', '.trash', '.hidden', 'a/.git', '/etc', 'a\\..\\b', 'x\u0000y', '', 'a//b'];
  for (const p of bad) {
    const r = await json('POST', '/api/folders', { path: p });
    assert.equal(r.status, 400, `create ${JSON.stringify(p)}`);
  }
  for (const p of ['..', '%2e%2e', '..%2f..%2ftmp', '.trash', '']) {
    const r = await req('/api/folders?path=' + p, { method: 'DELETE' });
    assert.equal(r.status, 400, `delete ${p}`);
  }
  for (const body of [{ path: 'notes', to: '..' }, { path: 'notes', name: '../x' }, { path: 'notes', name: '.x' }, { path: '..', name: 'x' }, { path: 'notes', to: '/tmp' }]) {
    const r = await json('POST', '/api/folders/move', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await json('POST', '/api/move-many', { paths: ['Temp.md'], folder: '../..' })).status, 400);
  assert.ok(await exists('notes'));
  // A symlinked folder pointing outside is neither listed nor usable.
  await fs.symlink(os.tmpdir(), path.join(dir, 'escape'));
  assert.ok(!(await sheetsNow()).folders.includes('escape'));
  assert.equal((await json('POST', '/api/folders', { path: 'escape/new' })).status, 403);
  assert.equal((await json('POST', '/api/move-many', { paths: ['Temp.md'], folder: 'escape' })).status, 403);
  assert.equal((await json('POST', '/api/folders/move', { path: 'notes', to: 'escape' })).status, 403);
  assert.equal((await req('/api/folders?path=escape', { method: 'DELETE' })).status, 403);
  await fs.unlink(path.join(dir, 'escape'));
});

test('folders: rename and move keep sheets and stars; no moving into itself', async () => {
  await json('POST', '/api/folders', { path: 'lang' });
  let r = await json('POST', '/api/sheets', { content: '# Py\n', category: 'lang/python' });
  const py = (await r.json()).path;
  assert.equal(py, 'lang/python/Py.md');
  r = await json('PUT', '/api/stars', { add: [py, 'does/not/exist.md'] });
  assert.deepEqual((await r.json()).stars, [py]);

  // "code" already exists (from the paste test): never merge folders.
  assert.equal((await json('POST', '/api/folders/move', { path: 'lang', name: 'code' })).status, 409);

  r = await json('POST', '/api/folders/move', { path: 'lang', name: 'languages' });
  assert.equal((await r.json()).path, 'languages');
  assert.ok(await exists('languages/python/Py.md'));
  let s = await sheetsNow();
  assert.deepEqual(s.stars, ['languages/python/Py.md']);

  r = await json('POST', '/api/folders/move', { path: 'languages', to: 'code' });
  assert.equal((await r.json()).path, 'code/languages');
  assert.ok(await exists('code/git/Git Tricks.md'), 'existing contents of the target are untouched');
  s = await sheetsNow();
  assert.deepEqual(s.stars, ['code/languages/python/Py.md']);
  assert.ok(s.sheets.some((x) => x.path === 'code/languages/python/Py.md'));

  for (const to of ['code', 'code/languages', 'code/languages/python']) {
    r = await json('POST', '/api/folders/move', { path: 'code', to });
    assert.equal(r.status, 400, `code -> ${to}`);
  }
  assert.equal((await json('POST', '/api/folders/move', { path: 'nope', name: 'x' })).status, 404);
});

test('move-many moves sheets into a folder and keeps their stars', async () => {
  await json('PUT', '/api/stars', { add: ['Temp.md'] });
  let r = await json('POST', '/api/move-many', { paths: ['Temp.md', 'Vim & More.html', 'missing.md'], folder: 'notes/empty sub' });
  const out = await r.json();
  assert.deepEqual(out.moved, { 'Temp.md': 'notes/empty sub/Temp.md', 'Vim & More.html': 'notes/empty sub/Vim & More.html' });
  assert.equal(out.failed.length, 1);
  assert.ok((await sheetsNow()).stars.includes('notes/empty sub/Temp.md'));
  assert.equal((await json('POST', '/api/move-many', { paths: ['notes/empty sub/Temp.md'], folder: 'no/such' })).status, 404);
  assert.equal((await json('POST', '/api/move-many', { paths: 'Temp.md', folder: '' })).status, 400);

  // Sheet rename through the old endpoint keeps the star too.
  r = await json('POST', '/api/move', { path: 'notes/empty sub/Temp.md', name: 'Temp2' });
  assert.equal((await r.json()).path, 'notes/empty sub/Temp2.md');
  assert.ok((await sheetsNow()).stars.includes('notes/empty sub/Temp2.md'));
});

test('deleting a folder moves it and its contents to .trash and drops its stars', async () => {
  const before = await fs.readdir(path.join(dir, '.trash'));
  const r = await req('/api/folders?path=' + encodeURIComponent('notes'), { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).sheets, 2);
  assert.ok(!(await exists('notes')));
  const added = (await fs.readdir(path.join(dir, '.trash'))).filter((n) => !before.includes(n));
  assert.equal(added.length, 1);
  assert.match(added[0], /__notes$/);
  assert.ok(await exists(`.trash/${added[0]}/empty sub/Temp2.md`));
  const s = await sheetsNow();
  assert.ok(!s.stars.some((x) => x.startsWith('notes/')));
  assert.ok(!s.folders.some((f) => f.startsWith('notes')));
  assert.ok(s.stars.includes('code/languages/python/Py.md'));
});

test('markdown sanitizing strips every script vector, for any sheet', async () => {
  const evil = [
    '# Evil',
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(2)>',
    '[click](javascript:alert(3))',
    '[proto](//evil.example/x)',
    '<iframe src="https://evil.example"></iframe>',
    '<svg onload=alert(4)><circle/></svg>',
    '<p style="position:fixed;inset:0">overlay</p>',
    '<div class="modal topbar">fake ui</div>',
    '<object data="x.swf"></object><embed src="x.swf">',
    '<form action="https://evil.example"><input name=q></form>',
    '<a href="https://ok.example" onclick="alert(5)">ok</a>',
    '```js',
    'const safe = "<script>in code</script>";',
    '```',
  ].join('\n\n');
  const p = (await (await json('POST', '/api/sheets', { content: evil })).json()).path;
  const view = await (await req('/view/' + encodeURIComponent(p))).text();
  const article = view.slice(view.indexOf('<article'), view.indexOf('</article>'));
  assert.doesNotMatch(article, /<script|onerror|onload|onclick|javascript:|<iframe|<svg|<object|<embed|<form|style=|href="\/\/|class="modal/i);
  assert.match(article, /<a href="https:\/\/ok\.example" target="_blank" rel="noopener noreferrer">ok<\/a>/);
  assert.match(article, /&lt;script&gt;in code/); // code is shown as text
  assert.match(article, /class="hljs language-js"/); // highlighting classes survive
});

test('create from link: not set up without an API key', async () => {
  const data = await (await req('/api/sheets')).json();
  assert.equal(data.fromLink, false);
  const r = await json('POST', '/api/from-link', { url: 'https://example.com/' });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /ANTHROPIC_API_KEY/);
  // The page loads and the button is there (hidden by the client).
  assert.match(await (await req('/')).text(), /id="linkBtn" hidden/);
});
