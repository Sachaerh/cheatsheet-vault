// Locks and "Download all": unit tests for the converters, and an own server for the API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { htmlToMarkdown, buildBundle, buildZip } from '../lib/export.js';
import { isLocked } from '../lib/store.js';

// Minimal ZIP reader (central directory) to check what buildZip wrote.
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out[name] = zlib.inflateRawSync(buf.subarray(start, start + size)).toString('utf8');
    p += 46 + nameLen;
  }
  return out;
}

test('isLocked: a sheet or folder is locked by itself or by any folder above it', () => {
  const s = new Set(['Private/', 'a/b/c.md']);
  assert.equal(isLocked(s, 'Private/x.md'), true);
  assert.equal(isLocked(s, 'Private/deep/er/x.md'), true);
  assert.equal(isLocked(s, 'Private/sub/'), true);
  assert.equal(isLocked(s, 'Private/'), true);
  assert.equal(isLocked(s, 'Privateer/x.md'), false);
  assert.equal(isLocked(s, 'a/b/c.md'), true);
  assert.equal(isLocked(s, 'a/b/d.md'), false);
  assert.equal(isLocked(s, 'top.md'), false);
});

test('htmlToMarkdown keeps headings, lists, tables and code, drops styles and UI', () => {
  const md = htmlToMarkdown(`<!doctype html><html><head><title>T</title><style>.x{color:red}</style></head><body>
    <nav><button>Theme</button></nav>
    <h1>Linux &amp; Shell</h1>
    <p>Use <code>ls -la</code> to list.</p>
    <ul><li>one</li><li>two <b>bold</b></li></ul>
    <table><thead><tr><th>Cmd</th><th>Does</th></tr></thead>
      <tbody><tr><td><code>a|b</code></td><td>pipe<br>it</td></tr></tbody></table>
    <pre><code>for f in *; do
  echo "$f" &gt; out
done</code></pre>
    <script>document.title = 'small'</script>
  </body></html>`);
  assert.match(md, /^## Linux & Shell$/m);
  assert.match(md, /Use `ls -la` to list\./);
  assert.match(md, /^- one$/m);
  assert.match(md, /^- two bold$/m);
  assert.match(md, /^\| Cmd \| Does \|\n\| --- \| --- \|\n\| `a\\\|b` \| pipe it \|$/m);
  assert.match(md, /```\nfor f in \*; do\n  echo "\$f" > out\ndone\n```/);
  assert.doesNotMatch(md, /color:red|Theme|document\.title/); // small UI script is not content
});

test('htmlToMarkdown includes the script when the page builds its content in JavaScript', () => {
  const data = "const data = [{ name: 'Application', protocols: 'HTTP/S, DNS, SMTP' }];".repeat(5);
  const md = htmlToMarkdown(`<div id="app"><h1>OSI</h1></div><script>${data}</script>`);
  assert.match(md, /^## OSI$/m);
  assert.match(md, /builds its content with JavaScript/);
  assert.match(md, /```js\nconst data = \[\{ name: 'Application'/);
});

test('buildBundle: contents list, one section per sheet, no repeated title heading', () => {
  const md = buildBundle(
    [
      { title: 'Git', category: 'code', path: 'code/Git.md', content: '# Git\n\n- `git status`\n' },
      { title: 'Notes', category: '', path: 'Notes.txt', content: 'plain' },
    ],
    { date: new Date('2026-10-24T12:00:00Z') },
  );
  assert.match(md, /^# Cheatsheet Vault export\n\nExported 2026-10-24 · 2 sheets/);
  assert.match(md, /^1\. Git \(code\)\n2\. Notes$/m);
  assert.match(md, /---\n\n# Git\n\nFolder: code · File: code\/Git\.md\n\n- `git status`\n/);
  assert.equal(md.match(/^# Git$/gm).length, 1);
  assert.match(md, /Folder: top level · File: Notes\.txt\n\nplain\n$/);
});

test('buildZip writes a valid archive with UTF-8 names', () => {
  const zip = buildZip([
    { name: 'a/Über.md', data: Buffer.from('# hi\n'), mtime: Date.parse('2026-10-24T12:00:00Z') },
    { name: 'b.txt', data: Buffer.from('x'.repeat(5000)) },
  ]);
  assert.deepEqual(readZip(zip), { 'a/Über.md': '# hi\n', 'b.txt': 'x'.repeat(5000) });
  assert.deepEqual(readZip(buildZip([])), {});
});

// ---- API ----
const PORT = 39900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = 'Basic ' + Buffer.from('u:p').toString('base64');
let dir, proc;

const req = (p, opts = {}) =>
  fetch(BASE + p, { ...opts, headers: { Authorization: AUTH, 'X-Vault': '1', ...(opts.headers || {}) } });
const json = (method, p, body) =>
  req(p, { method, body: body && JSON.stringify(body), headers: body ? { 'Content-Type': 'application/json' } : {} });
const locksNow = async () => (await (await req('/api/locks')).json()).locks;
const lock = async (body) => (await (await json('PUT', '/api/locks', body)).json()).locks;
const exportMd = async () => (await req('/export')).text();

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cv-export-'));
  await fs.mkdir(path.join(dir, 'TrueNAS'));
  await fs.mkdir(path.join(dir, 'Linux'));
  await fs.writeFile(path.join(dir, 'TrueNAS', 'NAS Network.html'), '<title>NAS Network</title><h1>NAS</h1><p>SECRET-NAS-IP</p>');
  await fs.writeFile(path.join(dir, 'Linux', 'Shell.md'), '# Shell\n\nls -la\n');
  await fs.writeFile(path.join(dir, 'Linux', 'Private notes.md'), '# Private notes\n\nSECRET-NOTE\n');
  await fs.writeFile(path.join(dir, 'Top.txt'), 'top level text');
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

test('export needs auth and includes every sheet when nothing is locked', async () => {
  assert.equal((await fetch(BASE + '/export')).status, 401);
  const r = await req('/export');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/markdown; charset=utf-8/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="cheatsheet-vault-\d{4}-\d{2}-\d{2}\.md"/);
  const md = await r.text();
  assert.match(md, /4 sheets/);
  for (const s of ['SECRET-NAS-IP', 'SECRET-NOTE', 'ls -la', 'top level text']) assert.ok(md.includes(s), s);
  assert.match(md, /^## NAS$/m); // HTML converted to Markdown
  assert.deepEqual((await (await req('/api/sheets')).json()).locks, []);
});

test('locks: only existing sheets and folders; locked ones leave both export formats', async () => {
  assert.deepEqual(await lock({ add: ['TrueNAS/', 'Linux/Private notes.md', 'nope/', 'nope.md', 'Linux', 42] }), ['Linux/Private notes.md', 'TrueNAS/']);
  assert.equal((await json('PUT', '/api/locks', { add: 'TrueNAS/' })).status, 400);
  assert.equal((await fetch(BASE + '/api/locks', { headers: { Authorization: AUTH } })).status, 403); // X-Vault guard

  const md = await exportMd();
  assert.match(md, /2 sheets/);
  assert.ok(!md.includes('SECRET'), 'locked content is left out');
  assert.ok(!md.includes('NAS Network') && !md.includes('Private notes'), 'locked titles are not listed either');
  assert.ok(md.includes('ls -la') && md.includes('top level text'));

  const r = await req('/export?format=zip');
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.match(r.headers.get('content-disposition'), /\.zip"$/);
  const files = readZip(Buffer.from(await r.arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), ['Linux/Shell.md', 'Top.txt']);
  assert.equal(files['Linux/Shell.md'], '# Shell\n\nls -la\n');
});

test('locks: new sheets in a locked folder are locked; sheets keep their lock when moved', async () => {
  let r = await json('POST', '/api/sheets', { content: '# Pool\n\nSECRET-POOL', category: 'TrueNAS' });
  const pool = (await r.json()).path;
  assert.ok(!(await exportMd()).includes('SECRET-POOL'));

  // Moved out of the locked folder: it gets its own lock instead of becoming public.
  r = await json('POST', '/api/move', { path: pool, category: 'Linux' });
  assert.equal((await r.json()).path, 'Linux/Pool.md');
  assert.ok((await locksNow()).includes('Linux/Pool.md'));
  assert.ok(!(await exportMd()).includes('SECRET-POOL'));

  // A locked sheet renamed keeps its lock under the new name.
  r = await json('POST', '/api/move', { path: 'Linux/Private notes.md', name: 'Diary' });
  assert.equal((await r.json()).path, 'Linux/Diary.md');
  assert.deepEqual(await locksNow(), ['Linux/Diary.md', 'Linux/Pool.md', 'TrueNAS/']);

  // Unlocking works; an unlocked sheet moved into a locked folder is covered by it.
  await lock({ remove: ['Linux/Pool.md'] });
  assert.ok((await exportMd()).includes('SECRET-POOL'));
  r = await json('POST', '/api/move-many', { paths: ['Linux/Pool.md'], folder: 'TrueNAS' });
  assert.deepEqual((await r.json()).moved, { 'Linux/Pool.md': 'TrueNAS/Pool.md' });
  assert.deepEqual(await locksNow(), ['Linux/Diary.md', 'TrueNAS/']);
  assert.ok(!(await exportMd()).includes('SECRET-POOL'));
});

test('locks: folder locks follow renames and moves; deleting drops them', async () => {
  let r = await json('POST', '/api/folders/move', { path: 'TrueNAS', name: 'NAS' });
  assert.equal((await r.json()).path, 'NAS');
  assert.deepEqual(await locksNow(), ['Linux/Diary.md', 'NAS/']);
  assert.ok(!(await exportMd()).includes('SECRET-NAS-IP'));

  // Into an unlocked folder: still locked, under its new path.
  r = await json('POST', '/api/folders/move', { path: 'NAS', to: 'Linux' });
  assert.equal((await r.json()).path, 'Linux/NAS');
  assert.deepEqual(await locksNow(), ['Linux/Diary.md', 'Linux/NAS/']);

  // A subfolder moved out of a locked folder takes the lock with it.
  await json('POST', '/api/folders', { path: 'Linux/NAS/Sub' });
  await json('POST', '/api/sheets', { content: '# Deep\n\nSECRET-DEEP', category: 'Linux/NAS/Sub' });
  r = await json('POST', '/api/folders/move', { path: 'Linux/NAS/Sub', to: '' });
  assert.equal((await r.json()).path, 'Sub');
  assert.ok((await locksNow()).includes('Sub/'));
  const md = await exportMd();
  assert.ok(!md.includes('SECRET'), md);

  r = await req('/api/folders?path=Linux%2FNAS', { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.deepEqual(await locksNow(), ['Linux/Diary.md', 'Sub/']);
  r = await req('/api/sheet?path=' + encodeURIComponent('Linux/Diary.md'), { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.deepEqual(await locksNow(), ['Sub/']);
});

test('the viewer and library pages have the lock and Download all controls', async () => {
  const lib = await (await req('/')).text();
  assert.match(lib, /id="exportBtn"/);
  assert.match(lib, /id="selLock"/);
  const view = await (await req('/view/Top.txt')).text();
  assert.match(view, /data-action="lock"/);
});
