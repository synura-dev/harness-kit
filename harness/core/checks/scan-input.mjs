// scan-input: dung dau vao chinh thuc cho ref-check / import-check / clutter-check tu cay that.
// Chi I/O doc co gioi han (maxFiles/maxBytes/timeoutMs). Chi import node builtin.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, posix } from 'node:path';
import { readManifests } from '../registry/plugin-registry.mjs';
import { strayReason } from './clutter-check.mjs';

const SCAN_LIMITS = Object.freeze({ maxFiles: 3000, maxBytes: 512 * 1024, timeoutMs: 8000 });

const SKIP = new Set(['node_modules', '.git', 'fixtures', '__fixtures__']);
const ROOTS = ['harness', 'config', 'docs', '.claude/agents', '.agents', 'data'];
const TEXT = /\.(mjs|cjs|js|ts|json|md)$/i;
const rel = (base, p) => relative(base, p).replace(/\\/g, '/');

/** .gitignore don gian -> ignored(path). Ho tro: #, !, /, dir/, *, **, ?. Cha bi ignore thi con cung ignore. */
export function makeIgnore(text) {
  const rules = [];
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    let neg = false;
    if (line.startsWith('!')) { neg = true; line = line.slice(1); }
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/') || line.includes('/');
    line = line.replace(/^\//, '');
    const body = line.replace(/[.+^$()|{}[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
    rules.push({ neg, dirOnly, re: new RegExp((anchored ? '^' : '^(?:.*/)?') + body + '$') });
  }
  const state = (p, isDir) => { let r = false; for (const x of rules) if ((!x.dirOnly || isDir) && x.re.test(p)) r = !x.neg; return r; };
  return (path) => {
    const parts = String(path).replace(/\\/g, '/').split('/');
    for (let i = 1; i <= parts.length; i++) if (state(parts.slice(0, i).join('/'), i < parts.length)) return true;
    return false;
  };
}

/** Duyet harness/ tim rac sinh ra (strayReason): [{path, isDir}], khong di sau vao thu muc rac/node_modules. Gioi han timeout/maxEntries. */
export function collectStray(root, limits = {}) {
  const lim = { maxEntries: 20000, timeoutMs: 5000, ...limits };
  const base = resolve(root);
  const t0 = Date.now();
  const entries = [];
  let seen = 0;
  let truncated = false;
  const walk = (dir) => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (truncated) return;
      if (++seen > lim.maxEntries) { truncated = 'limit'; return; }
      if (Date.now() - t0 > lim.timeoutMs) { truncated = 'timeout'; return; }
      const full = join(dir, e.name);
      const isDir = e.isDirectory();
      const p = rel(base, full);
      if (strayReason(p, isDir)) { entries.push({ path: p, isDir }); continue; }
      if (isDir && !['.git', 'fixtures', '__fixtures__'].includes(e.name)) walk(full);
    }
  };
  const h = join(base, 'harness');
  if (existsSync(h)) walk(h);
  return { entries, truncated };
}

/** Duyet cay: [{path, bytes, lines, content?}]. data/ chi lay kich thuoc (khong doc noi dung). */
export function collectFiles(root, limits = {}) {
  const lim = { ...SCAN_LIMITS, ...limits };
  const base = resolve(root);
  const t0 = Date.now();
  const files = [];
  let truncated = false;
  let ignored = () => false;
  try { ignored = makeIgnore(readFileSync(join(base, '.gitignore'), 'utf8')); } catch { /* khong co .gitignore */ }
  const walk = (dir, noContent) => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (truncated) return;
      if (Date.now() - t0 > lim.timeoutMs) { truncated = 'timeout'; return; }
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full, noContent); continue; }
      if (!e.isFile()) continue;
      if (files.length >= lim.maxFiles) { truncated = 'limit'; return; }
      let size = 0;
      try { size = statSync(full).size; } catch { continue; }
      const f = { path: rel(base, full), bytes: size, lines: 0 };
      // file may/cuc bo (gitignore, *.local.*) khong thuoc pham vi clutter; data/ luon tinh kich thuoc
      if (!f.path.startsWith('data/') && (/\.local\./.test(e.name) || ignored(f.path))) continue;
      if (!noContent && TEXT.test(e.name) && size <= lim.maxBytes) {
        try { f.content = readFileSync(full, 'utf8'); f.lines = f.content.split('\n').length; } catch { /* bo qua */ }
      }
      files.push(f);
    }
  };
  for (const r of ROOTS) { const d = join(base, r); if (existsSync(d)) walk(d, r === 'data'); }
  return { files, truncated };
}

const escapeRe = (x) => x.replace(/[.*+?^$\{}()|[\]\\]/g, '\\$&');
/** README nhac ten file nhu mot token (khong la hau to cua ten khac). */
const mentions = (text, name) => new RegExp('(?<![\\w.-])' + escapeRe(name) + '(?![\\w-])').test(text);
/** Tap duong dan (tu goc hub) ma code tham chieu bang literal chuoi: import/require/path.join('x.ext'). Khong khop chuoi con ten file. */
export function literalRefs(c) {
  const out = new Set();
  const dir = posix.dirname(c.path);
  const add = (spec) => {
    if (/^(node:|https?:)/.test(spec)) return;
    const p = posix.normalize(/^(harness|config|docs|data)\//.test(spec) ? spec : posix.join(dir, spec));
    out.add(p);
    if (!/\.[a-z]+$/i.test(spec)) for (const e of ['.mjs', '.js', '.json']) out.add(p + e);
  };
  for (const m of c.content.matchAll(/(?:from\s*|import\s*\(?\s*|require\(\s*)['"]([^'"\n]+)['"]/g)) if (m[1].startsWith('.')) add(m[1]);
  for (const m of c.content.matchAll(/['"`]([^'"`\n]+?\.(?:mjs|cjs|js|json|md))['"`]/g)) add(m[1]);
  return out;
}

/** registry cho clutter-check tu manifest.json cua tung extension + code. */
export function buildRegistry(root, files = []) {
  const base = resolve(root);
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const manifests = [];
  const registered = new Set();
  const adaptersOf = new Map();
  for (const { dir, m } of readManifests(join(base, 'harness'))) {
    const helpers = [...((m.files && m.files.helpers) || [])];
    manifests.push({ dir, entry: m.entry, files: { helpers }, tests: m.tests || [], config: m.config || {} });
    adaptersOf.set(dir, m.adapters || {});
    for (const v of Object.values(m.domains || {})) registered.add(norm(join(dir, typeof v === 'string' ? v : v.file)));
  }
  // hook/plugin: file duoc code cua chinh thu muc do tham chieu (import/ten file) la helper, khong mo coi.
  // Chi code (.mjs) va test moi tinh la noi tham chieu; README chi "nhan" file .md/.json tai lieu.
  for (const mf of manifests) {
    if (!/^harness\/(hooks|plugins)\/[^/]+$/.test(mf.dir)) continue;
    const inDir = files.filter((f) => f.path.startsWith(mf.dir + '/'));
    const owned = new Set([mf.entry, ...mf.files.helpers, ...mf.tests, mf.config.defaults, mf.config.schema, 'README.md', 'manifest.json', 'defaults.mjs'].filter(Boolean));
    const adapters = adaptersOf.get(mf.dir) || {};
    for (const a of Object.values(adapters)) if (typeof a === 'string' && /\.mjs$/.test(a) && !owned.has(a)) { owned.add(a); mf.files.helpers = [...mf.files.helpers, a]; }
    const relOf = (f) => f.path.slice(mf.dir.length + 1);
    for (let changed = true; changed;) {
      changed = false;
      const code = inDir.filter((f) => f.content && /\.mjs$/.test(f.path) && (owned.has(relOf(f)) || /\.test\.mjs$/.test(f.path)));
      const readme = inDir.filter((f) => f.content && relOf(f) === 'README.md');
      const targets = new Set();
      for (const c of code) for (const t of literalRefs(c)) targets.add(t);
      for (const f of inDir) {
        const r = relOf(f);
        if (owned.has(r) || /\.test\.mjs$/.test(r)) continue;
        const name = r.split('/').pop();
        const byCode = targets.has(f.path);
        const byReadme = /\.(md|json)$/.test(r) && readme.some((c) => c.path !== f.path && mentions(c.content, name));
        if (byCode || byReadme) { owned.add(r); mf.files.helpers = [...mf.files.helpers, r]; changed = true; }
      }
    }
  }
  // tham chieu config: literal config/<x> trong code harness + settings/hooks.json (khong con registry tap trung)
  const referenced = new Set();
  for (const f of files) {
    if (!f.content || !/^harness\/.+\.mjs$/.test(f.path)) continue;
    for (const m of f.content.matchAll(/config(?:\/[A-Za-z0-9_.-]+)+/g)) referenced.add(m[0]);
    // path.join(root, 'config', 'guard', 'x.json') -> config/guard/x.json
    for (const m of f.content.matchAll(/['"]config['"]\s*,\s*((?:['"][A-Za-z0-9_.-]+['"]\s*,\s*)*['"][A-Za-z0-9_.-]+\.[a-z]+['"])/g)) {
      referenced.add('config/' + [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]).join('/'));
    }
  }
  for (const extra of ['.claude/settings.json', '.agents/hooks.json']) {
    const f = join(base, extra);
    if (existsSync(f)) { try { referenced.add(readFileSync(f, 'utf8')); } catch { /* bo qua */ } }
  }
  return { manifests, registered: [...registered], referenced: [...referenced] };
}

/** Dau vao day du: {files, registry, exists, truncated}. */
export function buildScanInput(root, limits = {}) {
  const base = resolve(root);
  const { files, truncated } = collectFiles(base, limits);
  return { files, registry: buildRegistry(base, files), exists: (p) => existsSync(join(base, p)), truncated };
}
