// Tin cay extension (lop may): hash cay code + doc dang ky + kiem hash. O core de core/io (node-hook) khong phai import nguoc cli/.
// Luoc do (file config/ext/local.json, lop may): { "extensions": { "<workspace tuyet doi>": [ { id, root(tuong doi workspace), hash(sha256 ca cay code), approvedAt } ] } }
// Hash lech => CHAN (isExtensionTrusted=false) cho toi khi `ext approve`. Worktree cua hub goc doc dang ky cua hub goc.
// Ghi dang ky (register/approve) o cli/commands/ext-registry.mjs; file nay chi doc + helper dung chung.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isPluginMode, REPO_DIR } from '../io/paths.mjs';
import { pluginLayerDirs } from '../config/config.mjs';

const HASH_LIMITS = Object.freeze({ maxFiles: 5000, maxBytes: 32 * 1024 * 1024 });
// Chi bo .git. node_modules DUOC hash: code import tu node_modules chay voi quyen extension, bo qua thi doi noi dung khong lech.
// (Phuong an don gian an toan nhat: hash ca cay; node_modules qua lon => truncated => CHAN, fail-closed. Lockfile khong bao ve noi dung that tren dia.)
const SKIP = new Set(['.git']);
const win = process.platform === 'win32';
export const norm = (p) => { const r = path.resolve(String(p)); return win ? r.toLowerCase() : r; };
const sameWs = (a, b) => norm(a) === norm(b);
export const hash8 = (h) => String(h || '').slice(0, 8);

/**
 * sha256 ca cay (duong dan tuong doi + noi dung, sap xep), chi bo .git (gom ca node_modules). -> {hash, files, truncated, rejected?}
 * Symlink/junction hoac muc khong phai file/thu muc => rejected + truncated (fail-closed: khong dang ky/duyet duoc, dang ky cu => lech => CHAN).
 * Ly do tu choi thay vi hash theo target: target nam ngoai cay co the doi ma cay khong doi; readlink chi ghim duong dan, khong ghim noi dung.
 */
export function hashTree(root, limits = {}) {
  const lim = { ...HASH_LIMITS, ...limits };
  const h = crypto.createHash('sha256'); let files = 0, bytes = 0, truncated = false, rejected;
  try { if (fs.lstatSync(root).isSymbolicLink()) { rejected = 'root la symlink'; truncated = true; } } catch { /* thieu: hash rong */ }
  const walk = (dir, rel) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      if (truncated) return;
      if (SKIP.has(e.name) && e.isDirectory()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink() || (!e.isDirectory() && !e.isFile())) { rejected = `symlink/khong phai file: ${r}`; truncated = true; return; }
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) {
        let b; try { b = fs.readFileSync(path.join(dir, e.name)); } catch { continue; }
        if (++files > lim.maxFiles || (bytes += b.length) > lim.maxBytes) { truncated = true; return; }
        h.update(r + '\0'); h.update(b); h.update('\0');
      }
    }
  };
  if (!truncated) walk(root, '');
  return rejected ? { hash: h.digest('hex'), files, truncated, rejected } : { hash: h.digest('hex'), files, truncated };
}

/** Workspace la worktree cua repo hub goc => {base: hub goc, isWorktree:true}; khong thi base = ws. Loi git => base = ws. */
export function registryWorkspace(ws, gitTimeoutMs = 5000) {
  const w = path.resolve(ws);
  try {
    const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: w, encoding: 'utf8', timeout: gitTimeoutMs });
    if (r.status === 0) {
      const common = r.stdout.trim();
      if (common && path.basename(common) === '.git') {
        const base = path.dirname(common);
        if (!sameWs(base, w)) return { base, isWorktree: true };
      }
    }
  } catch { /* khong co git */ }
  return { base: w, isWorktree: false };
}

/** File lop may. opts.machineFile (test) > plugin mode: <machineDir>/ext/local.json > <base hub>/config/ext/local.json */
export function machineFile(opts = {}) {
  if (opts.machineFile) return path.resolve(opts.machineFile);
  const env = opts.env || process.env;
  const repoDir = opts.repoDir || REPO_DIR;
  if (isPluginMode(repoDir)) return path.join(pluginLayerDirs({ env, repoDir }).machineDir, 'ext', 'local.json');
  const ws = opts.base || opts.workspace || repoDir;
  return path.join(ws, 'config', 'ext', 'local.json');
}

/** Chua co file => rong. File hong (JSON loi / sai kieu) => NEM (fail-closed): khong doc thanh rong roi ghi de mat moi muc. */
export function readAll(opts) {
  const f = machineFile(opts);
  let txt;
  try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return { extensions: {} }; throw new Error(`dang ky extension khong doc duoc (${e && e.code}): ${f}`); }
  const broken = () => new Error(`dang ky extension hong (JSON loi/sai kieu): ${f}. KHONG ghi de; moi external bi CHAN. Nguoi dung sua tay hoac khoi phuc file (hoac xoa de dang ky lai tu dau) roi chay lai.`);
  let j; try { j = JSON.parse(txt.replace(/^﻿/, '')); } catch { throw broken(); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw broken();
  if (j.extensions === undefined) return { ...j, extensions: {} };
  if (!j.extensions || typeof j.extensions !== 'object' || Array.isArray(j.extensions)) throw broken();
  return j;
}
export function writeAll(opts, j) {
  const f = machineFile(opts); fs.mkdirSync(path.dirname(f), { recursive: true });
  const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(j, null, 2) + '\n'); fs.renameSync(t, f);
}
export const findKey = (all, ws) => Object.keys(all.extensions).find((k) => sameWs(k, ws));

/** Muc dang ky cua workspace (worktree -> hub goc). -> {ws, base, entries:[{id, root, hash, approvedAt}]} */
export function readEntries(opts = {}) {
  const ws = path.resolve(opts.workspace || process.cwd());
  const { base } = registryWorkspace(ws, opts.gitTimeoutMs);
  const all = readAll({ ...opts, base });
  const k = findKey(all, base);
  const entries = k && Array.isArray(all.extensions[k]) ? all.extensions[k].filter((x) => x && typeof x.id === 'string' && typeof x.root === 'string') : [];
  return { ws, base, entries };
}

/** Diem noi cho ext-runner/ext-host: [{id, root(abs trong workspace hien tai), hash, approvedAt}] (hash da ghim, chua kiem). */
export function listRegistered(opts = {}) {
  const { ws, entries } = readEntries(opts);
  return entries.map((e) => ({ id: e.id, root: path.resolve(ws, e.root), hash: e.hash, approvedAt: e.approvedAt }));
}

/** -> {status:'ok'|'drift'|'missing'|'unregistered', id, pinned, current} (hash tinh tren cay workspace hien tai) */
export function extensionStatus(id, opts = {}) {
  const { ws, entries } = readEntries(opts);
  const e = entries.find((x) => x.id === id);
  if (!e) return { status: 'unregistered', id };
  const abs = path.resolve(ws, e.root);
  // opts.root (cay se chay): phai trung root dang ky cua id, khong thi coi nhu lech (khong hash cay khac roi chay cay nay).
  if (opts.root && norm(opts.root) !== norm(abs)) return { status: 'drift', id, pinned: e.hash, rootMismatch: true };
  if (!fs.existsSync(abs)) return { status: 'missing', id, pinned: e.hash };
  const cur = hashTree(abs, opts.limits);
  if (cur.truncated) return { status: 'drift', id, pinned: e.hash, current: cur.hash, truncated: true };
  return { status: cur.hash === e.hash ? 'ok' : 'drift', id, pinned: e.hash, current: cur.hash };
}
/** Hash lech/thieu/chua dang ky => false (CHAN). Khong nem. */
export function isExtensionTrusted(id, opts = {}) { try { return extensionStatus(id, opts).status === 'ok'; } catch { return false; } }
