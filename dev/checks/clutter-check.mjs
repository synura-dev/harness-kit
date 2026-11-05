// Check chong rac harness (T3): ham thuan, khong I/O. Chi import core/contract.
// Vao: files [{path, lines, bytes, content?}] (duong dan tu goc hub), registry, opts.
import { resolveCaps, DEFAULT_CAPS, SEVERITY, TOP_DIRS, TOP_FILES, KIND_RULES, DUP_ALLOW } from '../../harness/core/config/contract.mjs';

const SOURCE_FLAT_MAX = DEFAULT_CAPS.flatMax;

const trimPath = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.?\//, '');
const isTest = (p) => /\.test\.[mc]?[jt]s$/.test(p);
const GENERATED = /\.(jsonl|log|sqlite|db|ndjson)$/i;
// noi dung toi thieu: rong, {} hoac [] (JSON); chi file nho hon fileMinBytes moi bi xet
const WORKSPACE_MARKER_FILES = new Set(['config/workspace/default.json', 'config/hub/default.json']);
const TRIVIAL =/^\s*(\{\s*\}|\[\s*\])?\s*$/;
const EMPTY_DEFAULT = /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*export\s+default\s*\{\s*\}\s*;?\s*$/;

/** Dem file nguon moi harness/<dir> (de quy; bo test, manifest.json, README*, fixture). Chi la so lieu, khong co tran. Tra [{dir, count}]. */
export function countSources(files, dirs = ['core', 'cli', 'hooks', 'plugins', 'tools']) {
  const isSrc = (p) => !isTest(p) && !/(^|\/)(manifest\.json|README[^/]*)$/.test(p) && !/\.fixture\./.test(p);
  const counts = Object.fromEntries(dirs.map((d) => [d, 0]));
  for (const f of Array.isArray(files) ? files : []) {
    const p = trimPath(f.path).split('/');
    if (p[0] === 'harness' && p.length > 2 && p[1] in counts && isSrc(p.join('/'))) counts[p[1]]++;
  }
  return Object.entries(counts).map(([dir, count]) => ({ dir, count }));
}

/** Dem file nguon PHANG (khong de quy) moi thu muc duoi harness/ (bo test, manifest.json, README*, fixture). Tra [{dir, count, max, over}] sap giam dan. */
export function countFlat(files, flatMax = SOURCE_FLAT_MAX) {
  const isSrc = (p) => !isTest(p) && !/(^|\/)(manifest\.json|README[^/]*)$/.test(p) && !/\.fixture\./.test(p);
  const counts = new Map();
  for (const f of Array.isArray(files) ? files : []) {
    const p = trimPath(f.path);
    const i = p.lastIndexOf('/');
    if (i < 0 || !p.startsWith('harness/') || !isSrc(p)) continue;
    const dir = p.slice(0, i);
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  return [...counts].map(([dir, count]) => ({ dir, count, max: flatMax, over: count > flatMax })).sort((a, b) => b.count - a.count);
}

/**
 * registry: { manifests: [{dir, entry, files:{helpers}, tests, config:{defaults,schema}}],
 *             registered: [paths dang ky (hooks.json, cli-domains...)], referenced: [chuoi tham chieu config] }
 * opts: { caps (override custom), limit=200, timeoutMs=5000, now=()=>Date.now() }
 * Tra { findings:[{rule,severity,path,message,suggest}], truncated, reason?, scanned, counts }.
 */
export function checkClutter(files, registry = {}, opts = {}) {
  const caps = resolveCaps(opts.caps);
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 200;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 5000;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const t0 = now();
  const findings = [];
  let truncated = false;
  let reason;
  let scanned = 0;
  const add = (rule, path, message, suggest) => {
    if (findings.length >= limit) { truncated = true; reason ||= 'limit'; return false; }
    findings.push({ rule, severity: SEVERITY[rule] || 'warn', path, message, suggest });
    return true;
  };

  const list = (Array.isArray(files) ? files : []).map((f) => ({ ...f, path: trimPath(f.path) })).filter((f) => f.path);
  const manifests = Array.isArray(registry.manifests) ? registry.manifests : [];
  const registered = new Set((registry.registered || []).map(trimPath));
  const refs = (registry.referenced || []).map(trimPath);

  // Tap file duoc so huu boi manifest.
  const owned = new Set(registered);
  const manifestDirs = new Set();
  for (const m of manifests) {
    const d = trimPath(m.dir).replace(/\/$/, '');
    if (!d) continue;
    manifestDirs.add(d);
    const names = [m.entry, ...(m.files?.helpers || []), ...(m.tests || []), m.config?.defaults, m.config?.schema, 'manifest.json', 'README.md'];
    for (const n of names) if (typeof n === 'string' && n) owned.add(`${d}/${n}`);
  }

  const isRef = (p) => { const b = p.slice(p.lastIndexOf('/') + 1); return refs.some((r) => r.includes(p) || r.endsWith(`/${b}`) || r === b || (r.startsWith('config/') && p.startsWith(r + '/') && r.split('/').length >= 3)); };
  const groups = new Map(); // dir extension -> file khong test
  const seenTop = new Set();
  const seenOrphanDir = new Set();

  for (const f of list) {
    if (now() - t0 > timeoutMs) { truncated = true; reason = 'timeout'; break; }
    scanned++;
    const parts = f.path.split('/');
    // file may/cuc bo (*.local.*) khong thuoc pham vi clutter
    if (parts[0] !== 'data' && /\.local\./.test(parts[parts.length - 1])) continue;
    const lines = Number(f.lines) || 0;
    const bytes = Number(f.bytes) || 0;

    // thu muc cap cao
    if (parts[0] === 'harness' && parts.length >= 2) {
      const top = parts[1];
      const ok = parts.length === 2 ? TOP_FILES.includes(top) || TOP_DIRS.includes(top) : TOP_DIRS.includes(top);
      if (!ok && !seenTop.has(top)) {
        seenTop.add(top);
        add('topDirs', `harness/${top}`, `muc cap 1 ngoai allowlist (${TOP_DIRS.join('|')})`, 'chuyen vao thu muc cho phep hoac xoa');
      }
    }

    // dai/dong
    if (lines > caps.linesPerFile) add('linesPerFile', f.path, `${lines} dong > tran ${caps.linesPerFile}`, 'tach module');

    // rong / chi export default {}
    const isEmptyCode = /\.[mc]?[jt]s$/.test(f.path) && typeof f.content === 'string' && EMPTY_DEFAULT.test(f.content);
    // dau hieu workspace (config/{workspace,hub}/default.json, paths.mjs workspaceMarker): duoc nhan dien workspace tham chieu, '{}' hop le
    const isMarker = WORKSPACE_MARKER_FILES.has(f.path);
    const tiny = !isMarker && bytes < caps.fileMinBytes && (bytes === 0 || (typeof f.content === 'string' && TRIVIAL.test(f.content.replace(/^﻿/, ''))));
    if (parts[0] !== 'data' && (isEmptyCode || tiny)) { // data/ chi tinh kich thuoc
      add('emptyFile', f.path, isEmptyCode ? 'chi export default {}' : `${bytes}B < ${caps.fileMinBytes}B va khong co khoa/noi dung`, 'xoa file hoac them noi dung that');
    }

    // du lieu sinh ra ngoai data/
    if (parts[0] !== 'data' && GENERATED.test(f.path) && !/(^|\/)(fixtures?|__fixtures__)\//.test(f.path)) {
      add('data', f.path, 'du lieu sinh ra nam ngoai data/', 'chuyen vao data/ va tro duong dan ve do');
    }

    // extension: harness/plugins|hooks/<g>/...
    if (parts[0] === 'harness' && (parts[1] === 'plugins' || parts[1] === 'hooks') && parts.length >= 4 && parts[2] !== '_shared') {
      const dir = parts.slice(0, 3).join('/');
      if (!isTest(f.path)) groups.set(dir, (groups.get(dir) || 0) + 1);
      if (!owned.has(f.path) && !isTest(f.path) && !/(^|\/)(README\.md|defaults\.mjs)$/.test(f.path)) {
        add('orphan', f.path, 'file mo coi: khong thuoc manifest hay registry', 'khai bao trong manifest/registry hoac xoa');
      } else if (!manifestDirs.has(dir) && !seenOrphanDir.has(dir) && ![...registered].some((r) => r.startsWith(`${dir}/`))) {
        seenOrphanDir.add(dir);
        add('orphan', dir, 'thu muc extension khong co manifest/registry', 'them manifest hoac xoa thu muc');
      }
    }

    // config khong ai tham chieu
    // quy uoc: config/<tool>/*.example.json la mau hop le, khong can ai tham chieu
    const isToolExample = parts[0] === 'config' && parts.length === 3 && /\.example\.json$/.test(parts[2]);
    if (parts[0] === 'config' && !isToolExample && !isMarker && !isRef(f.path)) {
      // mau *.example.*: hop le khi file that cung ten (bo '.example') duoc tham chieu
      const real = f.path.replace(/\.example(?=\.|$)/, '');
      if (!registered.has(f.path) && !(real !== f.path && (registered.has(real) || isRef(real)))) add('unusedConfig', f.path, 'config khong ai tham chieu', 'xoa hoac tham chieu tu code/manifest');
    }
  }

  for (const [dir, n] of groups) {
    if (n > caps.filesPerExtension) add('filesPerExtension', dir, `${n} file > tran ${caps.filesPerExtension} (khong tinh test)`, 'gop/tach extension');
  }

  for (const d of countFlat(list, caps.flatMax)) {
    if (d.over) add('flatMax', d.dir, `${d.count} file nguon phang > tran ${caps.flatMax}`, 'gom vao thu muc con theo trach nhiem');
  }

  // dung luong data/
  const dataBytes = list.filter((f) => f.path.startsWith('data/')).reduce((s, f) => s + (Number(f.bytes) || 0), 0);
  if (dataBytes / 1048576 > caps.dataMaxMB) {
    add('data', 'data', `${Math.round(dataBytes / 1048576)}MB > tran ${caps.dataMaxMB}MB`, 'chay prune/retention');
  }

  const counts = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  const out = { findings, truncated, scanned, counts, kinds: Object.keys(KIND_RULES) };
  if (reason) out.reason = reason;
  return out;
}

// ---- Rac sinh ra trong harness/: du lieu/trang thai phai o data/ cua hub, khong nam trong harness/. Thuan. ----
const STRAY_DIRS = new Set(['.claude', 'data', 'node_modules', '.worktrees']);

/** Ly do mot muc (tuong doi goc hub) la rac trong harness/, '' neu hop le. Extension ten `data` (harness/plugins|hooks/data) la hop le. */
export function strayReason(relPath, isDir) {
  const parts = trimPath(relPath).replace(/\/$/, '').split('/');
  if (parts[0] !== 'harness' || parts.length < 2) return '';
  const name = parts[parts.length - 1];
  if (isDir) {
    if (!STRAY_DIRS.has(name)) return '';
    if (name === 'data' && parts.length === 3 && (parts[1] === 'plugins' || parts[1] === 'hooks')) return '';
    return `thu muc ${name}/ khong thuoc harness/`;
  }
  if (/\.local\.json$/.test(name)) return 'file cau hinh may *.local.json trong harness/';
  if (/\.(log|bak|tmp)$/i.test(name)) return 'file sinh ra (.log/.bak/.tmp) trong harness/';
  return '';
}

/** entries [{path, isDir}] -> findings [{rule:'stray', severity, path, message, suggest}] (chi muc co ly do). */
export function checkStray(entries) {
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const why = strayReason(e.path, !!e.isDir);
    if (why) out.push({ rule: 'stray', severity: SEVERITY.stray, path: trimPath(e.path), message: why, suggest: 'chuyen vao data/ hoac config/ cua hub (hoac xoa)' });
  }
  return out;
}

// ---- Do rac theo ma nguon (dead export / ham trung ten / marker). Thuan: nhan files co content. ----
// Ten diem vao CLI (main/run) trung nhau la co y khi file la entry chay truc tiep (shebang, process.argv[1], import.meta.main, isMain).
const ENTRY_NAMES = new Set(['main', 'run']);
const isEntryFile = (c) => /^#!/.test(c) || /process\.argv\[1\]|import\.meta\.main|\bisMain\b/.test(c);
const isCode = (p) => /^harness\/.+\.[mc]?js$/.test(p) && !/\.fixture\./.test(p);
// Diem vao ngoai harness/ (wrapper hook, CLI bin/) chi tinh la noi DUNG export, khong quet export cua chung.
const isEntry = (p) => /^hooks\/[^/]+\.mjs$/.test(p) || p === 'bin/harness';
const IDENT = /[A-Za-z_$][\w$]*/g;
const MARK_UP = new RegExp('\\b(?:TO' + 'DO|FIX' + 'ME)\\b'); // viet hoa de khong khop bien `todo`
const MARK_CI = new RegExp('\\b(?:tempo' + 'rar(?:y|ily)|ta' + 'm)\\b', 'i');
const MARKER = { test: (l) => MARK_UP.test(l) || MARK_CI.test(l) };

/** Ten export (bo default) cua noi dung mot file. */
export function exportNames(content) {
  const out = new Set();
  for (const m of content.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/gm)) out.add(m[1]);
  for (const m of content.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop().trim(); if (n && n !== 'default') out.add(n); }
  }
  return [...out];
}

/** Ten ham cap cao (cot 0): function x( | const x = (...) => . */
export function topFunctions(content) {
  const out = new Set();
  for (const m of content.matchAll(/^(?:export\s+)?(?:async\s+)?function\*?\s+([\w$]+)\s*\(/gm)) out.add(m[1]);
  for (const m of content.matchAll(/^(?:export\s+)?const\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/gm)) out.add(m[1]);
  return [...out];
}

/**
 * Quet ma nguon: { unused:[{file,name}], testOnly:[{file,name}], dup:[{name,files}], todo:[{file,line}] }.
 * dup bo qua ten trong opts.dupAllow (mac dinh contract DUP_ALLOW). Chi file harness/**.{mjs,js} co content.
 */
export function scanCode(files, opts = {}) {
  const rules = (opts.dupAllow || DUP_ALLOW).map((x) => (typeof x === 'string' ? { name: x } : x));
  const allowed = (name, paths) => rules.some((r) => r.name === name && (!r.files || paths.every((p) => r.files.includes(p))));
  const code = (Array.isArray(files) ? files : []).map((f) => ({ path: trimPath(f.path), content: f.content })).filter((f) => typeof f.content === 'string' && (isCode(f.path) || isEntry(f.path)));
  const users = new Map(); // ident -> Set(path)
  for (const f of code) for (const id of new Set(f.content.match(IDENT) || [])) { let s = users.get(id); if (!s) users.set(id, (s = new Set())); s.add(f.path); }
  const unused = [], testOnly = [], byName = new Map(), todo = [];
  for (const f of code) {
    if (isTest(f.path) || isEntry(f.path)) continue;
    for (const name of exportNames(f.content)) {
      const others = [...(users.get(name) || [])].filter((p) => p !== f.path);
      if (!others.length) unused.push({ file: f.path, name });
      else if (others.every(isTest)) testOnly.push({ file: f.path, name });
    }
    const entry = isEntryFile(f.content);
    for (const name of topFunctions(f.content)) { if (entry && ENTRY_NAMES.has(name)) continue; let s = byName.get(name); if (!s) byName.set(name, (s = [])); s.push(f.path); }
    f.content.split('\n').forEach((l, i) => { if (MARKER.test(l)) todo.push({ file: f.path, line: i + 1 }); });
  }
  const dup = [...byName].filter(([n, p]) => p.length >= 2 && !allowed(n, p)).map(([name, p]) => ({ name, files: p })).sort((a, b) => a.name.localeCompare(b.name));
  return { unused, testOnly, dup, todo };
}
