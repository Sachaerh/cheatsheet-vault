import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, HttpError, TEXT_TYPES, typeOf, cleanName, detectKind, extractTitle, folderPath } from './lib/store.js';
import { checkUrl, fetchPage } from './lib/fetch-page.js';
import { summarize, isConfigured, MAX_FOCUS } from './lib/summarize.js';
import { renderMarkdown, renderText, search, strip, escapeHtml } from './lib/render.js';
import { kiwixBase, kiwixPort, searchLibrary } from './lib/kiwix.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const SHEETS_DIR = path.resolve(process.env.SHEETS_DIR || path.join(HERE, 'data'));
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 25;
// Optional offline library (kiwix-serve). KIWIX_URL is how this server reaches it;
// browsers link to the same host they use for the vault, on KIWIX_URL's port, or on
// KIWIX_HTTPS_PORT when the vault itself is opened over HTTPS.
const KIWIX_URL = kiwixBase(process.env.KIWIX_URL);
const KIWIX_HTTPS_PORT = Number(process.env.KIWIX_HTTPS_PORT) || null;
const LIBRARY = KIWIX_URL ? { port: kiwixPort(KIWIX_URL), httpsPort: KIWIX_HTTPS_PORT } : null;
const VERSION = JSON.parse(await fs.readFile(path.join(HERE, 'package.json'), 'utf8')).version;

const store = new Store(SHEETS_DIR);
await store.init();
await seed();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

// Unauthenticated health check for the container healthcheck.
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// ---- optional HTTP basic auth ----
if (AUTH_USER && AUTH_PASS) {
  const want = crypto.createHash('sha256').update(`${AUTH_USER}:${AUTH_PASS}`).digest();
  app.use((req, res, next) => {
    const m = /^Basic\s+(\S+)$/i.exec(req.get('authorization') || '');
    const got = crypto
      .createHash('sha256')
      .update(m ? Buffer.from(m[1], 'base64').toString('utf8') : '')
      .digest();
    if (m && crypto.timingSafeEqual(want, got)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Cheatsheet Vault", charset="UTF-8"');
    res.status(401).type('text').send('Authentication required');
  });
} else {
  console.warn('AUTH_USER/AUTH_PASS not set: running without authentication');
}

// ---- security headers for the app's own pages ----
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

function appHeaders(res) {
  res.set({
    'Content-Security-Policy': APP_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'SAMEORIGIN',
  });
}

app.use('/static', (req, res, next) => {
  appHeaders(res);
  next();
});
// Revalidate every time (cheap 304s) so a browser never mixes old and new modules after an update.
app.use('/static', express.static(path.join(HERE, 'public'), { maxAge: 0, index: false }));

// ---- API guard: same-origin requests from the app's own JS only ----
// Requires a custom header (forces a CORS preflight that we never answer) and
// rejects foreign or "null" origins, so sandboxed HTML sheets can't use the API.
app.use('/api', (req, res, next) => {
  appHeaders(res);
  res.set('Cache-Control', 'no-store');
  if (req.get('x-vault') !== '1') return res.status(403).json({ error: 'Missing X-Vault header' });
  const origin = req.get('origin');
  if (origin) {
    let host = null;
    try {
      host = new URL(origin).host;
    } catch {}
    if (!host || host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin request refused' });
  }
  next();
});
app.use('/api', express.json({ limit: `${MAX_UPLOAD_MB}mb` }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/sheets', wrap(async (req, res) => {
  const list = (await store.list()).map(strip);
  res.json({ sheets: list, folders: await store.folders(), stars: await store.stars(), version: VERSION, fromLink: isConfigured(), library: LIBRARY });
}));

app.get('/api/search', wrap(async (req, res) => {
  res.json({ results: search(await store.list(), req.query.q) });
}));

// Articles from the offline library. Always 200 when configured: { available: false } means
// Kiwix is down or slow, so the page shows that in its own section and sheet search is unaffected.
app.get('/api/library-search', wrap(async (req, res) => {
  if (!KIWIX_URL) throw new HttpError(404, 'The offline library is not set up');
  res.json(await searchLibrary(KIWIX_URL, req.query.q));
}));

app.get('/api/sheet', wrap(async (req, res) => {
  const entry = await store.get(String(req.query.path || ''));
  const out = strip(entry);
  if (TEXT_TYPES.has(entry.type)) {
    out.content = await fs.readFile(await store.resolveExisting(entry.path), 'utf8');
  }
  res.json(out);
}));

// Create from pasted content. kind: auto | markdown | html | text
app.post('/api/sheets', wrap(async (req, res) => {
  const { content, title, category, kind = 'auto' } = req.body || {};
  if (typeof content !== 'string' || !content.trim()) throw new HttpError(400, 'Content is empty');
  const k = kind === 'auto' ? detectKind(content) : kind;
  const ext = { markdown: 'md', html: 'html', text: 'txt' }[k];
  if (!ext) throw new HttpError(400, 'Unknown kind');
  let body = content;
  let name = cleanName(title);
  if (!name) {
    name = cleanName(extractTitle(k, content, `Untitled.${ext}`)) || 'Untitled';
  } else if (k === 'markdown' && !/^\s*#[ \t]/.test(content)) {
    // Give the sheet the requested title as its heading.
    body = `# ${title.trim()}\n\n${content}`;
  }
  const rel = await store.create({ category, name, ext, data: body });
  res.status(201).json({ path: rel });
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 50 },
});
app.post('/api/upload', upload.array('files', 50), wrap(async (req, res) => {
  const created = [];
  const skipped = [];
  for (const f of req.files || []) {
    // multer decodes file names as latin1; browsers send UTF-8.
    const original = Buffer.from(f.originalname, 'latin1').toString('utf8');
    const type = typeOf(original);
    if (!type) {
      skipped.push({ name: original, reason: 'unsupported type' });
      continue;
    }
    if (type === 'pdf' && f.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      skipped.push({ name: original, reason: 'not a PDF' });
      continue;
    }
    const ext = path.extname(original).slice(1).toLowerCase();
    const rel = await store.create({
      category: req.body.category,
      name: path.basename(original, path.extname(original)),
      ext,
      data: f.buffer,
    });
    created.push(rel);
  }
  res.status(created.length ? 201 : 400).json({ created, skipped });
}));

app.put('/api/sheet', wrap(async (req, res) => {
  const { path: rel, content } = req.body || {};
  if (typeof content !== 'string') throw new HttpError(400, 'Content is required');
  res.json({ path: await store.write(String(rel || ''), content) });
}));

app.post('/api/move', wrap(async (req, res) => {
  const { path: rel, name, category } = req.body || {};
  res.json({ path: await store.move(String(rel || ''), { name, category }) });
}));

app.delete('/api/sheet', wrap(async (req, res) => {
  await store.remove(String(req.query.path || ''));
  res.json({ ok: true });
}));

// Move several sheets into an existing folder ('' = top level).
app.post('/api/move-many', wrap(async (req, res) => {
  const { paths, folder } = req.body || {};
  res.json(await store.moveMany(paths, folder));
}));

// ---- folders ----
app.post('/api/folders', wrap(async (req, res) => {
  res.status(201).json({ path: await store.createFolder((req.body || {}).path) });
}));

// Rename (name) and/or move (to = new parent folder, '' = top level).
app.post('/api/folders/move', wrap(async (req, res) => {
  const { path: rel, to, name } = req.body || {};
  res.json({ path: await store.moveFolder(rel, { to, name }) });
}));

app.delete('/api/folders', wrap(async (req, res) => {
  res.json(await store.removeFolder(req.query.path));
}));

// ---- stars ----
app.get('/api/stars', wrap(async (req, res) => {
  res.json({ stars: await store.stars() });
}));

app.put('/api/stars', wrap(async (req, res) => {
  res.json({ stars: await store.setStars(req.body || {}) });
}));

// ---- create from link ----
// Streams NDJSON progress: fetching -> reading -> writing -> done | error.
// Input errors (bad link, blocked IP literal, bad folder) are plain JSON 4xx.
let linkBusy = false;
app.post('/api/from-link', wrap(async (req, res) => {
  const { url, folder, focus } = req.body || {};
  if (!isConfigured()) throw new HttpError(503, 'Create from link is not set up: add ANTHROPIC_API_KEY to the secrets env file');
  const checked = checkUrl(url);
  const dir = folderPath(folder ?? '');
  await store.folderDir(dir); // 404 if the folder doesn't exist
  if (focus != null && typeof focus !== 'string') throw new HttpError(400, 'Focus must be text');
  if (String(focus || '').length > MAX_FOCUS) throw new HttpError(400, `Focus is limited to ${MAX_FOCUS} characters`);
  if (linkBusy) throw new HttpError(429, 'Another sheet is being created from a link; try again when it finishes');
  linkBusy = true;

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ac.abort();
  });
  res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (o) => {
    if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(o) + '\n');
  };
  try {
    send({ stage: 'fetching' });
    const page = await fetchPage(checked.href, { signal: ac.signal });
    send({ stage: 'reading', chars: page.text.length, title: page.title });
    const md = await summarize({
      ...page,
      focus,
      signal: ac.signal,
      onProgress: ({ chars }) => send({ stage: 'writing', chars }),
    });
    const name = extractTitle('markdown', md, 'Untitled.md');
    const rel = await store.create({ category: dir, name, ext: 'md', data: md });
    send({ stage: 'done', path: rel });
  } catch (err) {
    const status = err.status || 500;
    // One line, fixed messages only: never the request, the page or the SDK error object.
    console.warn(`from-link: ${status} ${err instanceof HttpError ? err.message : 'unexpected error'}`);
    if (!(err instanceof HttpError)) console.error(err);
    send({ stage: 'error', status, error: err instanceof HttpError ? err.message : 'Server error' });
  } finally {
    linkBusy = false;
    res.end();
  }
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---- raw files ----
const relFromSplat = (splat) => (Array.isArray(splat) ? splat.join('/') : String(splat || ''));

app.get('/raw/*splat', wrap(async (req, res) => {
  const abs = await store.resolveExisting(relFromSplat(req.params.splat));
  const type = typeOf(abs);
  const name = path.basename(abs);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'no-cache');
  if (req.query.download) {
    res.attachment(name);
  } else {
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  if (type === 'html') {
    // The sheet's own scripts may run, but in an opaque origin: no cookies,
    // no access to the app's DOM or (via the API guard) its API.
    res.set('Content-Security-Policy', "sandbox allow-scripts; frame-ancestors 'self'");
    res.type('html');
  } else if (type === 'pdf') {
    res.set('Content-Security-Policy', "frame-ancestors 'self'");
    res.type('application/pdf');
  } else {
    res.set('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'self'");
    res.type('text/plain; charset=utf-8');
  }
  res.send(await fs.readFile(abs));
}));

// ---- pages ----
function page({ title, bodyClass, body, head = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/style.css?v=${VERSION}">
<script src="/static/theme.js?v=${VERSION}"></script>
${head}
</head>
<body class="${bodyClass}">
${body}
</body>
</html>`;
}

app.get('/', wrap(async (req, res) => {
  appHeaders(res);
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(HERE, 'public', 'index.html'));
}));

app.get('/view/*splat', wrap(async (req, res) => {
  const rel = relFromSplat(req.params.splat);
  const entry = await store.get(rel);
  const abs = await store.resolveExisting(entry.path);
  const rawUrl = '/raw/' + entry.path.split('/').map(encodeURIComponent).join('/');
  let main;
  let toc = [];
  if (entry.type === 'markdown') {
    const r = renderMarkdown(await fs.readFile(abs, 'utf8'));
    toc = r.toc.filter((h, i) => !(i === 0 && h.depth === 1) && h.depth <= 3);
    main = `<article class="sheet md">${r.html}</article>`;
  } else if (entry.type === 'text') {
    main = `<article class="sheet txt">${renderText(await fs.readFile(abs, 'utf8'))}</article>`;
  } else if (entry.type === 'html') {
    main = `<iframe class="sheet-frame" sandbox="allow-scripts" src="${rawUrl}" title="${escapeHtml(entry.title)}" referrerpolicy="no-referrer"></iframe>`;
  } else {
    main = `<iframe class="sheet-frame pdf" src="${rawUrl}" title="${escapeHtml(entry.title)}"></iframe>`;
  }
  const tocHtml = toc.length > 2
    ? `<nav class="toc" aria-label="Contents"><div class="toc-title">Contents</div><ul>${toc
        .map((h) => `<li class="d${h.depth}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
        .join('')}</ul></nav>`
    : '';
  const meta = JSON.stringify({ ...strip(entry), rawUrl }).replace(/</g, '\\u003c');
  const crumbs = entry.category
    ? entry.category.split('/').map((c, i, a) =>
        `<a href="/#cat=${encodeURIComponent(a.slice(0, i + 1).join('/'))}">${escapeHtml(c)}</a>`
      ).join('<span class="sep">/</span>')
    : '<a href="/">All</a>';

  appHeaders(res);
  res.set('Cache-Control', 'no-cache');
  res.send(page({
    title: `${entry.title} · Cheatsheet Vault`,
    bodyClass: `viewer kind-${entry.type}${tocHtml ? ' has-toc' : ''}`,
    head: `<script type="application/json" id="sheet-meta">${meta}</script>
<link rel="stylesheet" href="/static/hljs-theme.css?v=${VERSION}">
<script type="module" src="/static/viewer.js?v=${VERSION}"></script>`,
    body: `<header class="topbar">
  <a class="icon-btn back" href="/" title="Back to library" aria-label="Back to library">←</a>
  <div class="titles">
    <h1 class="sheet-title">${escapeHtml(entry.title)}</h1>
    <div class="crumbs">${crumbs}<span class="sep">·</span><span class="badge">${escapeHtml(entry.ext)}</span></div>
  </div>
  <div class="actions">
    <button class="icon-btn star" data-action="star" title="Star" aria-label="Star">☆</button>
    ${TEXT_TYPES.has(entry.type) ? '<button class="btn" data-action="edit">Edit</button>' : ''}
    <button class="btn" data-action="move">Rename / move</button>
    <details class="menu">
      <summary class="icon-btn" title="More" aria-label="More actions">⋯</summary>
      <div class="menu-items">
        ${entry.type === 'markdown' || entry.type === 'text' ? '<button data-action="print">Print</button>' : ''}
        <a href="${rawUrl}" target="_blank" rel="noopener">Open raw</a>
        <a href="${rawUrl}?download=1">Download</a>
        <button data-action="delete" class="danger">Delete</button>
      </div>
    </details>
    <button class="icon-btn theme-toggle" data-action="theme" title="Toggle dark mode" aria-label="Toggle dark mode">◐</button>
  </div>
</header>
<div class="viewer-body">
  ${tocHtml}
  <main>${main}</main>
</div>`,
  }));
}));

// ---- errors ----
app.use((err, req, res, next) => {
  let status = err.status || err.statusCode || 500;
  let msg = err.message || 'Server error';
  if (err instanceof multer.MulterError) {
    status = 413;
    msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${MAX_UPLOAD_MB} MB` : err.message;
  } else if (err.type === 'entity.too.large') {
    msg = 'Content is too large';
  }
  if (status >= 500 && !(err instanceof HttpError)) console.error(err);
  if (req.path.startsWith('/api')) return res.status(status).json({ error: msg });
  appHeaders(res);
  res.status(status).send(page({
    title: 'Cheatsheet Vault',
    bodyClass: 'error-page',
    body: `<main class="error-box"><h1>${status}</h1><p>${escapeHtml(msg)}</p><p><a href="/">Back to the library</a></p></main>`,
  }));
});

app.listen(PORT, () => {
  console.log(`Cheatsheet Vault ${VERSION} on :${PORT}, sheets in ${SHEETS_DIR}, auth ${AUTH_USER ? 'on' : 'off'}, offline library ${KIWIX_URL ? 'on' : 'off'}`);
});

async function seed() {
  if (!(await store.isEmpty())) return;
  const welcome = `# Getting Started

Welcome to **Cheatsheet Vault**, a searchable home for your cheat sheets.

## Adding sheets

- **Paste**: click **New sheet**, paste Markdown or HTML, and save. The type is detected automatically.
- **Upload**: click **Upload** and pick one or more \`.md\`, \`.html\`, \`.pdf\` or \`.txt\` files.
- **Drag and drop**: drop files anywhere on the library page.
- **From link**: paste a web page link and Claude writes a short cheat sheet from it (shown only when an API key is set up).

## Organizing

Folders are real folders on disk. Use **New folder**, then open a folder to add sheets to it.
Move sheets by dragging a card onto a folder in the sidebar, or tick several cards and choose **Move to…**.
Right-click a folder (or use its ⋯ button) to rename, move or delete it.
Star sheets you use often; stars are shared by all your devices and follow a sheet when it moves.

## Searching

The search box looks through the full text of every sheet. Use quotes for a phrase:

\`\`\`text
"git rebase" interactive
\`\`\`

## Where the files live

Every sheet is a plain file in the sheets folder, so backups and snapshots cover them.
Deleted sheets are moved to the hidden \`.trash\` folder there.

You can delete this sheet once you have added your own.
`;
  await store.create({ category: '', name: 'Getting Started', ext: 'md', data: welcome });
  console.log('Seeded Getting Started sheet');
}
