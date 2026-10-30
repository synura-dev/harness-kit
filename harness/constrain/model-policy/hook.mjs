// model-policy (PreToolUse, Agent): dien `model` con thieu theo vai tro (subagent_type) + hoi nguoi khi dung opus ngoai chinh sach.
// Chinh sach la DATA: config hub "models" ({roles:{<subagent_type>:{model,effort,allowOpus}}, default:{model}, opusAllowed:[...]}), nguon duy nhat; hook.config.json chi giu khoa hanh vi + fallback an toan (khong role, default sonnet).
// updatedInput THAY TOAN BO tool_input -> chep lai moi truong (gom effort neu co). Chi import core. Loi/timeout -> {} (fail-open, ghi vet).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHookConfig } from '../../core/config/config.mjs';
import { recordGate } from '../../core/audit/gate-event.mjs';
import { isObj } from '../../core/io/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HUB_ROOT = path.resolve(HERE, '..', '..', '..');
const CONFIG_FILE = path.join(HERE, 'hook.config.json');
export const DEFAULTS = { mode: 'enforce', hardTimeoutMs: 2000, maxInputBytes: 1048576, logAllow: false, fillEffort: false, default: { model: 'sonnet' }, opusAllowed: [], roles: {} };
const ALIASES = ['sonnet', 'opus', 'haiku', 'fable'];

/** -> {config, warnings}. Thu tu: code < hook.config.json (hanh vi/fallback) < config/models/{default,local}.json (chinh sach) < env HARNESS_MODELS_*. */
export function loadModelPolicy(opts = {}) {
  const r = loadHookConfig('models', { defaults: DEFAULTS, files: [opts.file || CONFIG_FILE], root: opts.hubRoot || HUB_ROOT, configDir: opts.configDir });
  const cfg = { ...DEFAULTS, ...r.config };
  if (!isObj(cfg.roles)) cfg.roles = {};
  if (!isObj(cfg.default)) cfg.default = DEFAULTS.default;
  if (!Array.isArray(cfg.opusAllowed)) cfg.opusAllowed = [];
  return { config: cfg, warnings: r.warnings.slice() };
}

const normModel = (m) => (typeof m === 'string' ? m.trim().toLowerCase() : '');
const isOpus = (m) => /opus/.test(normModel(m));
const pickModel = (m) => { const n = normModel(m); return ALIASES.includes(n) ? n : null; };

/** Vai tro hieu luc cho subagent_type: {role, model, effort, allowOpus}. Thieu vai tro -> default. */
export function roleOf(type, cfg) {
  const key = typeof type === 'string' && type ? type : 'general-purpose';
  const r = isObj(cfg.roles[key]) ? cfg.roles[key] : null;
  const model = pickModel(r && r.model) || pickModel(cfg.default && cfg.default.model) || 'sonnet';
  const effort = r && typeof r.effort === 'string' ? r.effort : null;
  const allowOpus = !!(r && r.allowOpus) || isOpus(model) || cfg.opusAllowed.includes(key);
  return { role: key, model, effort, allowOpus };
}

/** Quyet dinh thuan -> {out, ev|null}. ev = su kien gate cho recordGate. */
export function decideModel(inp, cfg) {
  if (!isObj(inp) || (inp.tool_name !== 'Agent' && inp.tool_name !== 'Task') || !isObj(inp.tool_input)) return { out: {}, ev: null };
  const ti = inp.tool_input;
  const r = roleOf(ti.subagent_type, cfg);
  const audit = cfg.mode === 'audit';
  const base = { kind: 'gate', hook: 'model-policy', tool: inp.tool_name, target: r.role };
  const given = typeof ti.model === 'string' ? ti.model.trim() : '';
  if (!given) {
    const upd = { ...ti, model: r.model };
    if (cfg.fillEffort && r.effort && !ti.effort) upd.effort = r.effort;
    const ev = { ...base, decision: 'allow', tier: 'none', rule: 'model-filled', reason: audit ? `would-fill ${r.model}` : `${r.role}: model ${r.model}` };
    if (audit) return { out: {}, ev };
    return { out: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: `model-policy: vai tro ${r.role} -> ${r.model}`, updatedInput: upd } }, ev };
  }
  if (isOpus(given) && !r.allowOpus) {
    const reason = `vai tro ${r.role} mac dinh ${r.model}, khong phai opus`;
    const ev = { ...base, decision: audit ? 'allow' : 'ask', tier: 'ask', rule: 'opus-not-allowed', reason: audit ? 'would-ask: ' + reason : reason };
    if (audit) return { out: {}, ev };
    return { out: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `model-policy: ${reason}` } }, ev };
  }
  if (!cfg.logAllow) return { out: {}, ev: null };
  return { out: {}, ev: { ...base, decision: 'allow', tier: 'none', rule: 'model-pass', reason: `${r.role}: ${normModel(given)}` } };
}

// Module hook (hop dong HOOK_MODULE, core/config/contract.mjs): dispatcher goi handle(); khong tu ghi stdout/exit/audit.
const META = { id: 'model-policy', events: ['PreToolUse'], tools: /^(Agent|Task)$/, timeoutMs: 2000, onError: 'open' };
/** Alias cu (test): handle dong bo goc. */
export const hookModule = Object.freeze({ ...META, handle });
/** Chuan HOOK_MODULE: async handle(event, input, ctx). Module thuan: khong bao gio tu ghi; su kien gate tra qua records, vo main tu ghi. */
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });

/** handle(event, input, ctx) -> {decision?, reason?, updatedInput?, record?, records?} | undefined. records = [{sink:'gate', data}] (record = ban cu, cung su kien) de dispatcher/vo ghi; handle KHONG tu ghi. ctx.config ghi de (test). */
export function handle(event, input, ctx = {}) {
  if (event !== 'PreToolUse') return undefined;
  const cfg = ctx && ctx.config ? ctx.config : loadModelPolicy().config;
  const d = decideModel(input, cfg);
  const h = d.out && d.out.hookSpecificOutput;
  if (!h && !d.ev) return undefined;
  const r = {};
  if (h) {
    r.decision = h.permissionDecision; r.reason = h.permissionDecisionReason;
    if (h.updatedInput) r.updatedInput = h.updatedInput;
  }
  if (d.ev) { r.record = d.ev; r.records = [{ sink: 'gate', data: d.ev }]; }
  return r;
}

/** Ket qua handle -> JSON output Claude PreToolUse ({} khi khong y kien). */
export function toClaudeOutput(r) {
  if (!r || !r.decision) return {};
  const h = { hookEventName: 'PreToolUse', permissionDecision: r.decision, permissionDecisionReason: r.reason };
  if (r.updatedInput) h.updatedInput = r.updatedInput;
  return { hookSpecificOutput: h };
}

const noteGate = (rule, reason, ctx) => recordGate({ kind: 'gate', hook: 'model-policy', decision: 'allow', tier: 'none', rule, reason }, ctx || {});
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

async function main() {
  let out = {};
  const dog = setTimeout(() => { writeOut('{}'); process.exit(0); }, 2000); dog.unref();
  try {
    const L = loadModelPolicy(); const cfg = L.config;
    for (const w of L.warnings) noteGate('config-warning', w);
    const r = await readStdin(cfg.maxInputBytes, Math.min(cfg.hardTimeoutMs || 2000, 1800));
    if (r.err) noteGate('fail-open', r.err);
    else { const d = handle('PreToolUse', r.inp, { config: cfg }); out = toClaudeOutput(d); if (d && d.record) recordGate(d.record, r.inp); }
  } catch (e) { out = {}; noteGate('fail-open', String(e && e.message)); }
  writeOut(JSON.stringify(out));
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().then(() => process.exit(0), () => process.exit(0));
