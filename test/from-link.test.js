// Integration tests for POST /api/from-link with a key configured. The fake key
// must never appear in a response or in the server's output.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PORT = 39600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = 'Basic ' + Buffer.from('u:p').toString('base64');
const KEY = 'sk-ant-api03-FAKE-KEY-MUST-NOT-LEAK-0123456789';
let dir, proc;
let output = '';

const post = (body, headers = {}) =>
  fetch(BASE + '/api/from-link', {
    method: 'POST',
    headers: { Authorization: AUTH, 'X-Vault': '1', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cv-link-'));
  await fs.mkdir(path.join(dir, 'notes'));
  proc = spawn(process.execPath, ['server.js'], {
    // Base URL points nowhere useful: no test here may reach the Claude API.
    env: { ...process.env, PORT: String(PORT), SHEETS_DIR: dir, AUTH_USER: 'u', AUTH_PASS: 'p', ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (c) => (output += c));
  proc.stderr.on('data', (c) => (output += c));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE + '/healthz')).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start:\n' + output);
});
after(async () => {
  proc.kill();
  await fs.rm(dir, { recursive: true, force: true });
  assert.ok(!output.includes(KEY), 'API key appeared in server output');
});

test('reports the feature as available', async () => {
  const data = await (await fetch(BASE + '/api/sheets', { headers: { Authorization: AUTH, 'X-Vault': '1' } })).json();
  assert.equal(data.fromLink, true);
  assert.ok(!JSON.stringify(data).includes(KEY));
});

test('needs auth, the X-Vault header and a same-host origin', async () => {
  const noAuth = await fetch(BASE + '/api/from-link', { method: 'POST', headers: { 'X-Vault': '1' } });
  assert.equal(noAuth.status, 401);
  assert.equal((await fetch(BASE + '/api/from-link', { method: 'POST', headers: { Authorization: AUTH } })).status, 403);
  assert.equal((await post({ url: 'https://example.com/' }, { Origin: 'null' })).status, 403);
  assert.equal((await post({ url: 'https://example.com/' }, { Origin: 'https://evil.example' })).status, 403);
});

test('blocks local, private and tailnet links before fetching anything', async () => {
  for (const url of [
    `http://127.0.0.1:${PORT}/api/sheets`, 'http://127.0.0.1/', 'http://localhost/', 'http://192.168.1.10/',
    'http://192.168.1.10:30090/', 'http://100.101.102.103/', 'https://nas.tail0000.ts.net:8443/',
    'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://2130706433/', 'http://10.0.0.1/',
  ]) {
    const r = await post({ url });
    assert.equal(r.status, 400, url);
    assert.match((await r.json()).error, /blocked|standard web ports/, url);
  }
});

test('rejects bad links, folders and focus with clear errors', async () => {
  const cases = [
    [{ url: 'ftp://example.com/' }, 400, /http and https/],
    [{ url: 'nonsense' }, 400, /not a valid link/],
    [{ url: 'https://u:p@example.com/' }, 400, /user name or password/],
    [{ url: 'https://example.com/', folder: '../etc' }, 400, /Invalid folder/],
    [{ url: 'https://example.com/', folder: '.trash' }, 400, /Invalid folder/],
    [{ url: 'https://example.com/', folder: 'nope' }, 404, /Folder not found/],
    [{ url: 'https://example.com/', focus: 'x'.repeat(301) }, 400, /300 characters/],
    [{ url: 'https://example.com/', focus: 42 }, 400, /Focus must be text/],
  ];
  for (const [body, status, re] of cases) {
    const r = await post(body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.match((await r.json()).error, re);
  }
});

test('streams progress and a clear error when the site cannot be reached', async () => {
  // .invalid never resolves (RFC 6761), so this fails at DNS without leaving the machine.
  const r = await post({ url: 'https://no-such-host.invalid/', folder: 'notes' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/x-ndjson/);
  const events = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events[0], { stage: 'fetching' });
  const last = events.at(-1);
  assert.equal(last.stage, 'error');
  assert.match(last.error, /Could not find that site|Could not reach the site/);
  // Nothing was saved.
  assert.deepEqual((await fs.readdir(path.join(dir, 'notes'))).filter((f) => !f.startsWith('.')), []);
});
