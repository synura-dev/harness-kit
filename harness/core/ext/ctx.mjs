// ctx cap cho external (mo rong ngoai core). Chay TRONG TIEN TRINH CON (ext-runner); khong phai co che cach ly.
// Moi ghi qua ctx tu gan source 'ext:<id>' va chi vao zone workspaces/<id>/ de observe/evolve doc duoc.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { workspaceRoot, dataRoot, isInside } from '../io/paths.mjs';
import { dataPathFor as rawDataPathFor, guardWrite, writeJson, readJson, appendJsonl } from '../io/storage.mjs';
import { emit, parseCommon } from '../io/out.mjs';
import { queryRecords, appendRecords } from '../io/jsonl-store.mjs';
import { runsDir, runsReadDirs, logPath, safeId } from '../io/safe-id.mjs';
import { dataReadRoots, ZONES, CLASSES, pickNodeRead, formatWarn } from '../registry/data-registry.mjs';
import { workspaceFor, isSafeWs } from '../io/node-hook.mjs';
import * as worktree from '../runtime/worktree.mjs';
import { loadAgents } from '../agy/agents.mjs';
import { writeEnvelope, auditRoot } from '../audit/audit-write.mjs';
import { fingerprint } from '../audit/fingerprint.mjs';
import { loadConfig, pluginLayerDirs } from '../config/config.mjs';
import { isPluginMode } from '../io/paths.mjs';

export const CTX_VERSION = '1.1.0';
const EXT_ZONE = 'workspaces';
const extSource = (id) => `ext:${safeId(id, 60)}`;

// Kiem requires.ctx dang '^1' / '1' / '^1.0.0': chi so major phai khop.
export function ctxCompatible(req) {
  if (req === undefined || req === null) return true;
  const m = /^\^?(\d+)/.exec(String(req).trim());
  return !!m && Number(m[1]) === Number(CTX_VERSION.split('.')[0]);
}

/** Ghi su kien audit cua external (envelope v2, type 'ext'). KHONG nem. ok=false + error => evolve candidates thay. */
export function auditExt(extId, ev = {}, opts = {}) {
  try {
    const id = safeId(extId, 60) || 'unknown';
    const src = extSource(id);
    const error = ev.error ? String(ev.error).slice(0, 300) : null;
    const env = {
      v: 2, ts: new Date().toISOString(), type: 'ext', event: ev.event || 'ext', cli: 'ext', sid: `ext-${id}`,
      agent_id: null, agent_type: null, actor: 'ext', project: null, cwd: '', tool: src, target: ev.target ?? null, target_kind: null,
      ok: typeof ev.ok === 'boolean' ? ev.ok : null, dur_ms: ev.ms ?? null, turns: null, tokens_in: null, tokens_out: null,
      status: ev.status || (ev.ok === false ? 'ext-fail' : 'ext-ok'), model: null, source: src,
      summary: String(ev.summary || error || ev.status || '').slice(0, 120),
      data: { ...(error ? { error, error_fp: ev.fp || fingerprint(error, src) } : {}), ...(ev.data && typeof ev.data === 'object' ? ev.data : {}) },
      origin: null,
    };
    writeEnvelope(env, {}, opts.root || auditRoot());
    return true;
  } catch { return false; }
}

/**
 * Chuan hoa manifest.data: [{path|zone, class, retentionDays?, tool}] -> [{key, abs, zone, rel, class, retentionDays, tool}].
 * zone+path => <dataRoot>/<zone>/<path>; chi path => <dataRoot>/<path>; chi zone => <dataRoot>/<zone>/<extId>. Muc sai bi bo, tra kem errors.
 */
/** data[].legacy: ten cu (tuong doi data/), segment an toan, khong '..'; sai -> null. */
const legacyOf = (l) => { if (typeof l !== 'string' || !l || path.isAbsolute(l)) return null; const s = l.split(/[\\/]/).filter(Boolean); return s.length && !s.some((x) => x === '.' || x === '..') ? s.join('/') : null; };
export function normalizeDataEntries(list, extId, dRoot = dataRoot()) {
  const out = []; const errors = [];
  if (!Array.isArray(list)) return { entries: out, errors };
  for (const e of list) {
    try {
      if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error('muc data phai la object');
      if (e.zone !== undefined && !ZONES.includes(e.zone)) throw new Error('zone khong hop le');
      if (e.class !== undefined && !CLASSES.includes(e.class)) throw new Error('class khong hop le');
      if (e.path === undefined && e.zone === undefined) throw new Error('can path hoac zone');
      if (e.path === undefined && e.zone === 'workspaces') {
        // Mau workspaces/*/<tool> (khong path): thieu tool => loi, khong ghi nham vao workspaces/<extId>.
        const tl = e.tool === undefined ? '' : String(e.tool);
        if (!isSafeWs(tl)) throw new Error('zone workspaces khong path can tool an toan');
        out.push({ key: tl, abs: path.join(dRoot, 'workspaces'), pattern: true, zone: 'workspaces', rel: `workspaces/*/${tl}`, class: e.class || null, retentionDays: e.retentionDays ?? null, tool: tl, legacy: legacyOf(e.legacy) });
        continue;
      }
      const segs = (e.path === undefined ? [extId] : String(e.path).split(/[\\/]/)).filter(Boolean);
      if (!segs.length || segs.some((x) => x === '.' || x === '..') || path.isAbsolute(String(e.path ?? ''))) throw new Error('path khong hop le');
      const rel = [...(e.zone ? [e.zone] : []), ...segs].join('/');
      const tool = e.tool ? String(e.tool) : segs[segs.length - 1];
      out.push({ key: tool, abs: path.join(dRoot, ...rel.split('/')), zone: e.zone || null, rel, class: e.class || null, retentionDays: e.retentionDays ?? null, tool, legacy: legacyOf(e.legacy) });
    } catch (err) { errors.push(String(err.message)); }
  }
  return { entries: out, errors };
}

// Khoa nhay cam: external KHONG duoc dat/nhan tu lop du an hay qua ctx.config (giu 0fe94d1).
export const CONFIG_DENY_KEYS = Object.freeze(['extRoots', 'extensions', 'projectResolver', 'ownerRoots']);
const isO = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const BADK = new Set(['__proto__', 'constructor', 'prototype']);
const deepMerge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b)) { if (BADK.has(k)) continue; o[k] = isO(v) && isO(o[k]) ? deepMerge(o[k], v) : v; } return o; };

/**
 * ctx.config(tool, {defaults, projectAllow:[khoa], env, root}) -> {config, warnings}. Nap config lop may (loader loi) + lop du an CHI voi khoa
 * trong projectAllow (tru CONFIG_DENY_KEYS luon bi chan o lop du an). Khong throw. warnings chi chua ten khoa.
 */
export function loadExtConfig(tool, opts = {}, workspace = null) {
  const warnings = [];
  try {
    const root = opts.root || workspace || workspaceRoot();
    const env = opts.env || process.env;
    const r = loadConfig(tool, { defaults: opts.defaults, root, configDir: opts.configDir || path.join(root, 'config'), env, skipProjectLayer: true, ...(opts.project !== undefined ? { project: opts.project } : {}) });
    warnings.push(...r.warnings);
    let config = r.config;
    if (isPluginMode()) {
      const { projectDir } = pluginLayerDirs({ env });
      let pj = null;
      try { if (projectDir) pj = JSON.parse(fs.readFileSync(path.join(projectDir, safeId(tool, 60), 'project.json'), 'utf8')); } catch { /* khong co lop du an */ }
      if (isO(pj)) {
        const allow = new Set(Array.isArray(opts.projectAllow) ? opts.projectAllow.map(String) : []);
        const kept = {};
        for (const k of Object.keys(pj)) { if (allow.has(k) && !CONFIG_DENY_KEYS.includes(k) && !BADK.has(k)) kept[k] = pj[k]; else warnings.push(`project.json: khoa "${k}" khong duoc phep o lop du an, bo`); }
        config = deepMerge(config, kept);
      }
    }
    return { config, warnings };
  } catch { return { config: isO(opts.defaults) ? { ...opts.defaults } : {}, warnings: [...warnings, 'loi noi bo'] }; }
}

export function buildCtx({ extId, extRoot = null, workspace = null, caps = ['worktree', 'agents', 'runs'], data = null } = {}) {
  const id = safeId(extId, 60);
  if (!id) throw new Error('ctx: thieu extId');
  const src = extSource(id);
  const zoneRoot = () => path.join(dataRoot(), EXT_ZONE, id);
  // Du lieu khai bao trong manifest (data[]): ngoai zone mac dinh, ghi duoc CHI trong cac muc nay. HARNESS_EXT_ALLOW_WRITE (nguoi van hanh, ';' ngan cach) cho them duong dan tuyet doi tuong minh.
  const declared = normalizeDataEntries(data, id).entries;
  const extra = String(process.env.HARNESS_EXT_ALLOW_WRITE || '').split(';').map((x) => x.trim()).filter((x) => x && path.isAbsolute(x)).map((x) => path.resolve(x));
  const roots = () => [zoneRoot(), ...declared.filter((d) => !d.pattern).map((d) => d.abs), ...extra];
  // Muc mau: chi duoc ghi trong workspaces/<ws an toan>/<tool da khai bao>/..., KHONG ca workspaces/.
  const patTools = declared.filter((d) => d.pattern).map((d) => d.tool);
  const inPattern = (p) => { if (!patTools.length) return false; const rel = path.relative(path.join(dataRoot(), 'workspaces'), p); if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false; const s = rel.split(path.sep); return s.length >= 2 && isSafeWs(s[0]) && patTools.includes(s[1]); };
  const inZone = (f) => { const p = path.resolve(f); return roots().some((z) => p === z || isInside(p, z)) || inPattern(p); };
  const zonePath = (...parts) => {
    const out = path.join(zoneRoot(), ...parts.flatMap((p) => String(p).split(/[\\/]/).filter(Boolean)));
    if (!inZone(out) || parts.some((p) => String(p).split(/[\\/]/).includes('..'))) throw new Error('duong dan thoat khoi zone ext');
    return out;
  };
  const needZone = (f) => { if (!inZone(f)) throw new Error(`ghi ngoai zone workspaces/${id}/ va cac muc data khai bao bi chan`); };
  const legacyWarn = new Set();
  const warnLegacy = (key, rel, fix) => { if (legacyWarn.has(key)) return; legacyWarn.add(key); try { process.stderr.write(formatWarn({ rule: 'legacy-read', path: rel, key, detail: 'doc tu duong dan cu', fix }) + '\n'); } catch {} };
  // entryPath(key, ...parts[, {node, shared, mode:'read'|'write'}]): muc mau workspaces/*/<tool> can node; artifact theo nut <ws>/<tool>/<node>/..., ban ghi chung (shared) <ws>/<tool>/...
  // mode 'read': neu chua co duong dan moi thi doc legacy (cap <node>/ chua co hoac data[].legacy) kem canh bao 1 lan/key. Ghi luon duong dan moi.
  const entryPath = (key, ...rest) => {
    let o = {};
    if (rest.length && rest[rest.length - 1] && typeof rest[rest.length - 1] === 'object') o = rest.pop();
    const d = declared.find((x) => x.key === key);
    if (!d) throw new Error(`ext ${id}: chua khai bao data '${key}' trong manifest`);
    if (rest.some((p) => String(p).split(/[\\/]/).includes('..'))) throw new Error('duong dan thoat khoi muc data');
    const segs = rest.flatMap((p) => String(p).split(/[\\/]/).filter(Boolean));
    const dr = dataRoot();
    if (d.pattern) {
      if (o.node === undefined || o.node === null) throw new Error(`ext ${id}: data '${key}' theo mau ${d.rel}: can {node}`);
      const node = String(o.node);
      if (!isSafeWs(node)) throw new Error(`node khong hop le: ${node}`);
      const base = `workspaces/${workspaceFor(node, workspace ? { root: workspace } : {})}/${d.tool}`;
      const r = { rel: o.shared ? base : `${base}/${node}`, legacyRels: [...(o.shared ? [] : [base]), ...(d.legacy ? [d.legacy] : [])] };
      let use = r.rel;
      if (o.mode === 'read') { const p = pickNodeRead(r, segs, dr); use = p.rel; if (p.legacy) warnLegacy(key, p.rel, `ghi moi vao ${r.rel}`); }
      return path.join(dr, ...use.split('/'), ...segs);
    }
    const out = path.join(d.abs, ...segs);
    if (o.mode === 'read' && d.legacy && !fs.existsSync(out)) {
      const lo = path.join(dr, ...d.legacy.split('/'), ...segs);
      if (fs.existsSync(lo)) { warnLegacy(key, d.legacy, `chuyen thu cong ${d.legacy} -> ${d.rel}`); return lo; }
    }
    return out;
  };
  const tag = (r) => ({ ...r, source: src });
  const ctx = {
    version: CTX_VERSION, extId: id, source: src,
    paths: { workspaceRoot: () => workspace || workspaceRoot(), dataRoot, extRoot: () => extRoot },
    storage: {
      dataPathFor: zonePath,
      entryPath,
      guardWrite: (f) => { if (!inZone(f)) return { ok: false, warn: { rule: 'ext-zone' } }; return guardWrite(f); },
      writeJson: (f, o) => { needZone(f); return writeJson(f, o); },
      readJson,
      appendJsonl: (f, rec, o) => { needZone(f); return appendJsonl(f, tag(rec), o); },
    },
    extConfig: (name) => {
      if (!extRoot) return null;
      const n = safeId(name, 60);
      try { return JSON.parse(fs.readFileSync(path.join(extRoot, 'config', `${n}.json`), 'utf8')); } catch { return null; }
    },
    config: (tool, opts) => loadExtConfig(tool, opts, workspace),
    out: { emit, parseCommon },
    jsonl: {
      queryRecords,
      appendRecords: (f, recs, o) => { needZone(f); return appendRecords(f, (recs || []).map(tag), o); },
    },
    audit: { event: (ev) => auditExt(id, ev) },
    data: { dataReadRoots },
  };
  if (caps.includes('runs')) ctx.runs = { runsDir, runsReadDirs, logPath, safeId };
  if (caps.includes('worktree')) ctx.worktree = { create: worktree.createWorktree, remove: worktree.removeWorktree, ensure: worktree.ensureWorktree };
  if (caps.includes('agents')) ctx.agents = { loadAgents };
  return Object.freeze(ctx);
}

export const hash8 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
