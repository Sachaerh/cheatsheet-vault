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
    env: { ...process.env, PORT: String(PORT), SHEETS_DIR: dir, AUTH_USER: 'u', AUTH_PASS: 'p' },
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
