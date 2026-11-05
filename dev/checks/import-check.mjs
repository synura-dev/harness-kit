// Check huong import (T2): quet import tinh + import() literal trong harness/**/*.mjs, doi chieu IMPORT_RULES.
// Ham loi thuan (khong I/O); scanTree la vo mong doc dia chi co limit/timeout. Chi import core + node builtin.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkImport, zoneOf } from '../../harness/core/config/contract.mjs';

const SKIP_DIRS = new Set(['node_modules', 'fixtures', '.git']);

/** Chuan hoa duong dan posix (xu ly . va ..). Tra '' neu thoat khoi goc. */
function normPath(p) {
  const out = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!out.length) return ''; out.pop(); } else out.push(seg);
  }
  return out.join('/');
}

/** Giai specifier tuong doi thanh duong dan tu goc hub; null neu khong phai relative. */
export function resolveSpec(fromRel, spec) {
  if (!/^\.\.?\//.test(spec)) return null;
  const dir = fromRel.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  return normPath(`${dir}/${spec}`);
}

/** Trich cac import tu mot nguon: [{spec, line, kind}] (kind: static|dynamic). Chi literal. */
export function extractImports(src) {
  const text = String(src || '').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const out = [];
  const lineOf = (i) => text.slice(0, i).split('\n').length;
  const lineStart = (i) => text.lastIndexOf('\n', i - 1) + 1;
  const add = (re, kind, group = 1) => {
    for (const m of text.matchAll(re)) {
      const idx = m.index + m[0].length - m[0].trimStart().length;
      const prefix = text.slice(lineStart(idx), idx);
      if (prefix.includes('//') || /^[^'"`]*(?:'[^']*'|"[^"]*"|`[^`]*`)*[^'"`]*['"`]/.test(prefix)) continue; // trong comment hoac chuoi
      out.push({ spec: m[group], line: lineOf(idx), kind });
    }
  };
  add(/^[ \t]*(?:import|export)\s*[^'";`]*?\bfrom\s*['"]([^'"\n]+)['"]/gm, 'static');
  add(/^[ \t]*import\s*['"]([^'"\n]+)['"]/gm, 'static');
  add(/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, 'dynamic');
  return out.sort((a, b) => a.line - b.line);
}

/**
 * Kiem huong import. files: [{path, content}] (path tuong doi goc hub, vd harness/core/x.mjs).
 * opts: {exists?: (relPath)=>boolean, limit?: so vi pham/missing toi da, timeoutMs?, now?: ()=>number}
 * Tra {violations:[{file,line,from,to,spec,rule}], missing:[{file,line,spec,to}], scanned, truncated}.
 */
export function checkImports(files, opts = {}) {
  const { exists, limit = 500, timeoutMs = 10000, now = Date.now } = opts;
  const known = new Set(files.map((f) => f.path.replace(/\\/g, '/')));
  const present = (p) => known.has(p) || (typeof exists === 'function' && exists(p));
  const violations = [];
  const missing = [];
  const t0 = now();
  let scanned = 0;
  let truncated = false;
  for (const f of files) {
    if (now() - t0 > timeoutMs) { truncated = 'timeout'; break; }
    if (violations.length + missing.length >= limit) { truncated = 'limit'; break; }
    const from = f.path.replace(/\\/g, '/');
    if (!/\.mjs$/.test(from)) continue;
    scanned++;
    for (const imp of extractImports(f.content)) {
      const to = resolveSpec(from, imp.spec);
      if (to === null) continue;
      const rule = to ? checkImport(from, to) : '';
      if (rule) violations.push({ file: from, line: imp.line, from, to, spec: imp.spec, rule });
      // chi bao thieu khi co nguon su that: exists hoac dich la .mjs trong cay duoc quet
      const checkable = typeof exists === 'function' || /\.mjs$/.test(to);
      if (to && zoneOf(to) && checkable && !present(to)) missing.push({ file: from, line: imp.line, spec: imp.spec, to });
    }
  }
  return { violations, missing, scanned, truncated };
}

/** Doc cay harness/ that tu root (goc hub), roi goi checkImports. Co limit file + timeout. */
export function scanTree(root, opts = {}) {
  const { maxFiles = 2000, maxBytes = 1_000_000, timeoutMs = 10000, ...rest } = opts;
  const base = resolve(root);
  const t0 = Date.now();
  const files = [];
  let truncated = false;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (truncated) return;
      if (Date.now() - t0 > timeoutMs) { truncated = 'timeout'; return; }
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); continue; }
      if (!e.name.endsWith('.mjs')) continue;
      if (files.length >= maxFiles) { truncated = 'limit'; return; }
      if (statSync(full).size > maxBytes) continue;
      files.push({ path: relative(base, full).replace(/\\/g, '/'), content: readFileSync(full, 'utf8') });
    }
  };
  const h = join(base, 'harness');
  if (existsSync(h)) walk(h);
  const res = checkImports(files, { exists: (p) => existsSync(join(base, p)), timeoutMs, ...rest });
  return { ...res, truncated: res.truncated || truncated };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const r = scanTree(root);
  for (const v of r.violations) console.log(`${v.file}:${v.line} ${v.from} -> ${v.to} (${v.rule})`);
  for (const m of r.missing) console.log(`${m.file}:${m.line} thieu file: ${m.spec}`);
  console.log(`scanned=${r.scanned} violations=${r.violations.length} missing=${r.missing.length}${r.truncated ? ' truncated: ' + r.truncated : ''}`);
}
