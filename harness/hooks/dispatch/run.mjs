// Dispatcher hook cho Claude Code (Dot 5.2b): MOT script cho moi su kien. `node run.mjs <Event> [module-id]`.
// Doc stdin 1 lan -> chon module theo events+tools -> chay tuan tu (timeout rieng, onError rieng, tran tong) -> gop (merge.mjs) -> in dung dinh dang Claude
// -> ghi moi `records` MOT lan qua writer cua core. Khong ghi stdin/lenh tho (chi id module + loai loi). Loi toan cuc: fail-open `{}` exit 0 (WorktreeCreate: exit 1).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isObj, hkerrLine } from '../../core/io/paths.mjs';
import { validateHookModule, validateHookResult } from '../../core/config/shape.mjs';
import { DEFAULTS, ORDER, loadModules, applies } from './modules.mjs';
import { mergeResults, applyUpdate, render } from './merge.mjs';
import { hookRunEnvelope } from '../../core/audit/signals.mjs';

/** Chinh sach ghi do tre module: su kien tool (nhieu) chi ghi khi cham/loi (>= slowMs); su kien khac ghi luon. Worktree* khong ghi. */
export const TOOL_EVENTS = Object.freeze(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
export function latencyRecord(event, input, timings, totalMs, slowMs = 100) {
  if (!Array.isArray(timings) || !timings.length || /^Worktree/.test(String(event))) return null;
  const sum = timings.reduce((a, t) => a + (t.ms || 0), 0); // tong thoi gian module (khong tinh khoi dong node)
  if (TOOL_EVENTS.includes(event) && sum < slowMs && !timings.some((t) => t.err)) return null;
  const env = hookRunEnvelope(event, input, timings, totalMs);
  return env ? { sink: 'audit', data: env } : null;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TIMEOUT = Symbol('timeout');
/** Module loi (luon bat, khong go): bo qua khi ghi `module-acted` va khi doctor tim module khong dung. Module khac (OPTIONAL...) co the go khoi ORDER. */
export const CORE_MODULES = Object.freeze(['audit', 'guard', 'data-gate', 'bash-guard', 'worktree-hook']);
/** Module bao tri lam viec im lang (data-check: don nen khong de vet; user-shim: tra `{}` khi shim on): doctor khong bao gio xet "khong dung". Van ghi module-acted khi co tac dung (lam moc "tinh nang da bat"). */
export const MAINTENANCE_MODULES = Object.freeze(['data-check', 'user-shim']);
/** Ket qua co tac dung ma chua de lai dau trong audit: chan (decision deny hoac block:true; decision 'block' khong hop le voi hop dong), hoi, sua input, context; khong tinh `{}`/undefined/allow tran (verify-gate tra allow moi lan). Module tra `records` da tu hien trong audit (gate hook:<id>, type=proc...) -> khong ghi trung. */
export const hasEffect = (r) => isObj(r) && !(Array.isArray(r.records) && r.records.length > 0) && (r.decision === 'deny' || r.decision === 'ask' || r.block === true || isObj(r.updatedInput) || !!r.additionalContext);

function withTimeout(promise, ms) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

/** Doc stdin co tran: {raw, over, timedOut}. */
export function readStdin(max, ms) {
  return new Promise((resolve) => {
    const chunks = []; let size = 0; let done = false;
    const fin = (extra) => {
      if (done) return; done = true; clearTimeout(timer);
      try { process.stdin.pause(); process.stdin.removeAllListeners('data'); } catch {}
      resolve({ raw: Buffer.concat(chunks).toString('utf8'), over: false, timedOut: false, ...extra });
    };
    const timer = setTimeout(() => fin({ timedOut: true }), ms);
    try {
      process.stdin.on('data', (c) => { size += c.length; if (size > max) fin({ over: true }); else chunks.push(c); });
      process.stdin.on('end', () => fin({}));
      process.stdin.on('error', () => fin({}));
    } catch { fin({}); }
  });
}

function parseInput(r, max) {
  if (r.over) return { err: 'oversize' };
  if (r.timedOut) return { err: 'stdin-timeout' };
  let s = String(r.raw || '');
  if (s.length > max) return { err: 'oversize' };
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  if (!s.trim()) return { err: 'empty' };
  try { const v = JSON.parse(s); return isObj(v) ? { input: v } : { err: 'badjson' }; } catch { return { err: 'badjson' }; }
}

/** Ho so Claude (mac dinh); agy.mjs truyen ho so rieng cung loi. */
export const CLAUDE = { order: ORDER, render, setEvent: true, failOut, noop: () => ({ stdout: '{}', stderr: '', code: 0 }) };
const clean = (v, re) => String(v).replace(re, '').slice(0, 40);
const gateWarn = (mod, kind) => hkerrLine('HK-GATE-001', 'gate hook loi, bo qua (fail-open)', { source: `${clean(mod, /[^\w.-]/g)}:${clean(kind, /[^\w:.-]/g)}` }) + '\n';
const traceRec = (rule, reason) => ({ sink: 'gate', data: { kind: 'gate', decision: 'allow', hook: 'dispatch', rule, reason } });

function failOut(event, why) {
  if (event === 'WorktreeCreate') return { stdout: '', stderr: `worktree create loi: ${why}\n`, code: 1 };
  if (event === 'WorktreeRemove') return { stdout: '', stderr: '', code: 0 };
  return { stdout: '{}', stderr: '', code: 0 };
}

/** Ghi tat ca records MOT lan (moi sink qua writer cua core / nhat ky cua module). Khong nem. */
export async function writeRecords(records, input) {
  const failed = [];
  for (const r of records) {
    try {
      if (r.sink === 'gate') (await import('../../core/audit/gate-event.mjs')).recordGate(r.data, r.ctx || input || {});
      else if (r.sink === 'audit') { const w = await import('../../core/audit/audit-write.mjs'); w.writeEnvelope(r.data, r.opts || {}, w.auditRoot()); }
      else if (r.sink === 'guard') await (await import('../../constrain/guard/hook.mjs')).log(r.data, { logFile: process.env.GUARD_LOG_FILE || '' });
      else if (r.sink === 'worktree') await (await import('../../constrain/worktree/hook.mjs')).log(r.data);
    } catch (e) { failed.push({ sink: String(r.sink).replace(/[^\w-]/g, '').slice(0, 20), kind: String((e && e.name) || 'Error').replace(/[^\w]/g, '').slice(0, 30) }); }
  }
  if (failed.length) { try { fs.writeSync(2, hkerrLine('HK-WRITE-001', `ghi ${failed.length} record that bai (fail-open)`, { source: `${failed[0].sink}:${failed[0].kind}` }) + '\n'); } catch {} }
}

/**
 * Loi cot loi (testable, khong in/exit): dispatch({event, only, raw|input, cfg}) -> {stdout, stderr, code, records, input}.
 * raw = noi dung stdin da doc ({raw, over, timedOut}) hoac chuoi. Khong ghi file (caller goi writeRecords).
 */
export async function dispatch({ event, only = '', stdin, cfg = DEFAULTS, startedAt = Date.now(), profile = CLAUDE }) {
  const r = typeof stdin === 'string' ? { raw: stdin } : stdin || { raw: '' };
  const p = parseInput(r, cfg.maxInputBytes);
  if (p.err) { const o = profile.failOut(event, p.err); if (event === 'PreToolUse') o.stderr = (o.stderr || '') + gateWarn('dispatch', p.err); return { ...o, records: [traceRec('fail-open', p.err)], input: {} }; }
  const original = p.input;
  const ev = event || (typeof original.hook_event_name === 'string' ? original.hook_event_name : '');
  if (!profile.order[ev]) return { ...profile.noop(ev), records: [], input: original };
  if (cfg.enabled === false && ev !== 'WorktreeCreate') return { ...profile.noop(ev), records: [], input: original };
  if (profile.setEvent && !original.hook_event_name) original.hook_event_name = ev;
  const budget = (cfg.budgetsMs && cfg.budgetsMs[ev]) || DEFAULTS.budgetsMs[ev] || 2500;
  const state = { input: original, items: [], traces: [], denied: false, warns: [], timings: [] };
  const trace = (id, kind) => state.traces.push(traceRec('module-error', `${id}: ${kind}`));
  const gw = (id, kind) => { state.warns.push(gateWarn(id, kind)); state.items.push({ id: 'dispatch', result: { additionalContext: `lop bao ve ${clean(id, /[^\w.-]/g)} khong chay (fail-open)` } }); };

  const work = async () => {
    const mods = await loadModules(ev, { only, validate: validateHookModule, order: profile.order, modules: cfg.modules });
    for (const m of mods) {
      if (m.error) { trace(m.id, m.error); if (m.gate) gw(m.id, m.error); continue; }
      if (!applies(m.mod, ev, state.input)) continue;
      if (m.gate && state.denied) continue; // deny cat chuoi gate; audit van chay
      const left = budget - (Date.now() - startedAt);
      if (left < 50) { trace(m.id, 'budget'); if (m.gate && m.mod.onError !== 'closed') gw(m.id, 'budget'); continue; }
      const tmo = Math.min(Number(m.mod.timeoutMs) || left, left);
      let res; let kind = ''; const t0 = Date.now();
      try {
        const ctx = { write: false, background: true, deadline: Date.now() + tmo };
        res = await withTimeout(Promise.resolve().then(() => m.mod.handle(ev, state.input, ctx)), tmo);
      } catch (e) { kind = e && e.message === 'timeout' ? 'timeout' : `error:${String((e && e.name) || 'Error').slice(0, 30)}`; }
      if (!kind && validateHookResult(res).length) kind = 'bad-result';
      state.timings.push({ id: m.id, ms: Date.now() - t0, ...(kind ? { err: kind } : {}) });
      if (kind) {
        trace(m.id, kind);
        if (m.gate && m.mod.onError !== 'closed') gw(m.id, kind);
        if (m.mod.onError === 'closed') { state.items.push({ id: m.id, result: { decision: 'deny', reason: `dispatch[${m.id}]: ${kind} (closed)` } }); if (m.gate) state.denied = true; }
        continue;
      }
      if (!res) continue;
      state.items.push({ id: m.id, result: res });
      if (!m.gate && !CORE_MODULES.includes(m.id) && hasEffect(res)) state.traces.push(traceRec('module-acted', `${m.id}:${ev}`));
      if (res.decision === 'deny') { if (m.gate) state.denied = true; }
      else if (res.updatedInput) state.input = applyUpdate(state.input, res.updatedInput);
    }
  };

  let timedOut = false;
  try {
    const left = Math.max(50, budget - (Date.now() - startedAt));
    const w = await Promise.race([work().then(() => null), new Promise((res) => { const t = setTimeout(() => res(TIMEOUT), left); t.unref(); })]);
    if (w === TIMEOUT) timedOut = true;
  } catch { state.traces.push(traceRec('fail-open', 'dispatch-error')); if (ev === 'PreToolUse') state.warns.push(gateWarn('dispatch', 'dispatch-error')); }
  if (timedOut) { state.traces.push(traceRec('module-error', 'dispatch: budget-timeout')); if (ev === 'PreToolUse') state.warns.push(gateWarn('dispatch', 'budget-timeout')); }
  const merged = mergeResults(state.items);
  const out = profile.render(ev, merged);
  if (state.warns.length) out.stderr = (out.stderr || '') + state.warns.join('');
  const records = [...merged.records, ...state.traces];
  return { ...out, records, input: original, timings: state.timings, totalMs: Date.now() - startedAt };
}

async function loadCfg() {
  try {
    const { loadHookConfig } = await import('../../core/config/config.mjs');
    const c = loadHookConfig('dispatch', { defaults: DEFAULTS, files: [path.join(HERE, 'hook.config.json')] }).config;
    return { ...DEFAULTS, ...c, budgetsMs: { ...DEFAULTS.budgetsMs, ...(isObj(c.budgetsMs) ? c.budgetsMs : {}) }, modules: isObj(c.modules) ? c.modules : {} };
  } catch { return DEFAULTS; }
}

/** Vo CLI dung chung (Claude + agy): doc stdin 1 lan, dispatch, in, ghi records 1 lan, exit. profile.mapRecords(records, input) tuy chon. */
export async function main({ event, only = '', profile = CLAUDE } = {}) {
  const startedAt = Date.now() - Math.round(process.uptime() * 1000);
  let out = profile.failOut(event, 'dispatch-error'); let records = []; let input = {};
  try {
    const cfg = await loadCfg();
    const stdin = await readStdin(cfg.maxInputBytes, cfg.stdinTimeoutMs);
    const r = await dispatch({ event, only, stdin, cfg, startedAt, profile });
    out = r; records = r.records; input = r.input;
    if (profile.mapRecords) records = profile.mapRecords(records, input);
    try { const lr = latencyRecord(event || input.hook_event_name, input, r.timings, r.totalMs, cfg.hookSlowMs); if (lr) records = [...records, lr]; } catch {}
  } catch { /* fail-open */ }
  try { if (out.stdout) fs.writeSync(1, out.stdout); if (out.stderr) fs.writeSync(2, out.stderr); } catch {}
  try { await writeRecords(records, input); } catch {}
  process.exit(out.code);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main({ event: process.argv[2] || '', only: process.argv[3] || '' }).catch(() => process.exit(0));
