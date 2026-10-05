import { api, $, esc, viewUrl, stars, prefs, toggleTheme, toast, dialog } from './common.js';

const state = {
  sheets: [],
  results: null, // search results, or null when not searching
  cat: '', // '' = all, '*' = starred, otherwise a category path
  q: '',
  sort: prefs.load('cv-sort', 'recent'),
};

const KIND_LABEL = { markdown: 'MD', html: 'HTML', pdf: 'PDF', text: 'TXT' };

// ---- data ----
async function refresh() {
  try {
    const { sheets } = await api('GET', '/api/sheets');
    state.sheets = sheets;
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
    return;
  }
  const { results } = await api('GET', '/api/search?q=' + encodeURIComponent(state.q));
  if (seq === searchSeq) state.results = results;
}

function categories() {
  const set = new Set();
  for (const s of state.sheets) {
    if (!s.category) continue;
    const parts = s.category.split('/');
    for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function inCat(s) {
  if (state.cat === '') return true;
  if (state.cat === '*') return stars.has(s.path);
  if (state.cat === '/') return !s.category;
  return s.category === state.cat || s.category.startsWith(state.cat + '/');
}

// ---- rendering ----
function renderCats() {
  const counts = new Map();
  let uncategorized = 0;
  for (const s of state.sheets) {
    if (!s.category) uncategorized++;
    else {
      const parts = s.category.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const k = parts.slice(0, i).join('/');
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
  }
  const starred = state.sheets.filter((s) => stars.has(s.path)).length;
  const item = (key, label, n, depth = 0, cls = '') =>
    `<a href="#" data-cat="${esc(key)}" class="cat ${cls}${state.cat === key ? ' active' : ''}" style="--depth:${depth}">
       <span class="label">${label}</span><span class="n">${n}</span></a>`;
  let html = item('', 'All sheets', state.sheets.length, 0, 'top');
  html += item('*', '★ Starred', starred, 0, 'top');
  const cats = categories();
  if (cats.length || uncategorized) html += '<div class="cat-head">Categories</div>';
  for (const c of cats) {
    const parts = c.split('/');
    html += item(c, esc(parts[parts.length - 1]), counts.get(c), parts.length - 1);
  }
  if (uncategorized && cats.length) html += item('/', '<em>Uncategorized</em>', uncategorized);
  $('#cats').innerHTML = html;
}

function sorted(list) {
  const out = [...list];
  if (state.sort === 'az') out.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }));
  else out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function fmtDate(ms) {
  const d = new Date(ms);
  const days = (Date.now() - ms) / 864e5;
  if (days < 1 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined });
}

function card(s) {
  const starred = stars.has(s.path);
  const body = s.snippets
    ? s.snippets.length
      ? `<ul class="snippets">${s.snippets.map((x) => `<li>${x}</li>`).join('')}</ul>`
      : `<p class="excerpt">${esc(s.excerpt)}</p>`
    : `<p class="excerpt">${esc(s.excerpt) || '<span class="muted">No preview</span>'}</p>`;
  return `<article class="card kind-${s.type}">
    <div class="card-top">
      <span class="badge k-${s.type}">${KIND_LABEL[s.type]}</span>
      ${s.category ? `<span class="card-cat">${esc(s.category)}</span>` : ''}
      <button class="star-btn${starred ? ' on' : ''}" data-star="${esc(s.path)}" aria-pressed="${starred}" title="${starred ? 'Unstar' : 'Star'}" aria-label="Star ${esc(s.title)}">${starred ? '★' : '☆'}</button>
    </div>
    <h3><a class="card-link" href="${viewUrl(s.path)}">${s.titleHtml || esc(s.title)}</a></h3>
    ${body}
    <div class="card-foot">${fmtDate(s.mtime)}</div>
  </article>`;
}

function render() {
  renderCats();
  const searching = state.results !== null;
  const list = (searching ? state.results : sorted(state.sheets)).filter(inCat);
  $('#grid').innerHTML = list.map(card).join('');
  const where =
    state.cat === '' ? 'All sheets' : state.cat === '*' ? 'Starred' : state.cat === '/' ? 'Uncategorized' : state.cat;
  $('#heading').textContent = searching ? `Results for “${state.q.trim()}”` + (state.cat ? ` in ${where}` : '') : where;
  $('#count').textContent = `${list.length} sheet${list.length === 1 ? '' : 's'}`;
  $('#sort').closest('.sort').hidden = searching;
  const empty = $('#empty');
  empty.hidden = list.length > 0;
  if (!list.length) {
    empty.textContent = searching
      ? 'No sheets match that search.'
      : state.cat === '*'
        ? 'No starred sheets yet. Click ☆ on a card to star it.'
        : 'No sheets here yet. Paste one with “New sheet”, or drop files on this page.';
  }
  $('#dropTarget').textContent = uploadCategory() ? `into ${uploadCategory()}` : '';
}

// ---- URL hash keeps category and search linkable ----
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  state.cat = h.get('cat') || '';
  state.q = h.get('q') || '';
  $('#q').value = state.q;
}
function writeHash() {
  const h = new URLSearchParams();
  if (state.cat) h.set('cat', state.cat);
  if (state.q) h.set('q', state.q);
  const s = h.toString();
  history.replaceState(null, '', s ? '#' + s : location.pathname);
}

// ---- adding sheets ----
function uploadCategory() {
  return state.cat && state.cat !== '*' && state.cat !== '/' ? state.cat : '';
}

async function newSheet() {
  const res = await dialog({
    title: 'New sheet',
    wide: true,
    submit: 'Save sheet',
    fields: [
      { name: 'content', label: 'Content', type: 'textarea', placeholder: 'Paste Markdown or HTML here…' },
      { name: 'title', label: 'Title (optional)', placeholder: 'Taken from the first heading or <title> if empty' },
      { name: 'category', label: 'Category (optional)', value: uploadCategory(), placeholder: 'e.g. code/python', list: categories() },
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

async function uploadFiles(files) {
  files = [...files];
  if (!files.length) return;
  const fd = new FormData();
  fd.append('category', uploadCategory());
  for (const f of files) fd.append('files', f, f.name);
  toast(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`);
  try {
    const { created, skipped } = await api('POST', '/api/upload', fd);
    let msg = `Added ${created.length} sheet${created.length === 1 ? '' : 's'}`;
    if (skipped.length) msg += `; skipped ${skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}`;
    toast(msg, skipped.length ? 'error' : '');
  } catch (e) {
    toast(e.message, 'error');
  }
  refresh();
}

// ---- events ----
$('#cats').addEventListener('click', (e) => {
  const a = e.target.closest('[data-cat]');
  if (!a) return;
  e.preventDefault();
  state.cat = a.dataset.cat;
  document.body.classList.remove('nav-open');
  writeHash();
  render();
});

$('#grid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-star]');
  if (!b) return;
  e.preventDefault();
  stars.toggle(b.dataset.star);
  render();
});

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
$('#uploadBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  uploadFiles(e.target.files);
  e.target.value = '';
});
$('#themeBtn').addEventListener('click', toggleTheme);
$('#navToggle').addEventListener('click', () => document.body.classList.toggle('nav-open'));

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !e.target.closest('input, textarea, select, dialog')) {
    e.preventDefault();
    $('#q').focus();
  } else if (e.key === 'Escape' && document.activeElement === $('#q') && $('#q').value) {
    $('#q').value = '';
    $('#q').dispatchEvent(new Event('input'));
  }
});

// Drag and drop anywhere on the page.
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
