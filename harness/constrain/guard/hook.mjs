// guard (PreToolUse, Bash/PowerShell): chan lenh doc/thao tac DB (best-effort, chi xet text lenh). Fail-open tuyet doi.
// Policy la DATA trong hook.config.json; them mau = 1 muc JSON + 1 dong test.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadFlat as loadConfig, loadConfig as coreLoadConfig, pluginLayerDirs } from '../../core/config/config.mjs';
import { isPluginMode } from '../../core/io/paths.mjs';
import { isMain, writeOut } from '../../core/io/stdio.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS = { mode: 'enforce', logFile: '', maxInputBytes: 1048576, maxCommandChars: 100000, remoteHostAliases: [], sensitiveFileNames: [], allowlist: [], denyPatterns: [], hardTimeoutMs: 2500 };
export const HUB_ROOT = path.resolve(HERE, '..', '..', '..');
const LEGACY_LOCAL = path.join(HERE, 'hook.config.local.json');
/** Local: <hubRoot>/config/guard/guard.local.json; neu thieu thi roi ve duong cu trong harness (chuyen tiep, canh bao legacy-local-config). */
export const configFiles = (hubRoot = HUB_ROOT) => {
  const nl = path.join(hubRoot, 'config', 'guard', 'guard.local.json');
  return [path.join(HERE, 'hook.config.json'), !fs.existsSync(nl) && fs.existsSync(LEGACY_LOCAL) ? LEGACY_LOCAL : nl];
};
/** git push pha huy: --force/-f/--force-with-lease/--mirror/--delete/-d/+refspec/:branch (chi nhom nay; push thuong khong chan). Phai khop regex trong hook.config.json. */
const GIT_FORCE_PUSH_REGEX = String.raw`\bgit(?:\.exe)?["']?\s+(?:(?!["']?push\b)[^;&|\n\s]+\s+){0,12}["']?push\b(?:\s+[^;&|\n\s]+){0,40}?\s+(?:[\\"']*(?:-[a-z]*[fd][a-z]*(?=[\s"'\x60);&|>]|$)|--(?:force(?!-if-includes)|mirr\w*|del\w*|prune))|(?:["'\\]*[+:]\S|[^;&|\n\s]*:\+))|\bgit(?:\.exe)?["']?\s+(?:[^;&|\n\s]+\s+){0,12}?-c\s+["']?alias\.[^\s=]*=["']?push\b(?:\s+[^;&|\n\s]+){0,40}?\s+(?:[\\"']*(?:-[a-z]*[fd][a-z]*(?=[\s"'\x60);&|>]|$)|--(?:force(?!-if-includes)|mirr\w*|del\w*|prune))|(?:["'\\]*[+:]\S|[^;&|\n\s]*:\+))|\bgit(?:\.exe)?["']?\s+(?:[^;&|\n\s]+\s+){0,12}?-c\s+["']?remote\.[^\s=]*\.push=["']?\+|\bgit(?:\.exe)?\s+send-pack\b(?:\s+[^;&|\n\s]+){0,40}?\s+--force`;
/** Luat loi du phong cung (khi hook.config.json hong/thieu): cac luat DB + git-force-push. */
export const FALLBACK_CORE_RULES = [
  { id: 'mongo-cli', regex: '\\b(mongosh|mongodump|mongoexport|mongoimport|mongorestore|mongostat)\\b|\\bmongo\\s', reason: 'Cam mongo shell/tools. / Mongo CLI blocked.' },
  { id: 'mongo-uri', regex: 'mongodb(\\+srv)?://', reason: 'Cam chuoi ket noi MongoDB. / MongoDB connection string blocked.' },
  { id: 'mongo-driver', regex: 'mongoose\\s*\\.\\s*(connect|createConnection)|\\bMongoClient\\b', reason: 'Cam ket noi DB bang driver. / DB driver connect blocked.' },
  { id: 'db-cli-remote', remote: true, regex: '\\b(psql|mysql|redis-cli)\\b', reason: 'Cam db client tren host tu xa. / DB client over ssh blocked.' },
  { id: 'git-force-push', regex: GIT_FORCE_PUSH_REGEX, reason: 'Cam git push --force/-f/--force-with-lease/--mirror/--delete/+refspec/:nhanh (ghi de/xoa lich su tu xa). Hoi human, khong tu push. / Destructive git push blocked; ask the human.' },
];
const PACK_KEYS =new Set(['remoteHostAliases', 'sensitiveFileNames', 'denyPatterns', 'allowlist']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Noi theo id: trung id thi lop sau thang; disable:true tat ro rang. protect = id loi: lop goi khong duoc ghi de/tat (bo qua + canh bao). */
function mergeById(base, over, protect, warn) {
  const out = [...base];
  for (const r of over) {
    if (!isObj(r)) continue;
    if (protect && r.id && protect.has(r.id)) { if (warn) warn('goi du an: id luat loi "' + r.id + '" khong duoc ghi de/tat, bo qua'); continue; }
    const i = r.id ? out.findIndex((x) => x.id === r.id) : -1;
    if (i >= 0) out[i] = r; else out.push(r);
  }
  return out.filter((r) => !r.disable);
}
const norm = (rules) => (Array.isArray(rules) ? rules : []).filter(isObj).map((r) => (r.pattern !== undefined && r.regex === undefined ? { ...r, regex: r.pattern } : r));
const union = (a, b) => [...new Set([...(a || []), ...(Array.isArray(b) ? b : [])])];
const ESC = /[.*+?^${}()|[\]\\]/g;

/** Luat config-dump sinh tu sensitiveFileNames (+ .env). */
function sensitiveRule(names) {
  if (!names.length) return null;
  const alt = names.map((n) => String(n).replace(ESC, '\\$&')).join('|');
  const regex = '\\b(cat|type|Get-Content|gc|less|more|bat|sed\\s+-n|head|tail)\\b[^|;&\\n]*(' + alt + '|(^|[\\\\/\\s\'"])\\.env(\\.\\w+)?\\b)';
  return { id: 'config-dump', regex, unless: '\\|\\s*(sha256sum|md5sum|shasum|wc)\\b', reason: 'Cam in noi dung file cau hinh/app (co the lo chuoi ket noi). Dung sha256sum/wc/grep -n co gioi han. / Config dump blocked; use sha256sum, wc, bounded grep -n.' };
}

/** Qua core loadConfig (D3): loi (files[0]) < may (files[1..], config/guard/local.json; duy nhat tat duoc luat loi) < du an (config/guard/projects/<id>.json, chi PACK_KEYS) < env. Khong suy tu cwd. -> {config, warnings} */
export function load(files = configFiles(), opts = {}) {
  const warnings = [];
  const env = opts.env || process.env;
  const hubRoot = opts.hubRoot || HUB_ROOT;
  let cfg = { ...DEFAULTS };
  let deny = [], allow = [], aliases = [], names = [];
  const pile = (c) => {
    const { denyPatterns, allowlist, remoteHostAliases, sensitiveFileNames, ...scalars } = c;
    cfg = { ...cfg, ...scalars };
    deny = mergeById(deny, norm(denyPatterns)); allow = mergeById(allow, norm(allowlist));
    aliases = union(aliases, remoteHostAliases); names = union(names, sensitiveFileNames);
  };
  if (files.includes(LEGACY_LOCAL)) warnings.push('legacy-local-config: chuyen ' + LEGACY_LOCAL + ' sang config/guard/guard.local.json');
  const read = (f, quiet) => { const l = loadConfig({ defaults: {}, files: [f] }); if (!quiet) warnings.push(...l.warnings); return l.config; };
  const layers = files.map((f) => read(f));
  // Tang may (D3): files[1..] + config/guard/local.json; nap vao 'defaults' cua loader (duoi du an) + bia mo (tombstone) cho luat tat o may.
  // File may chuan (config/guard/local.json, guard.local.json) do core tu nap (khong nap 2 lan); chi file tuy chon khac moi vao defaults.
  const gdir = path.join(hubRoot, 'config', 'guard');
  const std = [path.join(gdir, 'local.json'), path.join(gdir, 'guard.local.json')].map((p) => path.resolve(p));
  const extra = files.slice(1).map((f, i) => ({ f, c: layers[i + 1] }));
  const stdRaw = std.filter((p) => !files.slice(1).some((f) => path.resolve(f) === p)).map((p) => read(p, true));
  const plugMachine = isPluginMode(opts.repoDir || hubRoot) ? [read(path.join(pluginLayerDirs({ env, repoDir: opts.repoDir || hubRoot }).machineDir, 'guard', 'local.json'), true)] : [];
  const machine = [...extra.map((e) => e.c), ...stdRaw, ...plugMachine];
  const viaDefaults = extra.filter((e) => !std.includes(path.resolve(e.f))).map((e) => e.c);
  const lscal = machine.reduce((a, c) => ({ ...a, ...c }), {});
  const tomb = new Set();
  for (const m of machine) for (const k of ['denyPatterns', 'allowlist']) for (const r of Array.isArray(m[k]) ? m[k] : []) if (isObj(r) && r.id && r.disable) tomb.add(r.id);
  let coreLayer = layers[0] || {};
  if (!Array.isArray(coreLayer.denyPatterns) || !coreLayer.denyPatterns.some((x) => isObj(x) && x.id)) {
    warnings.push('core-config-fallback: hook.config.json hong/thieu, dung luat loi du phong trong code');
    coreLayer = { ...coreLayer, denyPatterns: FALLBACK_CORE_RULES };
  }
  pile(coreLayer);
  const coreDeny = deny.map((r) => r.id).filter(Boolean), coreAllow = allow.map((r) => r.id).filter(Boolean);
  for (const m of viaDefaults) pile(m);
  const defaults = { ...cfg, denyPatterns: deny, allowlist: allow, remoteHostAliases: aliases, sensitiveFileNames: names };
  const plugMode = isPluginMode(opts.repoDir || hubRoot) && !env.GUARD_PROJECT;
  const project = plugMode ? 'project' : String(env.GUARD_PROJECT || lscal.project || '').trim();
  // env loc: HARNESS_GUARD_* va HARNESS_CONFIG_DIR khong duoc anh huong guard; chi GUARD_MODE/GUARD_LOG_FILE/GUARD_PROJECT (xu ly rieng).
  const fenv = {}; for (const [k, v] of Object.entries(env)) if (!/^HARNESS_GUARD_/i.test(k) && !/^HARNESS_CONFIG_DIR$/i.test(k)) fenv[k] = v;
  const base = { defaults, root: hubRoot, configDir: path.join(hubRoot, 'config'), env: fenv, repoDir: opts.repoDir, skipProjectLayer: true, protect: { denyPatterns: { ids: coreDeny }, allowlist: { ids: coreAllow } } };
  const b = coreLoadConfig('guard', base);
  let r = b;
  if (project) {
    if (!/^[\w.-]+$/.test(project)) warnings.push('goi du an: ten khong hop le "' + project + '", bo qua');
    else {
      const gd = path.join(hubRoot, 'config', 'guard');
      if (!plugMode && !fs.existsSync(path.join(gd, 'projects', project + '.json')) && !fs.existsSync(path.join(gd, project + '.json'))) warnings.push('goi du an "' + project + '" thieu: ' + path.join(gd, 'projects', project + '.json') + '; chi ap luat chung');
      r = coreLoadConfig('guard', { ...base, project: plugMode ? undefined : project, skipProjectLayer: false });
    }
  }
  warnings.push(...r.warnings);
  cfg = { ...r.config };
  // Du an chi duoc dong goi luat (PACK_KEYS); khoa vo huong khac (mode, maxCommandChars...) bi hoan nguyen.
  if (r !== b) {
    const dropped = new Set();
    for (const [k, src] of Object.entries(r.sources)) {
      const top = k.split('.')[0];
      if (String(src).startsWith('project:') && !PACK_KEYS.has(top)) dropped.add(top);
    }
    for (const k of dropped) { if (k in b.config) cfg[k] = b.config[k]; else delete cfg[k]; warnings.push('goi du an "' + project + '": khoa la "' + k + '" bi bo qua'); }
  }
  // allowlist cua du an: bat buoc co `for` (mang id khong rong), khong tro toi id luat loi; sai thi bo + canh bao (chi id).
  if (r !== b) {
    const had = new Set((b.config.allowlist || []).map((x) => JSON.stringify(x)));
    const core = new Set(coreDeny);
    cfg.allowlist = (cfg.allowlist || []).filter((a) => {
      if (had.has(JSON.stringify(a))) return true;
      const ok = isObj(a) && Array.isArray(a.for) && a.for.length > 0 && a.for.every((x) => typeof x === 'string' && !core.has(x));
      if (!ok) warnings.push('goi du an "' + project + '": allowlist "' + String(a && a.id) + '" thieu/sai "for" hoac tro toi luat loi, bo');
      return ok;
    });
  }
  aliases = union(b.config.remoteHostAliases, cfg.remoteHostAliases); names = union(b.config.sensitiveFileNames, cfg.sensitiveFileNames);
  deny = norm(cfg.denyPatterns).filter((x) => !tomb.has(x.id)); allow = norm(cfg.allowlist).filter((x) => !tomb.has(x.id));
  const sr = sensitiveRule(names);
  if (sr) deny = [sr, ...deny.filter((x) => x.id !== 'config-dump')];
  cfg = { ...cfg, denyPatterns: deny, allowlist: allow, remoteHostAliases: aliases, sensitiveFileNames: names };
  if (env.GUARD_MODE) cfg.mode = env.GUARD_MODE;
  if (env.GUARD_LOG_FILE) cfg.logFile = env.GUARD_LOG_FILE;
  return { config: cfg, warnings };
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rx = (s) => { try { return new RegExp(s, 'i'); } catch { return null; } };

/** -> {id, reason} cua mau dau tien khop, hoac null. */
export function evaluate(cmd, cfg) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  if (cmd.length > (cfg.maxCommandChars ?? 100000)) return { id: 'command-too-long', reason: 'Lenh qua dai (> maxCommandChars), khong the kiem; chia nho. / Command too long to inspect; split it.' };
  const ncmd = cmd.replace(/\\\r?\n|\x60\r?\n/g, ' '); // noi dong (\ hoac backtick + xuong dong) truoc khi so khop
  const aliases = (cfg.remoteHostAliases || []).map(esc).join('|');
  const remote = new RegExp(`\\b(ssh|scp|sftp|rsync)\\b${aliases ? `|\\b(${aliases}):` : ''}`, 'i').test(cmd);
  for (const p of cfg.denyPatterns || []) {
    if (!p || !p.id) continue;
    if (p.remote && !remote) continue;
    const re = rx(p.regex);
    if (!re || !re.test(ncmd)) continue;
    if (p.unless) { const u = rx(p.unless); if (u && u.test(cmd)) continue; }
    const allowed = (cfg.allowlist || []).some((a) => (!a.for || a.for.includes(p.id)) && rx(a.regex)?.test(cmd));
    if (allowed) continue;
    return { id: p.id, reason: p.reason || 'blocked by guard' };
  }
  return null;
}

/** Lay lenh tu input Claude (Bash/PowerShell) hoac agy (run_command). -> {cmd, tool, agy} | null */
function extract(inp) {
  if (!inp || typeof inp !== 'object' || Array.isArray(inp)) return null;
  if (inp.tool_name === 'Bash' || inp.tool_name === 'PowerShell') {
    const c = inp.tool_input && inp.tool_input.command;
    return { cmd: typeof c === 'string' ? c : '', tool: inp.tool_name, agy: false };
  }
  const tc = inp.toolCall;
  if (tc && tc.name === 'run_command' && tc.args) return { cmd: typeof tc.args.CommandLine === 'string' ? tc.args.CommandLine : '', tool: 'run_command', agy: true };
  return null;
}

/** Quyet dinh thuan -> {out, entry|null}. */
export function decide(inp, cfg) {
  const x = extract(inp);
  if (!x) return { out: {}, entry: null };
  const hit = evaluate(x.cmd, cfg);
  const audit = cfg.mode === 'audit';
  const base = { out: x.agy ? { decision: 'allow' } : {}, entry: null };
  if (!hit) return base;
  const entry = { id: hit.id, tool: x.tool, mode: cfg.mode, action: audit ? 'would-block' : 'block', hash: crypto.createHash('sha256').update(x.cmd).digest('hex').slice(0, 16), len: x.cmd.length }; // khong ghi noi dung lenh (co the chua secret): chi hash + do dai + id luat
  if (audit) return { out: base.out, entry };
  const reason = `guard[${hit.id}]: ${hit.reason}`;
  const out = x.agy ? { decision: 'deny', reason } : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  return { out, entry };
}

async function logFile(cfg) {
  if (cfg.logFile) return cfg.logFile;
  const m = await import('../../core/audit/audit-write.mjs');
  return path.join(m.auditRoot(), 'guard', `guard-${new Date().toISOString().slice(0, 10)}.jsonl`);
}
export async function log(entry, cfg) {
  try {
    const f = await logFile(cfg);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), hook: 'guard', ...entry }) + '\n');
  } catch {}
}

function readStdin(max, ms) {
  return new Promise((resolve) => {
    let buf = ''; let over = false; let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const t = setTimeout(() => fin({ err: 'timeout' }), ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { if (buf.length + d.length > max) over = true; else buf += d; });
    process.stdin.on('end', () => {
      clearTimeout(t);
      if (over) return fin({ err: 'oversize' });
      try { fin({ inp: JSON.parse(buf.replace(/^﻿/, '') || '{}') }); } catch { fin({ err: 'badjson' }); }
    });
    process.stdin.on('error', () => fin({ err: 'stdin' }));
  });
}

/**
 * Module hook (contract HOOK_MODULE). handle(event, input, ctx) -> Promise<{decision?, reason?}>; KHONG ghi stdout/exit.
 * Ket qua: {} = khong y kien; {decision:'deny', reason:'guard[id]: ...'} = chan; input agy (toolCall.run_command) khong khop luat -> {decision:'allow'} (nghia cu cua agy).
 * Fail-open: moi loi noi bo -> {}. Nhat ky guard (hit/config-warning) tra qua `records` ([{sink:'guard', data}]); chi tu ghi khi ctx.write !== false.
 * ctx (tuy chon): {config (da nap, bo qua load), hubRoot, env, write}. event hien khong dung (guard chi xet tool_name/toolCall).
 */
export async function handle(event, input, ctx = {}) {
  const records = [];
  const emit = async (entry, cfg) => { records.push({ sink: 'guard', data: { ts: new Date().toISOString(), hook: 'guard', ...entry } }); if (!ctx || ctx.write !== false) await log(entry, cfg); };
  const done = (r) => (records.length ? { ...r, records } : r);
  try {
    let cfg = ctx && ctx.config;
    if (!cfg) {
      const L = load(undefined, { hubRoot: ctx && ctx.hubRoot, env: ctx && ctx.env });
      cfg = L.config;
      for (const w of L.warnings) await emit({ id: 'config-warning', action: w.slice(0, 200) }, cfg);
    }
    const d = decide(input, cfg);
    if (d.entry) await emit(d.entry, cfg);
    const o = d.out || {};
    const hso = o.hookSpecificOutput;
    if (hso && hso.permissionDecision) return done({ decision: hso.permissionDecision, reason: hso.permissionDecisionReason });
    if (o.decision) return done(o.reason === undefined ? { decision: o.decision } : { decision: o.decision, reason: o.reason });
    return done({});
  } catch { return done({}); }
}

const META = { id: 'guard', events: ['PreToolUse'], tools: /^(Bash|PowerShell|run_command)$/, timeoutMs: 2500, onError: 'open' };
/** Alias cu (test). Chuan dispatcher la export default. */
export const hookModule = Object.freeze({ ...META, handle });
/** Chuan HOOK_MODULE: async handle(event, input, ctx). */
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });

/** Ket qua handle -> JSON stdout nhu ban cu (vo mong; dispatcher co cach render rieng). */
export function toOutput(result, input) {
  const r = result || {};
  if (!r.decision) return {};
  const tc = input && input.toolCall;
  if (tc && tc.name === 'run_command' && tc.args) return r.reason === undefined ? { decision: r.decision } : { decision: r.decision, reason: r.reason };
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: r.decision, permissionDecisionReason: r.reason } };
}

async function main() {
  let out = {};
  try {
    const L = load(); const cfg = L.config;
    for (const w of L.warnings) await log({ id: 'config-warning', action: w.slice(0, 200) }, cfg);
    const r = await readStdin(cfg.maxInputBytes, cfg.hardTimeoutMs);
    if (r.err) await log({ id: 'fail-open', action: r.err }, cfg);
    else out = toOutput(await handle('PreToolUse', r.inp, { config: cfg, write: true }), r.inp);
  } catch { out = {}; }
  writeOut(JSON.stringify(out));
}

if (isMain(import.meta.url)) { main().then(() => process.exit(0), () => process.exit(0)); }
