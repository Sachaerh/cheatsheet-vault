// Unit tests for the "Create from link" URL checks and the guarded fetch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { checkUrl, isBlockedIp, fetchPage, extractText, BLOCKED_MSG } from '../lib/fetch-page.js';

test('isBlockedIp blocks loopback, private, link-local, CGNAT/Tailscale and special ranges', () => {
  for (const ip of [
    '127.0.0.1', '127.255.255.254', '0.0.0.0', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255',
    '192.168.1.10', '192.168.0.1', '100.64.0.1', '100.101.102.103', '100.127.255.255', '169.254.169.254',
    '192.0.0.8', '198.18.0.1', '224.0.0.1', '239.255.255.250', '255.255.255.255', '240.0.0.1',
    '::', '::1', 'fd7a:115c:a1e0::1', 'fd00::1', 'fc00::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:192.168.1.10', '::ffff:100.101.102.103', '::127.0.0.1',
    '64:ff9b::a00:1', '64:ff9b::192.168.1.1', '2002:c0a8:01b3::1', '2001:db8::1',
    'not-an-ip', '',
  ]) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
});

test('isBlockedIp allows public addresses just outside the blocked ranges', () => {
  for (const ip of [
    '8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '11.0.0.1',
    '192.169.0.1', '2606:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8', '64:ff9b::808:808',
  ]) {
    assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`);
  }
});

test('checkUrl accepts normal public links', () => {
  assert.equal(checkUrl('https://example.com/docs#part').href, 'https://example.com/docs');
  assert.equal(checkUrl('  http://example.com  ').hostname, 'example.com');
  assert.equal(checkUrl('https://example.com:443/x').href, 'https://example.com/x');
});

test('checkUrl rejects other schemes, credentials, odd ports and junk', () => {
  const bad = (u, re) => assert.throws(() => checkUrl(u), (e) => e.status === 400 && re.test(e.message), u);
  bad('ftp://example.com/', /http and https/);
  bad('file:///etc/passwd', /http and https/);
  bad('javascript:alert(1)', /http and https/);
  bad('data:text/html,hi', /http and https/);
  bad('gopher://example.com/', /http and https/);
  bad('https://user:pw@example.com/', /user name or password/);
  bad('https://user@example.com/', /user name or password/);
  bad('https://example.com:8443/', /standard web ports/);
  bad('http://example.com:22/', /standard web ports/);
  bad('not a url', /not a valid link/);
  bad('', /not a valid link/);
  bad(undefined, /not a valid link/);
});

test('checkUrl blocks local names and IP literals in every spelling', () => {
  for (const u of [
    'http://localhost/', 'http://LOCALHOST./', 'http://foo.localhost/', 'http://nas.local/', 'http://router/',
    'http://nas.tail0000.ts.net/', 'http://metadata.google.internal/',
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/',
    'http://0/', 'http://10.0.0.1/', 'http://192.168.1.10/', 'http://100.101.102.103/', 'http://169.254.169.254/latest/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fd7a:115c:a1e0::1]/', 'http://[fe80::1]/',
  ]) {
    assert.throws(() => checkUrl(u), (e) => e.status === 400 && e.message === BLOCKED_MSG, u);
  }
});

test('extractText drops scripts, styles and navigation and keeps code blocks', () => {
  const { title, text } = extractText(`<!doctype html><html><head><title>Vim &amp; Tips</title>
    <style>body{color:red}</style><script>alert("x")</script></head><body>
    <nav><a href="/">Home</a> Menu stuff</nav>
    <h1>Moving</h1><p>Use <kbd>w</kbd> to jump &lt;words&gt;.</p>
    <ul><li>one</li><li>two</li></ul>
    <pre><code class="language-sh">git log --oneline
git rebase -i HEAD~3</code></pre>
    <footer>Copyright</footer><svg><text>svgtext</text></svg></body></html>`);
  assert.equal(title, 'Vim & Tips');
  assert.match(text, /^# Moving/m);
  assert.match(text, /Use `w` to jump <words>\./);
  assert.match(text, /^- one$/m);
  assert.match(text, /```\ngit log --oneline\ngit rebase -i HEAD~3\n```/);
  for (const gone of ['alert', 'color:red', 'Menu stuff', 'Copyright', 'svgtext']) assert.ok(!text.includes(gone), gone);
});

// ---- fetchPage against a local server ----
// The server listens on 127.0.0.1, which the real policy blocks. Tests resolve
// the made-up name "public.test" to it and let only that name through.
let server;
let PORT;
const routes = new Map();
before(async () => {
  server = http.createServer((req, res) => {
    const h = routes.get(new URL(req.url, 'http://x').pathname);
    if (h) return h(req, res);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const testOpts = (extra = {}) => ({
  ports: [PORT, 80, 443],
  resolve: async (host) => {
    if (host === 'public.test') return [{ address: '127.0.0.1', family: 4 }];
    if (host === 'mixed.test') return [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.10', family: 4 }];
    if (host === 'private.test') return [{ address: '10.1.2.3', family: 4 }];
    if (host === 'tailnet.test') return [{ address: '100.101.102.103', family: 4 }];
    if (host === 'v6local.test') return [{ address: '::1', family: 6 }];
    throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  },
  // Real policy for everything except the test server's name.
  isBlocked: (ip, host) => (host === 'public.test' ? false : isBlockedIp(ip)),
  ...extra,
});
const at = (p) => `http://public.test:${PORT}${p}`;
const html = (body) => (req, res) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
const rejects = (p, opts, status, re) =>
  assert.rejects(fetchPage(p, testOpts(opts)), (e) => e.status === status && re.test(e.message), `${p}: expected ${status} ${re}`);

test('fetchPage returns title and text of a page', async () => {
  routes.set('/ok', html('<html><head><title>Hello</title></head><body><h2>Keys</h2><p>Press <kbd>q</kbd></p></body></html>'));
  const r = await fetchPage(at('/ok'), testOpts());
  assert.equal(r.title, 'Hello');
  assert.match(r.text, /## Keys\n+Press `q`/);
  assert.equal(r.url, at('/ok'));
  assert.equal(r.finalUrl, at('/ok'));
});

test('fetchPage follows a safe redirect and reports the final URL', async () => {
  routes.set('/hop', (req, res) => res.writeHead(302, { Location: '/ok' }).end());
  const r = await fetchPage(at('/hop'), testOpts());
  assert.equal(r.finalUrl, at('/ok'));
});

test('fetchPage refuses redirects to private, loopback and tailnet addresses', async () => {
  for (const target of [
    'http://127.0.0.1/', `http://127.0.0.1:${PORT}/ok`, 'http://10.0.0.1/', 'http://192.168.1.10/',
    'http://100.101.102.103/', 'http://[::1]/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/',
    'http://private.test/', 'http://tailnet.test/', 'http://v6local.test/',
  ]) {
    routes.set('/evil', (req, res) => res.writeHead(301, { Location: target }).end());
    await rejects(at('/evil'), {}, 400, /blocked/);
  }
});

test('fetchPage refuses redirects to other schemes and ports', async () => {
  routes.set('/scheme', (req, res) => res.writeHead(302, { Location: 'file:///etc/passwd' }).end());
  await rejects(at('/scheme'), {}, 400, /http and https/);
  routes.set('/port', (req, res) => res.writeHead(302, { Location: 'http://public.test:22/' }).end());
  await rejects(at('/port'), {}, 400, /standard web ports/);
});

test('fetchPage stops after too many redirects', async () => {
  routes.set('/loop', (req, res) => res.writeHead(302, { Location: '/loop' }).end());
  await rejects(at('/loop'), {}, 508, /Too many redirects/);
});

test('fetchPage refuses a name that resolves to any private address (DNS)', async () => {
  await rejects('http://mixed.test/', {}, 400, /blocked/);
  await rejects('http://private.test/', {}, 400, /blocked/);
  await rejects('http://tailnet.test/', {}, 400, /blocked/);
  await rejects('http://v6local.test/', {}, 400, /blocked/);
});

test('fetchPage with the default policy refuses the local server outright', async () => {
  await assert.rejects(fetchPage(`http://127.0.0.1:${PORT}/ok`, { ports: [PORT] }), (e) => e.status === 400 && e.message === BLOCKED_MSG);
});

test('fetchPage enforces the size limit with and without Content-Length', async () => {
  const big = 'x'.repeat(5000);
  routes.set('/big-cl', (req, res) => res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': big.length }).end(big));
  await rejects(at('/big-cl'), { maxBytes: 1000 }, 413, /larger than/);
  routes.set('/big-chunked', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    for (let i = 0; i < 10; i++) res.write(big);
    res.end();
  });
  await rejects(at('/big-chunked'), { maxBytes: 1000 }, 413, /larger than/);
  // A small gzip body that inflates past the limit (compression bomb).
  const bomb = zlib.gzipSync(Buffer.alloc(200_000, 'a'));
  routes.set('/bomb', (req, res) => res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' }).end(bomb));
  await rejects(at('/bomb'), { maxBytes: 50_000 }, 413, /larger than/);
});

test('fetchPage refuses pages whose text is too long to summarize', async () => {
  routes.set('/long', html(`<p>${'word '.repeat(3000)}</p>`));
  await rejects(at('/long'), { maxChars: 1000 }, 413, /too long to summarize/);
});

test('fetchPage times out on a slow server', async () => {
  routes.set('/slow', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.write('<p>start');
    // never ends
  });
  await rejects(at('/slow'), { timeoutMs: 300 }, 504, /took too long/);
});

test('fetchPage refuses non-HTML content types and empty pages', async () => {
  routes.set('/pdf', (req, res) => res.writeHead(200, { 'Content-Type': 'application/pdf' }).end('%PDF-1.4'));
  await rejects(at('/pdf'), {}, 415, /Not a web page/);
  routes.set('/img', (req, res) => res.writeHead(200, { 'Content-Type': 'image/png' }).end('x'));
  await rejects(at('/img'), {}, 415, /Not a web page/);
  routes.set('/empty', html('<script>render()</script>'));
  await rejects(at('/empty'), {}, 422, /no readable text/);
  await rejects(at('/missing'), {}, 502, /HTTP 404/);
});

test('fetchPage decodes gzip and the declared charset', async () => {
  routes.set('/gz', (req, res) =>
    res.writeHead(200, { 'Content-Type': 'text/html; charset=iso-8859-1', 'Content-Encoding': 'gzip' })
      .end(zlib.gzipSync(Buffer.from('<p>caf\xe9</p>', 'latin1'))));
  const r = await fetchPage(at('/gz'), testOpts());
  assert.equal(r.text, 'café');
});

test('fetchPage can be cancelled', async () => {
  routes.set('/hang', () => {});
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  await rejects(at('/hang'), { signal: ac.signal }, 499, /Cancelled/);
});
