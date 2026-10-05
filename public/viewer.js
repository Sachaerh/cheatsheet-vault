import { api, $, $$, esc, viewUrl, stars, toggleTheme, toast, dialog, copyText } from './common.js';

const meta = JSON.parse($('#sheet-meta').textContent);

// ---- copy buttons on code blocks ----
for (const pre of $$('article.md pre')) {
  const code = $('code', pre);
  if (!code) continue;
  const lang = [...code.classList].find((c) => c.startsWith('language-'));
  const wrap = document.createElement('div');
  wrap.className = 'code-wrap';
  pre.replaceWith(wrap);
  wrap.appendChild(pre);
  if (lang && lang !== 'language-plaintext') {
    const tag = document.createElement('span');
    tag.className = 'code-lang';
    tag.textContent = lang.slice(9);
    wrap.appendChild(tag);
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn';
  btn.textContent = 'Copy';
  btn.addEventListener('click', async () => {
    const ok = await copyText(code.innerText.replace(/\n$/, ''));
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    btn.classList.toggle('ok', ok);
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('ok');
    }, 1500);
  });
  wrap.appendChild(btn);
}

// ---- table of contents: highlight the section in view ----
const tocLinks = $$('.toc a');
if (tocLinks.length && 'IntersectionObserver' in window) {
  const byId = new Map(tocLinks.map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
  const visible = new Set();
  const obs = new IntersectionObserver(
    (entries) => {
      for (const e of entries) e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id);
      const first = [...byId.keys()].find((id) => visible.has(id));
      if (first) tocLinks.forEach((a) => a.classList.toggle('active', a === byId.get(first)));
    },
    { rootMargin: '0px 0px -70% 0px' }
  );
  for (const id of byId.keys()) {
    const el = document.getElementById(id);
    if (el) obs.observe(el);
  }
}

// ---- star ----
const starBtn = $('[data-action=star]');
function paintStar() {
  const on = stars.has(meta.path);
  starBtn.textContent = on ? '★' : '☆';
  starBtn.classList.toggle('on', on);
  starBtn.title = on ? 'Unstar' : 'Star';
  starBtn.setAttribute('aria-pressed', on);
}
paintStar();
stars.load().then(paintStar, () => {});

async function categories() {
  try {
    return (await api('GET', '/api/sheets')).folders;
  } catch {
    return [];
  }
}

const actions = {
  async star() {
    const done = stars.toggle(meta.path);
    paintStar();
    await done;
    paintStar();
  },
  theme: toggleTheme,
  print() {
    $('details.menu').open = false;
    window.print();
  },
  async edit() {
    let sheet;
    try {
      sheet = await api('GET', '/api/sheet?path=' + encodeURIComponent(meta.path));
    } catch (e) {
      return toast(e.message, 'error');
    }
    const res = await dialog({
      title: `Edit ${meta.file}`,
      wide: true,
      submit: 'Save changes',
      fields: [{ name: 'content', label: 'Content', type: 'textarea', value: sheet.content }],
      onSubmit: (v) => api('PUT', '/api/sheet', { path: meta.path, content: v.content }),
    });
    if (res) location.reload();
  },
  async move() {
    const base = meta.file.replace(/\.[^.]+$/, '');
    const res = await dialog({
      title: 'Rename / move',
      submit: 'Save',
      fields: [
        { name: 'name', label: `File name (.${meta.ext} is kept)`, value: base },
        { name: 'category', label: 'Folder', value: meta.category, placeholder: 'Empty = top level', list: await categories(), hint: 'Use / for nested folders, e.g. code/python' },
      ],
      onSubmit: (v) => api('POST', '/api/move', { path: meta.path, name: v.name, category: v.category }),
    });
    if (res && res.path) location.href = viewUrl(res.path);
  },
  async delete() {
    $('details.menu').open = false;
    const res = await dialog({
      title: 'Delete sheet?',
      message: `“${esc(meta.title)}” will be moved to the vault's <code>.trash</code> folder.`,
      submit: 'Delete',
      danger: true,
      onSubmit: () => api('DELETE', '/api/sheet?path=' + encodeURIComponent(meta.path)),
    });
    if (res) location.href = meta.category ? '/#cat=' + encodeURIComponent(meta.category) : '/';
  },
};

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]');
  if (b && actions[b.dataset.action]) {
    e.preventDefault();
    actions[b.dataset.action]();
  }
});

// Close the ⋯ menu when clicking elsewhere.
document.addEventListener('click', (e) => {
  const m = $('details.menu');
  if (m && m.open && !e.target.closest('details.menu')) m.open = false;
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, dialog')) return;
  if (e.key === 'e' && $('[data-action=edit]')) actions.edit();
  else if (e.key === 'Escape') location.href = '/';
});
