// approval (PreToolUse, Bash/PowerShell): bac "ask" (push/deploy/migrate/ssh reload) va "deny" (force push, xoa de quy / >= nguong file / xoa hang loat).
// Luat la DATA trong approval.config.json; force push TAI DUNG luat git-force-push cua guard (doc config guard, khong chep regex).
// Chi import core. Loi noi bo / stdin hong / timeout -> {} (fail-open, ghi audit); guard van chan force push doc lap.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadHookConfig } from '../../core/config/config.mjs';
import { recordGate } from '../../core/audit/gate-event.mjs';
import { isObj } from '../../core/io/paths.mjs';
import { scanDeletes, RANK } from './analyze.mjs';
export { split } from './parse.mjs'; // test dung split qua hook.mjs

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HUB_ROOT = path.resolve(HERE, '..', '..', '..');
const CONFIG_FILE = path.join(HERE, 'approval.config.json');
export const DEFAULTS = { mode: 'enforce', maxInputBytes: 1048576, maxCommandChars: 100000, hardTimeoutMs: 2500, logAllow: false, reuseRules: [], askRules: [], delete: {} };
const DEL_DEFAULTS = { threshold: 10, unknownCount: 'ask', maxDirEntries: 5000, maxDepth: 3, posix: ['rm', 'unlink'], ps: ['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir'], cmd: ['del', 'erase', 'rd', 'rmdir'], dirOnly: ['rmdir', 'rd'], alwaysRecursive: ['rimraf', 'del-cli', 'trash', 'rmtree'], wrappers: ['sudo', 'env', 'command', 'nohup', 'time', 'timeout', 'exec', 'npx', 'bunx', 'pnpx', 'doas', 'nice', 'ionice', 'setsid', 'stdbuf', 'busybox', 'builtin'], shells: ['sh', 'bash', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd', 'wsl'] };
const toRegex = (s) => { try { return typeof s === 'string' && s ? new RegExp(s, 'i') : null; } catch { return null; } };

/** Nap config (core loadHookConfig: code < config/approval/{default,local}.json < env HARNESS_APPROVAL_*) + luat tai dung tu guard. -> {config, warnings} */
export function loadApproval(opts = {}) {
  const r = loadHookConfig('approval', { defaults: DEFAULTS, files: [opts.file || CONFIG_FILE], root: opts.hubRoot || HUB_ROOT, configDir: opts.configDir });
  const warnings = r.warnings.slice();
  const cfg = { ...DEFAULTS, ...r.config };
  cfg.delete = { ...DEL_DEFAULTS, ...(isObj(cfg.delete) ? cfg.delete : {}) };
  const deny = [];
  for (const ru of Array.isArray(cfg.reuseRules) ? cfg.reuseRules : []) {
    if (!isObj(ru) || typeof ru.file !== 'string') continue;
    let src = null;
    try { src = JSON.parse(fs.readFileSync(path.resolve(opts.hubRoot || HUB_ROOT, ru.file), 'utf8').replace(/^﻿/, '')); } catch { warnings.push('reuse-missing: ' + ru.file); continue; }
    for (const id of ru.ids || []) {
      const p = (src.denyPatterns || []).find((x) => isObj(x) && x.id === id);
      if (!p || !toRegex(p.regex || p.pattern)) { warnings.push('reuse-missing: ' + id); continue; }
      deny.push({ id, regex: p.regex || p.pattern, unless: p.unless, reason: p.reason || id, tier: ru.tier === 'ask' ? 'ask' : 'deny', from: ru.file });
    }
  }
  cfg.denyRules = deny;
  cfg.askRules = (Array.isArray(cfg.askRules) ? cfg.askRules : []).filter((x) => isObj(x) && x.id && !x.disable);
  return { config: cfg, warnings };
}

/** Luat regex (deny/ask) + quet xoa; lenh -EncodedCommand giai ma duoc thi danh gia lai du luat (sau <= 2). -> [hit] */
function collectHits(cmd, cfg, mode, cwd, depth) {
  const ncmd = cmd.replace(/\\\r?\n|\x60\r?\n/g, ' ');
  const hits = []; const extra = [];
  const test = (r, tier) => { const re = toRegex(r.regex); if (!re || !re.test(ncmd)) return; const u = toRegex(r.unless); if (u && u.test(ncmd)) return; hits.push({ tier, id: r.id, why: r.reason || r.id }); };
  for (const r of cfg.denyRules || []) test(r, r.tier || 'deny');
  hits.push(...scanDeletes(ncmd, mode, cwd, cfg.delete, 0, extra, false));
  for (const r of cfg.askRules || []) test(r, 'ask');
  if (depth < 2) for (const d of extra) hits.push(...collectHits(d, cfg, 'ps', cwd, depth + 1));
  return hits;
}

/** Danh gia lenh -> {tier:'none'|'ask'|'deny', id, reason, hits:[ids]} */
export function evaluateCommand(cmd, cfg, opts = {}) {
  const none = { tier: 'none', id: null, reason: '', hits: [] };
  if (typeof cmd !== 'string' || !cmd.trim()) return none;
  if (cmd.length > (cfg.maxCommandChars ?? 100000)) return { ...none, id: 'command-too-long' }; // guard chan lenh qua dai
  const hits = collectHits(cmd, cfg, opts.mode || 'bash', opts.cwd, 0);
  if (!hits.length) return none;
  const top = hits.reduce((a, h) => (RANK[h.tier] > RANK[a.tier] ? h : a));
  return { tier: top.tier, id: top.id, reason: top.why, hits: [...new Set(hits.map((h) => h.id))] };
}

/** Quyet dinh thuan -> {out, ev|null}; ev = su kien gate (kind "approval") cho core recordGate. Khong ghi noi dung lenh: chi hash + do dai. */
export function decideApproval(inp, cfg) {
  if (!isObj(inp) || (inp.tool_name !== 'Bash' && inp.tool_name !== 'PowerShell')) return { out: {}, ev: null };
  const cmd = inp.tool_input && typeof inp.tool_input.command === 'string' ? inp.tool_input.command : '';
  const r = evaluateCommand(cmd, cfg, { mode: inp.tool_name === 'PowerShell' ? 'ps' : 'bash', cwd: typeof inp.cwd === 'string' ? inp.cwd : '' });
  const audit = cfg.mode === 'audit';
  if (r.tier === 'none' && !cfg.logAllow) return { out: {}, ev: null };
  const target = `sha256:${crypto.createHash('sha256').update(cmd).digest('hex').slice(0, 16)} len=${cmd.length}${r.hits.length > 1 ? ' hits=' + r.hits.join(',') : ''}`;
  const ev = { kind: 'approval', hook: 'approval', decision: r.tier === 'none' || audit ? 'allow' : r.tier, tier: r.tier, rule: r.id, reason: audit && r.tier !== 'none' ? 'would-' + r.tier + ': ' + r.reason : r.reason, tool: inp.tool_name, target };
  if (r.tier === 'none' || audit) return { out: {}, ev };
  return { out: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: r.tier, permissionDecisionReason: `approval[${r.id}]: ${r.reason}` } }, ev };
}

const note = (rule, reason, ctx) => recordGate({ kind: 'approval', hook: 'approval', decision: 'allow', tier: 'none', rule, reason }, ctx || {});
function readStdin(max, ms) {
  return new Promise((resolve) => {
    let buf = ''; let over = false; let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const t = setTimeout(() => fin({ err: 'timeout' }), ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { if (buf.length + d.length > max) over = true; else buf += d; });
    process.stdin.on('end', () => { clearTimeout(t); if (over) return fin({ err: 'oversize' }); try { fin({ inp: JSON.parse(buf.replace(/^﻿/, '') || '{}') }); } catch { fin({ err: 'badjson' }); } });
    process.stdin.on('error', () => fin({ err: 'stdin' }));
  });
}

import { writeOut } from '../../core/io/stdio.mjs';

/**
 * Module hook (contract HOOK_MODULE). handle(event, input, ctx) -> {decision?, reason?}; KHONG ghi stdout/exit.
 * Ket qua: {} = khong y kien (none / mode audit); {decision:'ask'|'deny', reason:'approval[id]: ...'}. Khong bao gio 'allow'.
 * Fail-open: loi noi bo -> {} (+ gate 'fail-open'). Gate-event: ctx.write === false -> tra qua `records` ([{sink:'gate', data}]) va khong ghi; nguoc lai tu ghi (recordGate) va khong tra records.
 * ctx (tuy chon): {config (da nap), hubRoot, configDir, auditRoot, write}. event hien khong dung.
 */
export function handle(event, input, ctx = {}) {
  const c = ctx || {};
  const aopts = c.auditRoot ? { root: c.auditRoot } : {};
  const records = [];
  const emit = (ev) => { records.push({ sink: 'gate', data: ev }); if (c.write !== false) recordGate(ev, input || {}, aopts); };
  const rec = (rule, reason) => emit({ kind: 'approval', hook: 'approval', decision: 'allow', tier: 'none', rule, reason });
  const done = (r) => (c.write === false && records.length ? { ...r, records } : r); // write !== false: da ghi, khong lap lai trong ket qua
  try {
    let cfg = c.config;
    if (!cfg) {
      const L = loadApproval({ hubRoot: c.hubRoot, configDir: c.configDir });
      cfg = L.config;
      for (const w of L.warnings) rec('config-warning', w);
    }
    const d = decideApproval(input, cfg);
    if (d.ev) emit(d.ev);
    const hso = d.out && d.out.hookSpecificOutput;
    return done(hso && hso.permissionDecision ? { decision: hso.permissionDecision, reason: hso.permissionDecisionReason } : {});
  } catch (e) { rec('fail-open', String(e && e.message)); return done({}); }
}

const META = { id: 'approval', events: ['PreToolUse'], tools: /^(Bash|PowerShell)$/, timeoutMs: 2500, onError: 'open' };
/** Alias cu (test): handle dong bo goc. Chuan dispatcher la export default (handle async). */
export const hookModule = Object.freeze({ ...META, handle });
/** Chuan HOOK_MODULE: async handle(event, input, ctx). */
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });

/** Ket qua handle -> JSON stdout nhu ban cu (vo mong). */
export function toOutput(result) {
  const r = result || {};
  return r.decision ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: r.decision, permissionDecisionReason: r.reason } } : {};
}

async function main() {
  let out = {};
  const dog = setTimeout(() => { writeOut('{}'); process.exit(0); }, 4000); dog.unref();
  try {
    const L = loadApproval(); const cfg = L.config;
    for (const w of L.warnings) note('config-warning', w);
    const r = await readStdin(cfg.maxInputBytes, cfg.hardTimeoutMs);
    if (r.err) note('fail-open', r.err);
    else out = toOutput(handle('PreToolUse', r.inp, { config: cfg, write: true }));
  } catch (e) { out = {}; note('fail-open', String(e && e.message)); }
  writeOut(JSON.stringify(out));
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().then(() => process.exit(0), () => process.exit(0));
