// harness/knowledge/vault/frontmatter.mjs - YAML con cho frontmatter: scalar + mang inline. Thuan, khong I/O.
// Ghi: `---\nkey: value\n---\n<body>`; mang `[a, b]`; links ghi "[[id]]" de Obsidian nhan la lien ket.
import { FIELDS } from './schema.mjs';

const PLAIN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/;
const RESERVED = /^(true|false|yes|no|on|off|null|~|[-+]?\d+(\.\d+)?([eE][-+]?\d+)?)$/i;

function scalarOut(v) {
  const s = String(v);
  if (PLAIN_RE.test(s) && !RESERVED.test(s) && !/:\s|:$|\s#/.test(s)) return s;
  return JSON.stringify(s); // JSON double-quoted = YAML double-quoted hop le
}

function scalarIn(raw) {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function splitInline(inner) {
  const items = []; let cur = '', q = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (q) { cur += ch; if (ch === '\\' && q === '"' && i + 1 < inner.length) cur += inner[++i]; else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ',') { items.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) items.push(cur);
  return items.map(scalarIn).filter((x) => x !== '');
}

const unlink = (x) => String(x).replace(/^\[\[|\]\]$/g, '');

/** text -> {meta, body, error|null}. Khong co frontmatter -> meta {} + error. */
export function parse(text) {
  const t = String(text || '').replace(/^﻿/, '');
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { meta: {}, body: t, error: 'thieu frontmatter ---' };
  const meta = {}; let error = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const k = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/);
    if (!k) { error = error || `dong frontmatter khong ho tro: ${line.slice(0, 60)}`; continue; }
    const v = (k[2] || '').trim();
    if (v.startsWith('[') && v.endsWith(']')) meta[k[1]] = splitInline(v.slice(1, -1));
    else if (v.startsWith('{') && v.endsWith('}')) { try { meta[k[1]] = JSON.parse(v); } catch { meta[k[1]] = v; } } // flow mapping dang JSON (vd probe)
    else if (v === '') meta[k[1]] = '';
    else meta[k[1]] = scalarIn(v);
  }
  if (Array.isArray(meta.links)) meta.links = meta.links.map(unlink);
  return { meta, body: t.slice(m[0].length), error };
}

/** meta + body -> text (thu tu FIELDS, bo truong rong). */
export function stringify(meta, body = '') {
  const L = ['---'];
  const keys = [...FIELDS.filter((k) => k in meta), ...Object.keys(meta).filter((k) => !FIELDS.includes(k))];
  for (const k of keys) {
    const v = meta[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    if (Array.isArray(v)) L.push(`${k}: [${v.map((x) => (k === 'links' ? JSON.stringify(`[[${x}]]`) : scalarOut(x))).join(', ')}]`);
    else if (typeof v === 'object') L.push(`${k}: ${JSON.stringify(v)}`);
    else L.push(`${k}: ${scalarOut(v)}`);
  }
  L.push('---');
  const b = String(body || '').replace(/^\r?\n+/, '');
  return L.join('\n') + '\n' + (b ? b.replace(/\r?\n?$/, '\n') : '');
}
