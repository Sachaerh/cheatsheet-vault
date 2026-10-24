// "Download all": every unlocked sheet as one Markdown file (easy to hand to an AI)
// or as a ZIP of the original files.
import zlib from 'node:zlib';
import { decodeEntities } from './store.js';

// ---- HTML -> readable Markdown-ish text ----

const cellText = (html) => inlineText(html).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

function inlineText(html) {
  return decodeEntities(
    html
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (m, c) => '`' + c.replace(/<[^>]+>/g, '') + '`')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t]+/g, ' ');
}

function tableToMarkdown(table) {
  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => ({
    head: /<th[\s>]/i.test(r[1]) && !/<td[\s>]/i.test(r[1]),
    cells: [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => cellText(c[1])),
  })).filter((r) => r.cells.length);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.cells.length));
  const line = (cells) => '| ' + Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ') + ' |';
  const out = [];
  rows.forEach((r, i) => {
    out.push(line(r.cells));
    if (i === 0) out.push('|' + ' --- |'.repeat(width));
  });
  return out.join('\n');
}

export function htmlToMarkdown(html) {
  const keep = []; // blocks protected from whitespace clean-up
  const hold = (s) => `\u0000${keep.push(s) - 1}\u0000`;
  const scripts = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((m) => m[1].trim()).filter(Boolean);

  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|head|title|nav|svg|button|select)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (m, c) => '\n\n' + hold('```\n' + decodeEntities(c.replace(/<[^>]+>/g, '')).replace(/^\n+|\s+$/g, '') + '\n```') + '\n\n')
    .replace(/<table[\s\S]*?<\/table>/gi, (t) => '\n\n' + hold(tableToMarkdown(t)) + '\n\n')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, n, t) => `\n\n${hold('#'.repeat(Number(n) + 1) + ' ' + inlineText(t).replace(/\s+/g, ' ').trim())}\n\n`)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|main|nav|ul|ol|dl|dt|dd|blockquote|details|summary|figure|aside)>/gi, '\n');
  s = inlineText(s)
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  // Blocks can hold other blocks (a <pre> in a table cell), so restore until none are left.
  for (let i = 0; i < 5 && s.includes('\u0000'); i++) s = s.replace(/\u0000(\d+)\u0000/g, (m, n) => keep[n]);
  s = s.trim();

  // Pages that build their content in JavaScript have little visible text: include the script,
  // which is where the data is, so the reader still gets the whole sheet.
  const code = scripts.join('\n\n');
  if (code.length > s.length) {
    s += `\n\n_This page builds its content with JavaScript; the script and its data follow._\n\n\`\`\`js\n${code}\n\`\`\``;
  }
  return s;
}

// ---- one Markdown file ----

// sheets: [{ title, category, path, type, content }] where content is already readable text.
export function buildBundle(sheets, { date = new Date() } = {}) {
  const day = date.toISOString().slice(0, 10);
  const out = [
    '# Cheatsheet Vault export',
    '',
    `Exported ${day} · ${sheets.length} sheet${sheets.length === 1 ? '' : 's'}`,
    '',
    'This file bundles my personal cheat sheets. Each one starts with a level-1 heading and a',
    '"Folder: … · File: …" line, and is separated from the next by a horizontal rule. Use them as',
    'reference material for my questions.',
    '',
    '## Contents',
    '',
    ...sheets.map((s, i) => `${i + 1}. ${s.title}${s.category ? ` (${s.category})` : ''}`),
  ];
  for (const s of sheets) {
    let body = s.content.replace(/\r\n?/g, '\n').trim();
    // Markdown sheets usually start with their title as "# Title"; don't repeat it.
    const first = body.match(/^#[ \t]+(.+?)[ \t#]*(\n|$)/);
    if (first && first[1].trim() === s.title) body = body.slice(first[0].length).trim();
    out.push('', '---', '', `# ${s.title}`, '', `Folder: ${s.category || 'top level'} · File: ${s.path}`, '', body || '_(no text)_');
  }
  return out.join('\n') + '\n';
}

// ---- ZIP (deflate) of the original files ----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(ms) {
  const d = new Date(ms);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// files: [{ name, data: Buffer, mtime }]. Names are stored as UTF-8.
export function buildZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const packed = zlib.deflateRawSync(f.data);
    const crc = crc32(f.data);
    const { time, date } = dosTime(f.mtime ?? Date.now());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4); // made by
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + packed.length;
  }
  const cenSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}
