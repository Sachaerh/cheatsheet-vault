// Shared helpers for the library and viewer pages.

export async function api(method, url, body) {
  const opts = { method, headers: { 'X-Vault': '1' } };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  return data;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function viewUrl(p) {
  return '/view/' + p.split('/').map(encodeURIComponent).join('/');
}

// ---- local storage (may be unavailable) ----
function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
export const prefs = { load, save };

// Stars live on the server (data/.stars.json) so every device shares them and
// moves keep them. Stars from older versions, kept in this browser, are merged in once.
export const stars = {
  set: new Set(),
  async load(list) {
    if (!list) ({ stars: list } = await api('GET', '/api/stars'));
    this.set = new Set(list);
    const old = load('cv-stars', []);
    if (Array.isArray(old) && old.length) {
      try {
        ({ stars: list } = await api('PUT', '/api/stars', { add: old }));
        this.set = new Set(list);
        localStorage.removeItem('cv-stars');
      } catch {}
    }
    return this.set;
  },
  has(p) {
    return this.set.has(p);
  },
  async toggle(p) {
    const on = !this.set.has(p);
    on ? this.set.add(p) : this.set.delete(p);
    try {
      const { stars: list } = await api('PUT', '/api/stars', on ? { add: [p] } : { remove: [p] });
      this.set = new Set(list);
    } catch (e) {
      on ? this.set.delete(p) : this.set.add(p);
      toast(e.message, 'error');
    }
    return this.set.has(p);
  },
};

// ---- theme ----
export function currentTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t) return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
export function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('cv-theme', next);
  } catch {}
}

// ---- clipboard (navigator.clipboard needs HTTPS; fall back for plain HTTP) ----
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  const sel = document.getSelection();
  const prev = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  ta.remove();
  if (prev) {
    sel.removeAllRanges();
    sel.addRange(prev);
  }
  return ok;
}

// ---- toast ----
let toastTimer;
export function toast(msg, kind = '') {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), kind === 'error' ? 5000 : 2500);
}

// ---- modal dialog built on <dialog> ----
// fields: [{name, label, type: 'text'|'textarea'|'select', value, options, placeholder, list}]
export function dialog({ title, fields = [], submit = 'Save', danger = false, message = '', wide = false, onSubmit }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'modal' + (wide ? ' wide' : '');
    const id = 'f' + Math.random().toString(36).slice(2);
    d.innerHTML = `<form method="dialog">
      <h2>${esc(title)}</h2>
      ${message ? `<p class="msg">${message}</p>` : ''}
      ${fields
        .map((f, i) => {
          const fid = `${id}-${i}`;
          let input;
          if (f.type === 'textarea') {
            input = `<textarea id="${fid}" name="${f.name}" spellcheck="false" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`;
          } else if (f.type === 'select') {
            input = `<select id="${fid}" name="${f.name}">${f.options
              .map(([v, l]) => `<option value="${esc(v)}"${v === f.value ? ' selected' : ''}>${esc(l)}</option>`)
              .join('')}</select>`;
          } else {
            input = `<input id="${fid}" name="${f.name}" type="text" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="off"${f.list ? ` list="${id}-list-${i}"` : ''}>`;
            if (f.list) input += `<datalist id="${id}-list-${i}">${f.list.map((o) => `<option value="${esc(o)}">`).join('')}</datalist>`;
          }
          return `<label class="field ${f.type || 'text'}" for="${fid}"><span>${esc(f.label)}</span>${input}${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</label>`;
        })
        .join('')}
      <p class="form-error" hidden></p>
      <div class="buttons">
        <button type="button" class="btn" value="cancel">Cancel</button>
        <button type="submit" class="btn ${danger ? 'danger' : 'primary'}" value="ok">${esc(submit)}</button>
      </div>
    </form>`;
    document.body.appendChild(d);
    const form = $('form', d);
    const err = $('.form-error', d);
    const close = (val) => {
      d.close();
      d.remove();
      resolve(val);
    };
    $('button[value=cancel]', d).addEventListener('click', () => close(null));
    d.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(null);
    });
    // Ctrl/Cmd+Enter submits from a textarea.
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const btn = $('button[type=submit]', d);
      btn.disabled = true;
      err.hidden = true;
      try {
        const result = onSubmit ? await onSubmit(values) : values;
        close(result ?? values);
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        btn.disabled = false;
      }
    });
    d.showModal();
    const first = $('textarea, input, select', d);
    if (first) first.focus();
  });
}
