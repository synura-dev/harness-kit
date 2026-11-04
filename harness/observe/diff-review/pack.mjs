// observe/diff-review/pack.mjs: goi review TAT DINH tu diff (THUAN, khong I/O). Chi tra duong dan/so dong/ten co; KHONG chua noi dung dong diff.
// buildPack({numstat, nameStatus, addedLines, evidence, limits}) -> {base, head, truncated, bundles:[{id, files, lines, cmd}], flags:{<co>:n}}.
import { maskSecrets } from '../../core/audit/gate-event.mjs';

export const LIMITS = Object.freeze({ timeoutMs: 8000, maxFiles: 300, maxBundleLines: 400, maxBundles: 8, readMaxBytes: 4 * 1048576, maxLines: 40 });
export const FLAGS = Object.freeze(['sensitive-path', 'no-test-change', 'secret-like', 'unverified', 'large']);

const SENSITIVE = /(auth|permission|secret|credential|passw(?:or)?d|token|migration|deploy|crypto|rbac|\bacl\b|session|\.env\b|\.pem$|\.key$)/i;
const TEST = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[a-z0-9]+$/i;
const CODE = /\.(mjs|cjs|js|jsx|ts|tsx|py|go|rs|java|cs|rb|php|sh|ps1|sql)$/i;
const MAX_SECRET_AT = 3; // so vi tri path:dong toi da moi file

export const isTest = (p) => TEST.test(p);
export const isCode = (p) => CODE.test(p) && !TEST.test(p);

/** Phan tich `git diff --numstat --no-renames` -> [{path, add, del}] (nhi phan '-' -> 0). */
export function parseNumstat(text) {
  const out = [];
  for (const l of String(text || '').split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l);
    if (m) out.push({ path: m[3], add: m[1] === '-' ? 0 : +m[1], del: m[2] === '-' ? 0 : +m[2] });
  }
  return out;
}

/** Phan tich `git diff --name-status --no-renames` -> {path: 'A'|'M'|'D'|...}. */
export function parseNameStatus(text) {
  const out = {};
  for (const l of String(text || '').split('\n')) {
    const m = /^([A-Z])\d*\t(.+)$/.exec(l);
    if (m) out[m[2]] = m[1];
  }
  return out;
}

/** Phan tich `git diff -U0 --no-renames` -> [{path, line, text}] (chi dong them). Text chi dung de xet co, khong xuat. */
export function parseAddedLines(text) {
  const out = [];
  let file = null; let ln = 0;
  for (const l of String(text || '').split('\n')) {
    if (l.startsWith('+++ ')) { file = l.startsWith('+++ b/') ? l.slice(6) : null; continue; }
    if (l.startsWith('--- ') || l.startsWith('diff ')) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { ln = +h[1]; continue; }
    if (file && l.startsWith('+')) { out.push({ path: file, line: ln, text: l.slice(1) }); ln++; }
  }
  return out;
}

const q = (p) => (/^[\w./@+-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);
const dirAtDepth = (p, depth) => p.split('/').slice(0, -1).slice(0, depth).join('/') || '.';

/** Chia file (da sap theo path) thanh bundle theo thu muc o do sau `depth`, tran dong; file lon rieng. */
function bundleAt(files, depth, cap) {
  const groups = new Map();
  for (const f of files) { const k = dirAtDepth(f.path, depth); (groups.get(k) || groups.set(k, []).get(k)).push(f); }
  const out = [];
  for (const [dir, list] of groups) {
    let cur = null;
    for (const f of list) {
      const n = f.add + f.del;
      if (n > cap) { out.push({ id: dir, files: [f], lines: n }); cur = null; continue; }
      if (!cur || cur.lines + n > cap) { cur = { id: dir, files: [], lines: 0 }; out.push(cur); }
      cur.files.push(f); cur.lines += n;
    }
  }
  return out;
}

/**
 * numstat: [{path, add, del}]; nameStatus: {path: status}; addedLines: [{path, line, text}];
 * evidence: null (khong biet, bo co unverified) | {kinds:{test:{fresh_pass}}} (tu evidence.summary).
 * Khong I/O, khong nem; dau vao thieu -> rong.
 */
export function buildPack({ numstat = [], nameStatus = {}, addedLines = [], evidence = null, limits = {}, base = null, ref = null, head = null, truncated = null } = {}) {
  const L = { ...LIMITS, ...limits };
  let trunc = truncated || null;
  let rows = [...numstat].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (rows.length > L.maxFiles) { rows = rows.slice(0, L.maxFiles); trunc = trunc || 'max_files'; }
  const kept = new Set(rows.map((r) => r.path));

  const anyTest = rows.some((r) => isTest(r.path));
  const unverified = !!evidence && !(evidence.kinds && evidence.kinds.test && evidence.kinds.test.fresh_pass);
  const secretAt = new Map();
  for (const a of addedLines) {
    if (!a || !kept.has(a.path) || isTest(a.path) || maskSecrets(a.text) === a.text) continue;
    const arr = secretAt.get(a.path) || secretAt.set(a.path, []).get(a.path);
    if (arr.length < MAX_SECRET_AT) arr.push(a.line);
  }

  const flagCount = {};
  const files = rows.map((r) => {
    const flags = [];
    if (SENSITIVE.test(r.path)) flags.push('sensitive-path');
    if (isCode(r.path) && !anyTest) flags.push('no-test-change');
    if (secretAt.has(r.path)) flags.push('secret-like');
    if (unverified && isCode(r.path)) flags.push('unverified');
    if (r.add + r.del > L.maxBundleLines) flags.push('large');
    for (const f of flags) flagCount[f] = (flagCount[f] || 0) + 1;
    const o = { path: r.path, add: r.add, del: r.del, status: nameStatus[r.path] || 'M', flags };
    if (secretAt.has(r.path)) o.at = secretAt.get(r.path).map((n) => `${r.path}:${n}`);
    return o;
  });

  // giam do sau thu muc cho den khi so bundle <= maxBundles
  const maxDepth = files.reduce((m, f) => Math.max(m, f.path.split('/').length - 1), 0);
  let bundles = [];
  for (let d = maxDepth; d >= 0; d--) {
    bundles = bundleAt(files, d, L.maxBundleLines);
    if (bundles.length <= L.maxBundles) break;
  }
  if (bundles.length > L.maxBundles) { bundles = bundles.slice(0, L.maxBundles); trunc = trunc || 'max_bundles'; }
  bundles = bundles.map((b, i) => ({
    id: `b${i + 1}:${b.id}`, files: b.files, lines: b.lines,
    cmd: `git diff ${base || 'HEAD'} -- ${b.files.map((f) => q(f.path)).join(' ')}`,
  }));
  return { base, ref, head, truncated: trunc, bundles, flags: flagCount };
}
