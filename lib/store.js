// File-backed sheet store: every sheet is a plain file under SHEETS_DIR,
// subfolders are categories. Keeps an in-memory cache of titles and
// extracted text (for search), refreshed by comparing mtime/size.
import fs from 'node:fs/promises';
import path from 'node:path';

export const TYPES = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.html': 'html',
  '.htm': 'html',
  '.pdf': 'pdf',
  '.txt': 'text',
};
export const TEXT_TYPES = new Set(['markdown', 'html', 'text']);
const TRASH = '.trash';
const KEEP = '.keep'; // keeps an empty folder from being pruned
const STARS = '.stars.json';
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_DEPTH = 8;
const MAX_NAME = 120;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function typeOf(file) {
  return TYPES[path.extname(file).toLowerCase()] || null;
}

// Clean a single file/folder name: no separators, control chars, or leading dots.
export function cleanName(name) {
  return String(name ?? '')
    .normalize('NFKC')
    .replace(/[\/\\:*?"<>|\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .slice(0, 120)
    .trim();
}

export function cleanCategory(cat) {
  const parts = String(cat ?? '')
    .split(/[\\/]+/)
    .map(cleanName)
    .filter((p) => p && p !== '..');
  if (parts.length > MAX_DEPTH) throw new HttpError(400, 'Category is nested too deeply');
  return parts.join('/');
}

// Strict check for one folder name: rejects instead of repairing, so a bad
// request never lands somewhere the user didn't ask for.
export function folderName(name) {
  const n = typeof name === 'string' ? name : '';
  if (
    !n ||
    n.length > MAX_NAME ||
    n !== n.trim() ||
    n.startsWith('.') || // ".", "..", hidden names, .trash
    /[\/\\:*?"<>|\u0000-\u001f\u007f]/.test(n)
  ) {
    throw new HttpError(400, `Invalid folder name: ${JSON.stringify(n.slice(0, 40))}`);
  }
  return n;
}

// Strict check for a folder path relative to the root; '' means the root.
export function folderPath(p) {
  if (p == null || p === '') return '';
  if (typeof p !== 'string') throw new HttpError(400, 'Invalid folder path');
  const parts = p.split('/');
  if (parts.length > MAX_DEPTH) throw new HttpError(400, 'Folder is nested too deeply');
  return parts.map(folderName).join('/');
}

const isInside = (child, parent) => child === parent || child.startsWith(parent + '/');

export function detectKind(content) {
  const s = String(content).trimStart().slice(0, 4000);
  if (/^(<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(s)) return 'html';
  if (/^<[a-z][\w-]*[\s>]/i.test(s) && /<\/[a-z][\w-]*>/i.test(s)) return 'html';
  return 'markdown';
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/pre)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function prettyName(file) {
  return path.basename(file, path.extname(file)).replace(/[_]+/g, ' ').trim() || file;
}

export function extractTitle(type, content, file) {
  if (type === 'markdown') {
    const noCode = content.replace(/^(```|~~~)[\s\S]*?^\1/gm, '');
    const m = noCode.match(/^#[ \t]+(.+?)[ \t#]*$/m);
    if (m) return m[1].trim();
  } else if (type === 'html') {
    const m = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m && m[1].trim()) return decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
  }
  return prettyName(file);
}

let unpdf;
async function pdfText(buf) {
  try {
    unpdf ??= await import('unpdf');
    const doc = await unpdf.getDocumentProxy(new Uint8Array(buf));
    try {
      const { text } = await unpdf.extractText(doc, { mergePages: true });
      return text || '';
    } finally {
      await (doc.destroy?.() ?? doc.cleanup?.());
    }
  } catch (e) {
    console.error('PDF text extraction failed:', e.message);
    return '';
  }
}

export class Store {
  constructor(root) {
    this.root = path.resolve(root);
    this.cache = new Map(); // rel -> entry (with .text)
    this.dirs = []; // every visible folder, including empty ones
    this.lastScan = 0;
    this.scanning = null;
    this.starQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
    this.realRoot = await fs.realpath(this.root);
    this.root = this.realRoot;
  }

  // Map a user-supplied relative path to an absolute one inside the root.
  resolve(rel) {
    if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new HttpError(400, 'Bad path');
    const parts = rel.split(/[\\/]+/).filter(Boolean);
    if (!parts.length || parts.some((p) => p === '.' || p === '..' || p.startsWith('.'))) {
      throw new HttpError(400, 'Bad path');
    }
    const abs = path.resolve(this.root, ...parts);
    if (!abs.startsWith(this.root + path.sep)) throw new HttpError(400, 'Bad path');
    return abs;
  }

  // Same, but the file must exist and its real path (after symlinks) must stay inside.
  async resolveExisting(rel) {
    const abs = this.resolve(rel);
    let real;
    try {
      real = await fs.realpath(abs);
    } catch {
      throw new HttpError(404, 'Sheet not found');
    }
    if (!real.startsWith(this.realRoot + path.sep)) throw new HttpError(403, 'Forbidden');
    const st = await fs.lstat(real);
    if (!st.isFile()) throw new HttpError(404, 'Sheet not found');
    if (!typeOf(real)) throw new HttpError(415, 'Unsupported file type');
    return real;
  }

  relOf(abs) {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  async isEmpty() {
    const items = await fs.readdir(this.root);
    return items.filter((n) => n !== TRASH).length === 0;
  }

  invalidate() {
    this.lastScan = 0;
  }

  async walk(dir, out, depth = 0, dirs = null) {
    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of items) {
      if (d.name.startsWith('.')) continue; // hidden files, .trash
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (depth < MAX_DEPTH) {
          dirs?.push(abs);
          await this.walk(abs, out, depth + 1, dirs);
        }
      } else if (d.isFile() && typeOf(d.name)) {
        out.push(abs); // symlinks are skipped (not isFile on a Dirent)
      }
    }
  }

  async load(abs, st) {
    const rel = this.relOf(abs);
    const type = typeOf(abs);
    const file = path.basename(abs);
    let title = prettyName(file);
    let text = '';
    if (TEXT_TYPES.has(type)) {
      const raw = await fs.readFile(abs, 'utf8');
      title = extractTitle(type, raw, file);
      text = type === 'html' ? htmlToText(raw) : raw;
    } else if (type === 'pdf') {
      text = await pdfText(await fs.readFile(abs));
    }
    text = text.slice(0, MAX_TEXT);
    const category = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    return {
      path: rel,
      file,
      category,
      type,
      ext: path.extname(file).slice(1).toLowerCase(),
      title,
      size: st.size,
      mtime: st.mtimeMs,
      excerpt: excerptOf(type, text),
      text,
    };
  }

  async scan() {
    if (Date.now() - this.lastScan < 1500) return;
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const files = [];
      const dirs = [];
      await this.walk(this.root, files, 0, dirs);
      this.dirs = dirs.map((d) => this.relOf(d)).sort();
      const seen = new Set();
      for (const abs of files) {
        const rel = this.relOf(abs);
        seen.add(rel);
        let st;
        try {
          st = await fs.stat(abs);
        } catch {
          continue;
        }
        const old = this.cache.get(rel);
        if (old && old.mtime === st.mtimeMs && old.size === st.size) continue;
        try {
          this.cache.set(rel, await this.load(abs, st));
        } catch (e) {
          console.error('Failed to index', rel, e.message);
        }
      }
      for (const rel of this.cache.keys()) if (!seen.has(rel)) this.cache.delete(rel);
      this.lastScan = Date.now();
    })().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  async list() {
    await this.scan();
    return [...this.cache.values()];
  }

  async folders() {
    await this.scan();
    return this.dirs;
  }

  async get(rel) {
    const abs = await this.resolveExisting(rel);
    await this.scan();
    return this.cache.get(this.relOf(abs)) || this.load(abs, await fs.stat(abs));
  }

  // Pick a free file name in dir: "name.ext", "name-2.ext", ...
  async freePath(dir, base, ext) {
    for (let i = 1; i < 1000; i++) {
      const name = i === 1 ? `${base}${ext}` : `${base}-${i}${ext}`;
      const abs = path.join(dir, name);
      try {
        await fs.lstat(abs);
      } catch {
        return abs;
      }
    }
    throw new HttpError(409, 'Too many files with that name');
  }

  async dirFor(category) {
    // An existing folder is used as is, even if cleanCategory would spell it differently.
    try {
      return await this.folderDir(category);
    } catch {}
    const cat = cleanCategory(category);
    const dir = cat ? this.resolve(cat) : this.root;
    await fs.mkdir(dir, { recursive: true });
    const real = await fs.realpath(dir);
    if (real !== this.realRoot && !real.startsWith(this.realRoot + path.sep)) {
      throw new HttpError(403, 'Forbidden');
    }
    return real;
  }

  async create({ category, name, ext, data }) {
    if (!TYPES['.' + ext]) throw new HttpError(415, 'Unsupported file type');
    const base = cleanName(name) || 'Untitled';
    const dir = await this.dirFor(category);
    const abs = await this.freePath(dir, base, '.' + ext);
    await fs.writeFile(abs, data, { flag: 'wx' });
    this.invalidate();
    return this.relOf(abs);
  }

  async write(rel, content) {
    const abs = await this.resolveExisting(rel);
    if (!TEXT_TYPES.has(typeOf(abs))) throw new HttpError(400, 'Only text sheets can be edited');
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.tmp`);
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, abs);
    this.invalidate();
    return this.relOf(abs);
  }

  async move(rel, { category, name }) {
    const dir = category != null ? await this.dirFor(category) : null;
    return this.moveInto(rel, dir, name);
  }

  // Move a sheet into an already checked real directory (null = stay put), optionally renaming it.
  async moveInto(rel, dir, name) {
    const abs = await this.resolveExisting(rel);
    const ext = path.extname(abs);
    const base = name != null ? cleanName(String(name).replace(/\.[a-z]+$/i, (m) => (typeOf('x' + m) ? '' : m))) : path.basename(abs, ext);
    if (!base) throw new HttpError(400, 'Name is required');
    dir ??= path.dirname(abs);
    const target = path.join(dir, base + ext);
    if (target === abs) return this.relOf(abs);
    let dest = target;
    // Allow a case-only rename of the same file; otherwise never overwrite.
    if (target.toLowerCase() !== abs.toLowerCase()) dest = await this.freePath(dir, base, ext);
    await fs.rename(abs, dest);
    await this.prune(path.dirname(abs));
    this.invalidate();
    const from = this.relOf(abs);
    const to = this.relOf(dest);
    await this.updateStars((s) => {
      if (s.delete(from)) s.add(to);
    });
    return to;
  }

  // Move several sheets into one existing folder. Keeps going past failures.
  async moveMany(paths, folder) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 1000) throw new HttpError(400, 'paths must be a non-empty list');
    const dir = await this.folderDir(folder);
    const moved = {};
    const failed = [];
    for (const p of paths) {
      try {
        moved[p] = await this.moveInto(String(p), dir);
      } catch (e) {
        failed.push({ path: String(p), error: e.message });
      }
    }
    return { moved, failed };
  }

  // Deleted sheets and folders go to SHEETS_DIR/.trash so a mistake can be undone by hand.
  async toTrash(abs) {
    const trash = path.join(this.root, TRASH);
    await fs.mkdir(trash, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const flat = this.relOf(abs).replace(/\//g, '__');
    await fs.rename(abs, path.join(trash, `${stamp}__${flat}`));
    await this.prune(path.dirname(abs));
    this.invalidate();
  }

  async remove(rel) {
    const abs = await this.resolveExisting(rel);
    await this.toTrash(abs);
    const gone = this.relOf(abs);
    await this.updateStars((s) => {
      s.delete(gone);
    });
  }

  // ---- folders ----

  // Real path of an existing folder ('' = root). No component may be a symlink.
  async folderDir(rel) {
    const p = folderPath(rel);
    let cur = this.realRoot;
    if (!p) return cur;
    for (const part of p.split('/')) {
      cur = path.join(cur, part);
      let st;
      try {
        st = await fs.lstat(cur);
      } catch {
        throw new HttpError(404, 'Folder not found');
      }
      if (st.isSymbolicLink()) throw new HttpError(403, 'Forbidden');
      if (!st.isDirectory()) throw new HttpError(404, 'Folder not found');
    }
    return cur;
  }

  async createFolder(rel) {
    const p = folderPath(rel);
    if (!p) throw new HttpError(400, 'Folder name is required');
    const parent = await this.folderDir(path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p));
    const abs = path.join(parent, path.posix.basename(p));
    try {
      await fs.mkdir(abs);
    } catch (e) {
      if (e.code === 'EEXIST') throw new HttpError(409, 'A file or folder with that name already exists');
      throw e;
    }
    await fs.writeFile(path.join(abs, KEEP), '');
    this.invalidate();
    return p;
  }

  // Rename and/or move a folder. `to` is the new parent ('' = root, undefined = same parent).
  async moveFolder(rel, { to, name } = {}) {
    const src = folderPath(rel);
    if (!src) throw new HttpError(400, 'The root folder cannot be moved');
    const srcAbs = await this.folderDir(src);
    const dirs = await this.folders();
    const oldParent = path.posix.dirname(src) === '.' ? '' : path.posix.dirname(src);
    const parent = to == null ? oldParent : folderPath(to);
    const newName = name == null ? path.posix.basename(src) : folderName(name);
    const dest = parent ? `${parent}/${newName}` : newName;
    if (dest === src) return src;
    if (isInside(parent, src)) throw new HttpError(400, 'A folder cannot be moved into itself');
    const destAbs = path.join(await this.folderDir(parent), newName);
    // The deepest folder inside must stay within MAX_DEPTH or its sheets would vanish from the list.
    const depthBelow = Math.max(0, ...dirs.filter((d) => isInside(d, src)).map((d) => d.split('/').length - src.split('/').length));
    if (dest.split('/').length + depthBelow > MAX_DEPTH) throw new HttpError(400, 'Folder would be nested too deeply');
    const caseOnly = parent === oldParent && dest.toLowerCase() === src.toLowerCase();
    if (!caseOnly) {
      try {
        await fs.lstat(destAbs);
        throw new HttpError(409, 'A file or folder with that name already exists there');
      } catch (e) {
        if (e instanceof HttpError) throw e;
      }
    }
    await fs.rename(srcAbs, destAbs);
    await this.prune(path.dirname(srcAbs));
    this.invalidate();
    await this.updateStars((s) => {
      for (const p of [...s]) {
        if (p.startsWith(src + '/')) {
          s.delete(p);
          s.add(dest + p.slice(src.length));
        }
      }
    });
    return dest;
  }

  async removeFolder(rel) {
    const p = folderPath(rel);
    if (!p) throw new HttpError(400, 'The root folder cannot be deleted');
    const abs = await this.folderDir(p);
    const files = [];
    await this.walk(abs, files, p.split('/').length);
    await this.toTrash(abs);
    await this.updateStars((s) => {
      for (const x of [...s]) if (x.startsWith(p + '/')) s.delete(x);
    });
    return { sheets: files.length };
  }

  // ---- stars: one JSON list of sheet paths, shared by every device ----

  async stars() {
    try {
      const v = JSON.parse(await fs.readFile(path.join(this.root, STARS), 'utf8'));
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  // Run fn(set) on the star list and save it if it changed. Calls are serialized.
  updateStars(fn) {
    const run = this.starQueue.then(async () => {
      const before = await this.stars();
      const s = new Set(before);
      await fn(s);
      const after = [...s].sort();
      if (JSON.stringify(after) !== JSON.stringify(before.sort())) {
        const file = path.join(this.root, STARS);
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(after, null, 1) + '\n');
        await fs.rename(tmp, file);
      }
      return after;
    });
    this.starQueue = run.catch(() => {});
    return run;
  }

  // Star or unstar sheets. Only existing sheets can be starred.
  async setStars({ add = [], remove = [] } = {}) {
    if (!Array.isArray(add) || !Array.isArray(remove)) throw new HttpError(400, 'add and remove must be lists');
    await this.scan();
    return this.updateStars((s) => {
      for (const p of add) if (this.cache.has(p)) s.add(p);
      for (const p of remove) s.delete(p);
    });
  }

  // Remove now-empty category folders up to (not including) the root.
  async prune(dir) {
    let d = dir;
    while (d.startsWith(this.realRoot + path.sep)) {
      try {
        await fs.rmdir(d);
      } catch {
        return;
      }
      d = path.dirname(d);
    }
  }
}

function excerptOf(type, text) {
  let t = text;
  if (type === 'markdown') {
    t = t
      .replace(/^(```|~~~)[\s\S]*?^\1/gm, ' ')
      .replace(/^#{1,6}[ \t].*$/m, '') // drop the title heading
      .replace(/[#>*_`|~\[\]()-]+/g, ' ');
  }
  return t.replace(/\s+/g, ' ').trim().slice(0, 180);
}
