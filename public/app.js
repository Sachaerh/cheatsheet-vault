import { api, $, $$, esc, viewUrl, stars, prefs, toggleTheme, toast, dialog } from './common.js';

const state = {
  sheets: [],
  folders: [], // every folder path, including empty ones
  results: null, // search results, or null when not searching
  cat: '', // '' = top level, '*' = starred, otherwise a folder path
  q: '',
  sort: prefs.load('cv-sort', 'recent'),
  open: new Set(prefs.load('cv-open', [])), // expanded folders in the sidebar
  selected: new Set(), // selected sheet paths
  library: null, // offline library (Kiwix) ports, or null when not set up
  lib: null, // offline library results: null, { loading }, or { available, results }
};
const total = new Map(); // folder -> sheets inside it, including subfolders

const KIND_LABEL = { markdown: 'MD', html: 'HTML', pdf: 'PDF', text: 'TXT' };
const DRAG_TYPE = 'application/x-vault-sheets';
const FOLDER_ICON = '<svg class="ficon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4.2l2 2.2h6.8A2.5 2.5 0 0 1 21 8.7v8.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>';

// ---- folder path helpers ----
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const join = (parent, name) => (parent ? `${parent}/${name}` : name);
const isInside = (p, folder) => p === folder || p.startsWith(folder + '/');
const remap = (p, from, to) => (isInside(p, from) ? to + p.slice(from.length) : p);
const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
const isFolderView = () => state.cat !== '*';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function childrenOf(parent) {
  return state.folders.filter((f) => parentOf(f) === parent).sort((a, b) => byName(nameOf(a), nameOf(b)));
}

// ---- data ----
async function refresh() {
  try {
    const data = await api('GET', '/api/sheets');
    state.sheets = data.sheets;
    $('#linkBtn').hidden = !data.fromLink;
    state.library = data.library || null;
    // Folders from the directory walk, plus any implied by a sheet's path.
    const set = new Set(data.folders);
    total.clear();
    for (const s of state.sheets) {
      if (!s.category) continue;
      const parts = s.category.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const k = parts.slice(0, i).join('/');
        set.add(k);
        total.set(k, (total.get(k) || 0) + 1);
      }
    }
    state.folders = [...set].sort(byName);
    await stars.load(data.stars);
    const paths = new Set(state.sheets.map((s) => s.path));
    for (const p of state.selected) if (!paths.has(p)) state.selected.delete(p);
    if (state.cat && state.cat !== '*' && !set.has(state.cat)) state.cat = '';
    if (state.q) await runSearch();
    render();
  } catch (e) {
    toast(e.message, 'error');
  }
}

let searchSeq = 0;
async function runSearch() {
  const seq = ++searchSeq;
  if (!state.q.trim()) {
    state.results = null;
    state.lib = null;
    return;
  }
  // The offline library is searched in parallel and renders on its own, so sheets never wait for Kiwix.
  if (state.library) searchLibrary(seq, state.q);
  const { results } = await api('GET', '/api/search?q=' + encodeURIComponent(state.q));
  if (seq === searchSeq) state.results = results;
}

async function searchLibrary(seq, q) {
  state.lib = { loading: true };
  renderLibrary();
  let lib;
  try {
    lib = await api('GET', '/api/library-search?q=' + encodeURIComponent(q));
  } catch {
    lib = { available: false, results: [] };
  }
  if (seq !== searchSeq) return;
  state.lib = lib;
  renderLibrary();
}

// Kiwix is a separate site on the same host: its own port, or its HTTPS port when the vault is on HTTPS.
function libraryUrl(p = '/') {
  const { port, httpsPort } = state.library;
  const https = location.protocol === 'https:' && httpsPort;
  return `${https ? 'https' : 'http'}://${location.hostname}:${https ? httpsPort : port}${p}`;
}

// ---- sidebar tree ----
function treeRow(f, depth) {
  const kids = childrenOf(f);
  const open = state.open.has(f);
  const name = esc(nameOf(f));
  let html = `<div class="tree-row${state.cat === f ? ' active' : ''}" data-folder="${esc(f)}" data-drop="${esc(f)}" style="--depth:${depth}">
    ${kids.length
      ? `<button class="twisty" data-toggle="${esc(f)}" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${name}">${open ? '▾' : '▸'}</button>`
      : '<span class="twisty"></span>'}
    <a href="#" class="cat" data-cat="${esc(f)}"${state.cat === f ? ' aria-current="page"' : ''}><span class="label">${name}</span><span class="n">${total.get(f) || 0}</span></a>
    <button class="more" data-menu="${esc(f)}" aria-haspopup="menu" aria-label="Actions for ${name}" title="Folder actions">⋯</button>
  </div>`;
  if (open) for (const k of kids) html += treeRow(k, depth + 1);
  return html;
}

function renderTree() {
  const starred = state.sheets.filter((s) => stars.has(s.path)).length;
  let html = `<div class="tree-row top${state.cat === '' ? ' active' : ''}" data-folder="" data-drop="">
      <a href="#" class="cat" data-cat=""><span class="label">All</span><span class="n">${state.sheets.length}</span></a>
      <button class="more" data-menu="" aria-haspopup="menu" aria-label="Top-level actions" title="New folder">⋯</button>
    </div>
    <div class="tree-row top${state.cat === '*' ? ' active' : ''}">
      <a href="#" class="cat" data-cat="*"><span class="label">★ Starred</span><span class="n">${starred}</span></a>
    </div>`;
  if (state.library) {
    html += `<div class="tree-row top">
      <a href="${esc(libraryUrl())}" class="cat" id="libLink" target="_blank" rel="noopener"><span class="label">Offline library</span><span class="n" aria-hidden="true">↗</span></a>
    </div>`;
  }
  html += '<div class="cat-head">Folders</div>';
  const top = childrenOf('');
  html += top.length ? top.map((f) => treeRow(f, 0)).join('') : '<p class="tree-empty">No folders yet.</p>';
  $('#cats').innerHTML = html;
}

// ---- main area ----
function sorted(list) {
  const out = [...list];
  if (state.sort === 'az') out.sort((a, b) => byName(a.title, b.title));
  else out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function fmtDate(ms) {
  const d = new Date(ms);
  const days = (Date.now() - ms) / 864e5;
  if (days < 1 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined });
}

function card(s, showFolder) {
  const starred = stars.has(s.path);
  const picked = state.selected.has(s.path);
  const body = s.snippets
    ? s.snippets.length
      ? `<ul class="snippets">${s.snippets.map((x) => `<li>${x}</li>`).join('')}</ul>`
      : `<p class="excerpt">${esc(s.excerpt)}</p>`
    : `<p class="excerpt">${esc(s.excerpt) || '<span class="muted">No preview</span>'}</p>`;
  return `<article class="card kind-${s.type}${picked ? ' selected' : ''}" draggable="true" data-path="${esc(s.path)}">
    <div class="card-top">
      <input type="checkbox" class="pick" data-pick="${esc(s.path)}"${picked ? ' checked' : ''} aria-label="Select ${esc(s.title)}">
      <span class="badge k-${s.type}">${KIND_LABEL[s.type]}</span>
      ${showFolder && s.category ? `<span class="card-cat">${esc(s.category)}</span>` : ''}
      <button class="star-btn${starred ? ' on' : ''}" data-star="${esc(s.path)}" aria-pressed="${starred}" title="${starred ? 'Unstar' : 'Star'}" aria-label="Star ${esc(s.title)}">${starred ? '★' : '☆'}</button>
    </div>
    <h3><a class="card-link" href="${viewUrl(s.path)}" draggable="false">${s.titleHtml || esc(s.title)}</a></h3>
    ${body}
    <div class="card-foot">${fmtDate(s.mtime)}</div>
  </article>`;
}

function tile(f) {
  const n = total.get(f) || 0;
  const subs = childrenOf(f).length;
  return `<div class="folder-tile" data-folder="${esc(f)}" data-drop="${esc(f)}">
    <a href="#" class="tile-link" data-cat="${esc(f)}">${FOLDER_ICON}<span class="fname">${esc(nameOf(f))}</span></a>
    <span class="fmeta">${plural(n, 'sheet')}${subs ? ` · ${plural(subs, 'folder')}` : ''}</span>
    <button class="more" data-menu="${esc(f)}" aria-haspopup="menu" aria-label="Actions for ${esc(nameOf(f))}" title="Folder actions">⋯</button>
  </div>`;
}

function crumbs() {
  let html = `<a href="#" data-cat="" data-drop="">All</a>`;
  if (!state.cat) return `<span aria-current="page">All</span>`;
  const parts = state.cat.split('/');
  parts.forEach((p, i) => {
    const f = parts.slice(0, i + 1).join('/');
    html += '<span class="sep" aria-hidden="true">›</span>';
    html += i === parts.length - 1 ? `<span aria-current="page">${esc(p)}</span>` : `<a href="#" data-cat="${esc(f)}" data-drop="${esc(f)}">${esc(p)}</a>`;
  });
  return html;
}

function render() {
  renderTree();
  const searching = state.results !== null;
  let list, tiles = [];
  if (searching) list = state.results; // search always covers every folder
  else if (state.cat === '*') list = sorted(state.sheets.filter((s) => stars.has(s.path)));
  else {
    list = sorted(state.sheets.filter((s) => s.category === state.cat));
    tiles = childrenOf(state.cat);
  }
  $('#folders').innerHTML = tiles.map(tile).join('');
  $('#folders').hidden = !tiles.length;
  $('#grid').innerHTML = list.map((s) => card(s, searching || state.cat === '*')).join('');

  const heading = $('#heading');
  if (searching) heading.textContent = `Results for “${state.q.trim()}”`;
  else if (state.cat === '*') heading.textContent = 'Starred';
  else heading.innerHTML = `<span class="crumbs">${crumbs()}</span>`;
  $('#count').textContent = plural(list.length, 'sheet');
  $('#sort').closest('.sort').hidden = searching;
  $('#newFolderBtn').hidden = searching || !isFolderView();

  const empty = $('#empty');
  empty.hidden = list.length > 0 || tiles.length > 0;
  if (!empty.hidden) {
    empty.textContent = searching
      ? 'No sheets match that search.'
      : state.cat === '*'
        ? 'No starred sheets yet. Click ☆ on a card to star it.'
        : state.cat
          ? 'This folder is empty. Add a sheet with “New sheet”, drop files on this page, or drag cards onto it.'
          : 'No sheets here yet. Paste one with “New sheet”, or drop files on this page.';
  }
  $('#dropTarget').textContent = uploadCategory() ? `into ${uploadCategory()}` : '';
  renderLibrary();
  renderSelection();
}

function renderLibrary() {
  const box = $('#library');
  const lib = state.results !== null && state.library ? state.lib : null;
  box.hidden = !lib;
  if (!lib) return;
  const list = $('#libList');
  if (lib.loading) {
    list.innerHTML = '<p class="lib-note">Searching the offline library…</p>';
  } else if (!lib.available) {
    list.innerHTML = '<p class="lib-note">The offline library isn’t responding right now.</p>';
  } else if (!lib.results.length) {
    list.innerHTML = '<p class="lib-note">No articles match that search.</p>';
  } else {
    list.innerHTML = `<ul class="lib-list">${lib.results
      .map(
        (r) => `<li class="lib-item">
        <a class="lib-link" href="${esc(libraryUrl(r.path))}" target="_blank" rel="noopener">${esc(r.title)}</a>
        ${r.book ? `<span class="lib-book">${esc(r.book)}</span>` : ''}
        ${r.snippet ? `<p class="lib-snippet">${esc(r.snippet)}</p>` : ''}
      </li>`,
      )
      .join('')}</ul>`;
    list.insertAdjacentHTML(
      'beforeend',
      `<p class="lib-more"><a href="${esc(libraryUrl('/search?pattern=' + encodeURIComponent(state.q.trim())))}" target="_blank" rel="noopener">All results in the offline library ↗</a></p>`,
    );
  }
}

function renderSelection() {
  const n = state.selected.size;
  $('#selbar').hidden = !n;
  document.body.classList.toggle('selecting', n > 0);
  $('#selCount').textContent = `${n} selected`;
}

// ---- URL hash keeps the folder and search linkable ----
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  state.cat = h.get('cat') || '';
  if (state.cat === '/') state.cat = ''; // old "Uncategorized" links
  state.q = h.get('q') || '';
  $('#q').value = state.q;
  openAncestors(state.cat);
}
function writeHash() {
  const h = new URLSearchParams();
  if (state.cat) h.set('cat', state.cat);
  if (state.q) h.set('q', state.q);
  const s = h.toString();
  history.replaceState(null, '', s ? '#' + s : location.pathname);
}

function openAncestors(f) {
  if (!f || f === '*') return;
  const parts = f.split('/');
  for (let i = 1; i < parts.length; i++) state.open.add(parts.slice(0, i).join('/'));
  prefs.save('cv-open', [...state.open]);
}

function go(cat) {
  state.cat = cat;
  // Opening a folder leaves search mode, since search covers everything.
  if (state.q) {
    state.q = '';
    state.results = null;
    $('#q').value = '';
  }
  openAncestors(cat);
  document.body.classList.remove('nav-open');
  writeHash();
  render();
}

// ---- adding sheets ----
function uploadCategory() {
  return isFolderView() ? state.cat : '';
}

async function newSheet() {
  const res = await dialog({
    title: 'New sheet',
    wide: true,
    submit: 'Save sheet',
    fields: [
      { name: 'content', label: 'Content', type: 'textarea', placeholder: 'Paste Markdown or HTML here…' },
      { name: 'title', label: 'Title (optional)', placeholder: 'Taken from the first heading or <title> if empty' },
      { name: 'category', label: 'Folder', value: uploadCategory(), placeholder: 'Empty = top level, e.g. code/python', list: state.folders },
      {
        name: 'kind',
        label: 'Format',
        type: 'select',
        value: 'auto',
        options: [['auto', 'Detect automatically'], ['markdown', 'Markdown'], ['html', 'HTML'], ['text', 'Plain text']],
      },
    ],
    onSubmit: (v) => api('POST', '/api/sheets', v),
  });
  if (res && res.path) location.href = viewUrl(res.path);
}

// ---- create from link ----
async function fromLink() {
  const res = await dialog({
    title: 'Create from link',
    submit: 'Create sheet',
    message: 'Claude reads the page and writes a short cheat sheet in its own words. The link is added at the bottom.',
    fields: [
      { name: 'url', label: 'Link', placeholder: 'https://…' },
      { name: 'folder', label: 'Folder', type: 'select', value: uploadCategory(), options: folderOptions() },
      { name: 'focus', label: 'Focus (optional)', placeholder: 'e.g. just the keyboard shortcuts' },
    ],
    onSubmit: runFromLink,
  });
  if (res && res.path) location.href = viewUrl(res.path);
}

const LINK_STEPS = [
  ['fetching', 'Fetching the page'],
  ['reading', 'Reading the page'],
  ['writing', 'Writing the cheat sheet'],
  ['done', 'Saving'],
];

async function runFromLink(values) {
  const d = $$('dialog.modal[open]').pop();
  const form = $('form', d);
  let box = $('.progress', d);
  if (!box) {
    box = document.createElement('ol');
    box.className = 'progress';
    box.setAttribute('aria-live', 'polite');
    form.insertBefore(box, $('.form-error', d));
  }
  box.innerHTML = LINK_STEPS.map(([k, label]) => `<li data-step="${k}"><span class="label">${esc(label)}</span> <span class="detail"></span></li>`).join('');
  box.hidden = true;
  const inputs = $$('input, select', form);
  inputs.forEach((i) => (i.disabled = true));
  const mark = (stage, detail) => {
    box.hidden = false;
    let seen = false;
    for (const li of $$('li', box)) {
      const here = li.dataset.step === stage;
      li.className = here ? 'active' : seen ? '' : 'done';
      if (here) {
        seen = true;
        if (detail != null) $('.detail', li).textContent = detail;
      }
    }
  };
  const ac = new AbortController();
  d.addEventListener('close', () => ac.abort(), { once: true }); // Cancel / Esc stops the job
  try {
    const res = await fetch('/api/from-link', {
      method: 'POST',
      headers: { 'X-Vault': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
      signal: ac.signal,
    });
    if (!(res.headers.get('content-type') || '').includes('ndjson')) {
      const data = await res.json().catch(() => null);
      throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.stage === 'error') {
          const li = $('li.active', box);
          if (li) li.className = 'failed';
          throw new Error(ev.error);
        }
        if (ev.stage === 'reading') mark('reading', `${ev.chars.toLocaleString()} characters`);
        else if (ev.stage === 'writing') mark('writing', `${ev.chars.toLocaleString()} characters so far`);
        else if (ev.stage === 'done') {
          mark('done');
          return { path: ev.path };
        } else mark(ev.stage);
      }
    }
    throw new Error('The connection closed before the sheet was saved');
  } catch (e) {
    inputs.forEach((i) => (i.disabled = false));
    if (e.name === 'AbortError') throw new Error('Cancelled');
    throw e;
  }
}

async function uploadFiles(files) {
  files = [...files];
  if (!files.length) return;
  const fd = new FormData();
  fd.append('category', uploadCategory());
  for (const f of files) fd.append('files', f, f.name);
  toast(`Uploading ${plural(files.length, 'file')}…`);
  try {
    const { created, skipped } = await api('POST', '/api/upload', fd);
    let msg = `Added ${plural(created.length, 'sheet')}`;
    if (skipped.length) msg += `; skipped ${skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}`;
    toast(msg, skipped.length ? 'error' : '');
  } catch (e) {
    toast(e.message, 'error');
  }
  refresh();
}

// ---- folder actions ----
const NAME_HINT = 'No slashes, and it can’t start with a dot.';

// Catch the common mistakes here with a clearer message; the server still checks everything.
function checkName(name) {
  const n = name.trim();
  if (!n) throw new Error('Enter a folder name.');
  if (/[\/\\]/.test(n)) throw new Error('A folder name can’t contain “/” or “\\”. Open the parent folder first to nest it.');
  if (n.startsWith('.')) throw new Error('A folder name can’t start with a dot.');
  return n;
}

// Options for a folder <select>: top level plus every folder, indented.
function folderOptions(exclude) {
  const opts = [['', 'Top level']];
  for (const f of state.folders) {
    if (exclude && isInside(f, exclude)) continue;
    const depth = f.split('/').length;
    opts.push([f, '   '.repeat(depth) + nameOf(f)]);
  }
  return opts;
}

async function newFolder(parent = uploadCategory()) {
  const res = await dialog({
    title: parent ? `New folder in ${nameOf(parent)}` : 'New folder',
    submit: 'Create',
    fields: [{ name: 'name', label: 'Folder name', hint: NAME_HINT }],
    onSubmit: (v) => api('POST', '/api/folders', { path: join(parent, checkName(v.name)) }),
  });
  if (!res) return;
  if (parent) state.open.add(parent);
  prefs.save('cv-open', [...state.open]);
  toast(`Created ${res.path}`);
  await refresh();
}

// Keep the current view, expanded folders and selection pointing at the right place after a move.
function followFolder(from, to) {
  state.cat = remap(state.cat, from, to);
  state.open = new Set([...state.open].map((f) => remap(f, from, to)));
  prefs.save('cv-open', [...state.open]);
  state.selected = new Set([...state.selected].map((p) => remap(p, from, to)));
  openAncestors(to);
  writeHash();
}

async function renameFolder(f) {
  const res = await dialog({
    title: 'Rename folder',
    submit: 'Rename',
    fields: [{ name: 'name', label: 'Folder name', value: nameOf(f), hint: NAME_HINT }],
    onSubmit: (v) => api('POST', '/api/folders/move', { path: f, name: checkName(v.name) }),
  });
  if (!res) return;
  followFolder(f, res.path);
  await refresh();
}

async function moveFolder(f) {
  const res = await dialog({
    title: `Move “${nameOf(f)}”`,
    submit: 'Move',
    fields: [{ name: 'to', label: 'Move into', type: 'select', value: parentOf(f), options: folderOptions(f) }],
    onSubmit: (v) => api('POST', '/api/folders/move', { path: f, to: v.to }),
  });
  if (!res) return;
  followFolder(f, res.path);
  toast(`Moved to ${parentOf(res.path) || 'top level'}`);
  await refresh();
}

async function deleteFolder(f) {
  const n = total.get(f) || 0;
  const subs = state.folders.filter((x) => x !== f && isInside(x, f)).length;
  const inside = n
    ? `the <strong>${plural(n, 'sheet')}</strong> inside it${subs ? ` (in ${plural(subs, 'subfolder')})` : ''}`
    : subs ? `its ${plural(subs, 'empty subfolder')}` : '';
  const res = await dialog({
    title: 'Delete folder?',
    message: `“${esc(nameOf(f))}”${inside ? ` and ${inside}` : ''} will be moved to the vault's <code>.trash</code> folder.`,
    submit: n ? `Delete folder and ${plural(n, 'sheet')}` : 'Delete folder',
    danger: true,
    onSubmit: () => api('DELETE', '/api/folders?path=' + encodeURIComponent(f)),
  });
  if (!res) return;
  if (isInside(state.cat, f)) {
    state.cat = parentOf(f);
    writeHash();
  }
  toast(`Moved “${nameOf(f)}” to .trash`);
  await refresh();
}

// ---- moving sheets ----
async function moveSheets(paths, folder) {
  try {
    const { moved, failed } = await api('POST', '/api/move-many', { paths, folder });
    const n = Object.entries(moved).filter(([from, to]) => from !== to).length;
    let msg = `Moved ${plural(n, 'sheet')} to ${folder || 'top level'}`;
    if (failed.length) msg += `; ${failed.length} failed: ${failed.map((x) => x.error).join(', ')}`;
    toast(msg, failed.length ? 'error' : '');
    for (const p of Object.keys(moved)) state.selected.delete(p);
  } catch (e) {
    toast(e.message, 'error');
  }
  await refresh();
}

async function moveSelected() {
  const paths = [...state.selected];
  if (!paths.length) return;
  const res = await dialog({
    title: `Move ${plural(paths.length, 'sheet')}`,
    submit: 'Move',
    fields: [{ name: 'folder', label: 'Move to', type: 'select', value: uploadCategory(), options: folderOptions() }],
  });
  if (res) await moveSheets(paths, res.folder);
}

// ---- folder menu (… button, right-click) ----
const menu = $('#folderMenu');
let menuFolder = null;

function openMenu(f, x, y) {
  menuFolder = f;
  const items = f === ''
    ? [['new', 'New folder']]
    : [['new', 'New subfolder'], ['rename', 'Rename…'], ['move', 'Move…'], ['delete', 'Delete…']];
  menu.innerHTML = items
    .map(([a, l]) => `<button role="menuitem" data-folder-action="${a}"${a === 'delete' ? ' class="danger"' : ''}>${l}</button>`)
    .join('');
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  $('button', menu).focus();
}
function closeMenu() {
  menu.hidden = true;
  menuFolder = null;
}

menu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-folder-action]');
  if (!b) return;
  const f = menuFolder;
  closeMenu();
  document.body.classList.remove('nav-open');
  ({ new: () => newFolder(f), rename: () => renameFolder(f), move: () => moveFolder(f), delete: () => deleteFolder(f) })[b.dataset.folderAction]();
});
menu.addEventListener('keydown', (e) => {
  const items = $$('button', menu);
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  }
});
document.addEventListener('click', (e) => {
  if (!menu.hidden && !e.target.closest('#folderMenu, [data-menu]')) closeMenu();
});
window.addEventListener('resize', closeMenu);
$('.sidebar').addEventListener('scroll', closeMenu);

// Shared by the sidebar, folder tiles and breadcrumb.
function onNavClick(e) {
  const t = e.target.closest('[data-toggle], [data-menu], [data-cat]');
  if (!t) return;
  e.preventDefault();
  if (t.dataset.toggle != null) {
    const f = t.dataset.toggle;
    state.open.has(f) ? state.open.delete(f) : state.open.add(f);
    prefs.save('cv-open', [...state.open]);
    renderTree();
  } else if (t.dataset.menu != null) {
    if (!menu.hidden && menuFolder === t.dataset.menu) return closeMenu();
    const r = t.getBoundingClientRect();
    openMenu(t.dataset.menu, r.left, r.bottom + 4);
  } else {
    go(t.dataset.cat);
  }
}
function onContextMenu(e) {
  const row = e.target.closest('[data-folder]');
  if (!row) return;
  e.preventDefault();
  openMenu(row.dataset.folder, e.clientX, e.clientY);
}
for (const el of [$('#cats'), $('#folders'), $('#heading')]) {
  el.addEventListener('click', onNavClick);
  el.addEventListener('contextmenu', onContextMenu);
}

// ---- cards: star, select ----
$('#grid').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-star]');
  if (b) {
    e.preventDefault();
    const done = stars.toggle(b.dataset.star);
    render();
    await done;
    render();
    return;
  }
  const pick = e.target.closest('[data-pick]');
  if (pick) {
    const p = pick.dataset.pick;
    pick.checked ? state.selected.add(p) : state.selected.delete(p);
    pick.closest('.card').classList.toggle('selected', pick.checked);
    renderSelection();
  }
});
$('#selMove').addEventListener('click', moveSelected);
$('#selClear').addEventListener('click', () => {
  state.selected.clear();
  render();
});

// ---- drag cards onto a folder (sidebar, tiles, breadcrumb) ----
$('#grid').addEventListener('dragstart', (e) => {
  const c = e.target.closest('.card');
  if (!c) return;
  const p = c.dataset.path;
  const paths = state.selected.has(p) ? [...state.selected] : [p];
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
  e.dataTransfer.effectAllowed = 'move';
  document.body.classList.add('dragging-cards');
});
$('#grid').addEventListener('dragend', () => {
  document.body.classList.remove('dragging-cards');
  $$('.drop-over').forEach((el) => el.classList.remove('drop-over'));
});
const isCardDrag = (e) => e.dataTransfer && [...e.dataTransfer.types].includes(DRAG_TYPE);
document.addEventListener('dragover', (e) => {
  if (!isCardDrag(e)) return;
  const t = e.target.closest('[data-drop]');
  $$('.drop-over').forEach((el) => el !== t && el.classList.remove('drop-over'));
  if (!t) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  t.classList.add('drop-over');
});
document.addEventListener('drop', (e) => {
  if (!isCardDrag(e)) return;
  const t = e.target.closest('[data-drop]');
  if (!t) return;
  e.preventDefault();
  t.classList.remove('drop-over');
  document.body.classList.remove('dragging-cards');
  let paths;
  try {
    paths = JSON.parse(e.dataTransfer.getData(DRAG_TYPE));
  } catch {
    return;
  }
  moveSheets(paths, t.dataset.drop);
});

// ---- search, sort, toolbar ----
let debounce;
$('#q').addEventListener('input', (e) => {
  state.q = e.target.value;
  clearTimeout(debounce);
  debounce = setTimeout(async () => {
    try {
      await runSearch();
    } catch (err) {
      toast(err.message, 'error');
    }
    writeHash();
    render();
  }, 180);
});

$('#sort').value = state.sort;
$('#sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  prefs.save('cv-sort', state.sort);
  render();
});

$('#newBtn').addEventListener('click', newSheet);
$('#linkBtn').addEventListener('click', fromLink);
$('#newFolderBtn').addEventListener('click', () => newFolder());
$('#uploadBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  uploadFiles(e.target.files);
  e.target.value = '';
});
$('#themeBtn').addEventListener('click', toggleTheme);
$('#navToggle').addEventListener('click', () => document.body.classList.toggle('nav-open'));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !menu.hidden) {
    closeMenu();
  } else if (e.key === '/' && !e.target.closest('input, textarea, select, dialog')) {
    e.preventDefault();
    $('#q').focus();
  } else if (e.key === 'Escape' && document.activeElement === $('#q') && $('#q').value) {
    $('#q').value = '';
    $('#q').dispatchEvent(new Event('input'));
  } else if (e.key === 'Escape' && state.selected.size && !e.target.closest('dialog')) {
    state.selected.clear();
    render();
  }
});

// Drag and drop files anywhere on the page.
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || document.querySelector('dialog[open]')) return;
  e.preventDefault();
  dragDepth++;
  $('#dropzone').hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('#dropzone').hidden = true;
  }
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropzone').hidden = true;
  if (!document.querySelector('dialog[open]')) uploadFiles(e.dataTransfer.files);
});

window.addEventListener('hashchange', async () => {
  readHash();
  await runSearch().catch(() => {});
  render();
});
// Pick up changes made in another tab or directly on disk.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

readHash();
refresh();
