// Hook nut -> workspace du lieu (hop dong: harness/observe/storage/README.md, muc "Hop dong workspace data").
// Module resolver (config `projectResolver`) co the export them: workspaceFor(id) -> ws|null, listNodes() -> [{id, workspace}], resolveProject (cu).
// Dong bo, cache theo process, fail-open: khong hook / loi / bi tu choi -> workspaceFor = node id, listNodes = [] (+ canh bao stderr 1 lan).
// Tin cay: duong dan resolver phai nam TRONG goc workspace (hub/du an), khong '..'; chi nap khi ext chua file do da duyet hash (core/ext/ext-trust).
// HUB_DATA_DIR dat (test/sandbox) -> bo qua hook, TRU khi no chinh la thu muc data mac dinh cua workspace (<ws>/data | <ws>/.harness/data): bin/harness va hook dat bien nay cho workspace that, khong phai ghi de.
// Chi import module nhe (paths, config, core/ext/ext-trust: doc dang ky + hash, khong import cli/); KHONG import storage.mjs/data-registry.mjs/safe-id.mjs (tranh vong khi P1 noi vao storage).
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { workspaceRoot, isInside, samePath } from './paths.mjs';
import { loadConfig } from '../config/config.mjs';
import { listRegistered, isExtensionTrusted } from '../ext/ext-trust.mjs';

const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const MAX_CFG_BYTES = 262144;
const cache = new Map();
const warned = new Set();
const nodeRequire = createRequire(import.meta.url);

/** ws/id an toan: ten don (khong '/', '\\', '..'), <= 80 ky tu. */
// Windows: ten thiet bi (CON, PRN, AUX, NUL, COM1-9, LPT1-9; co/khong duoi mo rong, khong phan biet hoa thuong) va ten ket thuc '.'/' ' khong dung duoc lam thu muc.
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const isSafeWs = (s) => typeof s === 'string' && SAFE.test(s) && !s.includes('..') && !/[. ]$/.test(s) && !WIN_RESERVED.test(s.split('.')[0]);

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const EXTS = ['', '.mjs', '.js', '.cjs', '.json'];
/** Hash byte file resolver + import tinh tuong doi CUNG thu muc (1 cap). -> Map<abs, sha256>. Import ngoai thu muc/ngoai goc ext khong duoc phu (rui ro con lai, xem README). */
function fileHashes(abs, extRoot) {
  const map = new Map();
  const dir = path.dirname(abs);
  let buf; try { buf = fs.readFileSync(abs); } catch { return map; }
  map.set(abs, sha(buf));
  for (const m of buf.toString('utf8').matchAll(IMPORT_RE)) {
    const base = path.resolve(dir, m[1]);
    if (path.dirname(base) !== dir) continue;
    for (const ext of EXTS) {
      const f = base + ext;
      if (map.has(f) || !isInside(f, extRoot)) continue;
      try { if (!fs.statSync(f).isFile()) continue; map.set(f, sha(fs.readFileSync(f))); break; } catch { /* thu duoi khac */ }
    }
  }
  return map;
}
/** Hash lai ngay truoc khi nap: -> ten file lech/mat (dau tien) | null. */
function hashMismatch(map) {
  if (!map) return null;
  for (const [f, h] of map) { try { if (sha(fs.readFileSync(f)) !== h) return f; } catch { return f; } }
  return null;
}
const sanitize = (s) => String(s ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80);

function warnOnce(o, detail, p = '') {
  const key = `${p}|${detail}`;
  if (warned.has(key)) return;
  warned.add(key);
  const line = `data-warn rule=resolver path=${p} detail=${detail} fix=kiem tra projectResolver (trong goc workspace) va hash ext (harness ext verify)`;
  if (typeof o.warn === 'function') o.warn(line); else console.error(line);
}

/** HUB_DATA_DIR = thu muc data mac dinh cua chinh workspace nay (khong phai sandbox/test) -> khong coi la ghi de. */
function isOwnDataDir(hd, root) {
  try { return samePath(hd, path.join(root, 'data')) || samePath(hd, path.join(root, '.harness', 'data')); } catch { return false; }
}

/** Doc khoa projectResolver: opts.projectResolver (test) > loadConfig (default/may) > file config cua workspace (config/{hub,workspace}/default.json). -> string|null */
function declaredResolver(o, root) {
  if (typeof o.projectResolver === 'string') return o.projectResolver;
  try {
    const c = loadConfig('workspace', { root, env: o.env, repoDir: o.repoDir }).config || {};
    if (typeof c.projectResolver === 'string' && c.projectResolver) return c.projectResolver;
  } catch { /* tiep tuc */ }
  for (const n of ['hub', 'workspace']) {
    try {
      const f = path.join(root, 'config', n, 'default.json');
      if (fs.statSync(f).size > MAX_CFG_BYTES) continue;
      const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
      if (j && typeof j.projectResolver === 'string' && j.projectResolver) return j.projectResolver;
    } catch { /* thieu/hong -> thu tiep */ }
  }
  return null;
}

/**
 * Tim + kiem tra duong dan resolver. Goc tin cay = goc workspace (plugin mode va hub), KHONG phai codeRoot.
 * -> { abs, extId } | { error, declared } | { none: true, why? }. Hash ext da duyet: opts.trust(id, extOpts) > isExtensionTrusted.
 */
export function resolveResolverPath(opts = {}) {
  const o = opts || {};
  const env = o.env || process.env;
  let root; try { root = path.resolve(o.root || workspaceRoot({ env, repoDir: o.repoDir })); } catch { return { none: true }; }
  const hd = env.HUB_DATA_DIR;
  if (typeof hd === 'string' && hd.trim() && !isOwnDataDir(hd.trim(), root)) return { none: true, why: 'HUB_DATA_DIR' };
  const decl = declaredResolver(o, root);
  if (!decl) return { none: true };
  if (path.isAbsolute(decl) && !isInside(path.resolve(decl), root)) return { error: 'projectResolver ra ngoai goc workspace, bo', declared: decl };
  if (decl.split(/[\\/]/).includes('..')) return { error: "projectResolver chua '..', bo", declared: decl };
  const abs = path.resolve(root, decl);
  if (!isInside(abs, root)) return { error: 'projectResolver ra ngoai goc workspace, bo', declared: decl };
  if (!fs.existsSync(abs)) return { error: 'projectResolver khong ton tai', declared: decl };
  // Chi nap khi mot ext da dang ky chua file nay va hash khop (doi code => nguoi dung phai duyet lai).
  const extOpts = { workspace: root, env, repoDir: o.repoDir, machineFile: o.machineFile };
  let ext;
  try { ext = listRegistered(extOpts).find((e) => isInside(abs, e.root)); } catch (e) { return { error: 'dang ky ext khong doc duoc: ' + String(e && e.message || e).slice(0, 80), declared: decl }; }
  if (!ext) return { error: 'resolver khong thuoc ext da dang ky', declared: decl };
  const hashes = fileHashes(abs, ext.root); // hash TRUOC buoc tin cay; loadNodeHook hash lai ngay truoc require (chong doi file giua kiem va nap)
  const trusted = typeof o.trust === 'function' ? o.trust(ext.id, { ...extOpts, root: ext.root }) : isExtensionTrusted(ext.id, { ...extOpts, root: ext.root });
  if (!trusted) return { error: `ext "${ext.id}" chua duyet hash hoac lech hash`, declared: decl };
  return { abs, extId: ext.id, declared: decl, hashes };
}

/** Nap hook (dong bo, cache). -> { mod|null, abs?, error?, source: 'hook'|'none'|'skipped'|'error' } */
export function loadNodeHook(opts = {}) {
  const o = opts || {};
  const env = o.env || process.env;
  let root = ''; try { root = path.resolve(o.root || workspaceRoot({ env, repoDir: o.repoDir })); } catch { /* khong co */ }
  const key = `${root}|${env.HUB_DATA_DIR || ''}|${o.projectResolver || ''}`;
  if (!o.nocache && cache.has(key)) return cache.get(key);
  let res;
  try {
    const p = resolveResolverPath(o);
    if (p.none) res = { mod: null, source: p.why ? 'skipped' : 'none' };
    else if (p.error) { warnOnce(o, p.error, p.declared); res = { mod: null, source: 'error', error: p.error }; }
    else {
      const bad = hashMismatch(p.hashes);
      if (bad) { const msg = 'file resolver doi giua luc kiem va nap, tu choi: ' + path.basename(bad); warnOnce(o, msg, p.declared); res = { mod: null, source: 'error', error: msg }; }
      else {
      const mod = (typeof o.load === 'function' ? o.load : nodeRequire)(p.abs);
      res = { mod: mod && typeof mod === 'object' ? mod : null, abs: p.abs, source: 'hook' };
      }
    }
  } catch (e) {
    const msg = 'nap resolver loi: ' + String(e && e.message || e).slice(0, 120);
    warnOnce(o, msg); res = { mod: null, source: 'error', error: msg };
  }
  if (!o.nocache) cache.set(key, res);
  return res;
}

/** Workspace du lieu cua nut. Khong hook / loi / ket qua khong an toan -> chinh node id (da loc ky tu). Khong bao gio nem. */
export function workspaceFor(node, opts = {}) {
  const id = sanitize(node);
  try {
    const { mod } = loadNodeHook(opts);
    if (mod && typeof mod.workspaceFor === 'function') {
      const ws = mod.workspaceFor(node);
      if (ws === null || ws === undefined) return id;
      if (isSafeWs(ws)) return ws;
      warnOnce(opts || {}, `workspaceFor(${id}) tra gia tri khong an toan, dung node id`, id);
    }
  } catch (e) { warnOnce(opts || {}, 'workspaceFor loi: ' + String(e && e.message || e).slice(0, 100), id); }
  return id;
}

/** Danh sach nut [{id, workspace}] (loc: id an toan; workspace an toan hoac = id). Khong hook / loi -> []. Khong bao gio nem. */
export function listNodes(opts = {}) {
  try {
    const { mod } = loadNodeHook(opts);
    if (!mod || typeof mod.listNodes !== 'function') return [];
    const raw = mod.listNodes();
    if (!Array.isArray(raw)) { warnOnce(opts || {}, 'listNodes khong tra mang, bo'); return []; }
    const out = [];
    for (const n of raw) {
      if (!n || typeof n !== 'object' || !isSafeWs(n.id)) { warnOnce(opts || {}, 'listNodes: bo muc id khong an toan'); continue; }
      out.push({ id: n.id, workspace: n.workspace == null ? n.id : isSafeWs(n.workspace) ? n.workspace : n.id });
    }
    return out;
  } catch (e) { warnOnce(opts || {}, 'listNodes loi: ' + String(e && e.message || e).slice(0, 100)); return []; }
}

/**
 * Nut hook cho CLI/lenh du lieu (orphan-ws, archive...): MOI loi goi hook di qua day de luon co goc workspace (opts.root | CLAUDE_PROJECT_DIR | cwd), khong bao gio goc ma.
 * -> mang nut | null (khong cau hinh hook / hook thieu listNodes). Co projectResolver khai bao ma khong nap duoc -> 1 dong `data-warn rule=hook` (khong im lang).
 */
export function hookNodes(opts = {}) {
  const o = { ...(opts || {}) };
  const env = o.env || process.env;
  let root = ''; try { root = path.resolve(o.root || workspaceRoot({ env, repoDir: o.repoDir })); o.root = root; } catch { /* khong co */ }
  try {
    const nh = loadNodeHook(o);
    if (nh.mod && typeof nh.mod.listNodes === 'function') return listNodes(o);
    const declared = root ? declaredResolver(o, root) : null;
    if (declared) {
      const why = nh.source === 'hook' ? 'resolver khong export listNodes' : nh.source === 'skipped' ? 'HUB_DATA_DIR ghi de' : (nh.error || nh.source);
      const key = `hook|${root}|${why}`;
      if (!warned.has(key)) {
        warned.add(key);
        const line = `data-warn rule=hook path=${declared} detail=${why} fix=kiem tra projectResolver, hash ext (harness ext verify) va HUB_DATA_DIR`;
        if (typeof o.warn === 'function') o.warn(line); else console.error(line);
      }
    }
  } catch { /* fail-open */ }
  return null;
}

/** Test: xoa cache + bo nho canh bao. */
export function resetNodeHook() { cache.clear(); warned.clear(); }
