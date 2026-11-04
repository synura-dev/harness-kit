// Ban ghi chuan runs.jsonl cua workspace (data-workspaces P1b). Append-only, khong bao gio nem.
// Duong dan file do goi quyet dinh (vd <dataRoot>/workspaces/<ws>/<tool>/runs.jsonl); module nay khong tu doan duong dan.
import fs from 'node:fs';
import { appendJsonl } from './storage.mjs';
import { safeId } from './safe-id.mjs';
import { compile, redact } from '../../observe/audit/redact.mjs';
import { loadAuditConfig } from '../config/audit-config.mjs';

export const RUN_STATUS = ['running', 'ok', 'fail', 'unknown'];
export const RUN_FIELDS = ['ts', 'run', 'node', 'tool', 'cmd', 'status', 'ref', 'env', 'artifacts', 'durMs', 'summary'];
export const RUN_LIMITS = { maxBytes: 5 * 1024 * 1024, cmd: 200, summary: 200, ref: 200, env: 40, artifact: 200, artifacts: 50 };
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const FALLBACK_REDACT = ['(token|key|secret|password|bearer|authorization)\\s*[=:]\\s*((bearer|basic)\\s+)?\\S+', 'bearer\\s+[A-Za-z0-9._~+/=-]{3,}', 'sk-[A-Za-z0-9_-]{8,}', '(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}', '[a-z][a-z0-9+.-]{0,31}://[^\\s/:@]+:[^\\s/@]+@', '(https?://[^\\s?#]+)\\?[^\\s]*'];
let res = null;
const patterns = () => {
  if (res) return res;
  let list = null;
  try { list = loadAuditConfig().config.redact; } catch {}
  res = compile(Array.isArray(list) && list.length ? list : FALLBACK_REDACT);
  return res;
};
const clip = (v, n) => redact(String(v ?? '').replace(/[\r\n]+/g, ' '), patterns()).slice(0, n);
const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

/**
 * Chuan hoa + kiem tra mot ban ghi. Khong nem. Tra { rec, errors[], dropped[] }.
 * errors khong rong = ban ghi bi tu choi. Truong ngoai RUN_FIELDS bi bo (dropped). `id` la bi danh cua `run`.
 * `env` chi nhan chuoi ngan (ten moi truong), object bi bo (cam gia tri env).
 */
export function normalizeRun(input, { now = Date.now() } = {}) {
  const errors = []; const dropped = []; const rec = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { rec: null, errors: ['ban ghi phai la object'], dropped };
  const x = { ...input };
  if (x.run == null && x.id != null) { x.run = x.id; delete x.id; }
  for (const k of Object.keys(x)) if (!RUN_FIELDS.includes(k)) dropped.push(k);
  const ts = x.ts == null ? new Date(now).toISOString() : x.ts;
  if (typeof ts !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(ts) || Number.isNaN(Date.parse(ts))) errors.push('ts phai la ISO'); else rec.ts = ts;
  for (const k of ['node', 'tool']) { if (typeof x[k] !== 'string' || !ID_RE.test(x[k])) errors.push(`${k} khong hop le`); else rec[k] = x[k]; }
  const run = x.run == null ? `r-${now.toString(36)}` : safeId(x.run);
  if (!run) errors.push('run khong hop le'); else rec.run = run;
  if (!RUN_STATUS.includes(x.status)) errors.push(`status phai la ${RUN_STATUS.join('|')}`); else rec.status = x.status;
  if (errors.length) return { rec: null, errors, dropped };
  if (x.cmd != null) rec.cmd = clip(x.cmd, RUN_LIMITS.cmd);
  if (x.ref != null) rec.ref = clip(x.ref, RUN_LIMITS.ref);
  if (x.env != null) { if (typeof x.env === 'string') rec.env = clip(x.env, RUN_LIMITS.env); else dropped.push('env(non-string)'); }
  rec.artifacts = Array.isArray(x.artifacts) ? x.artifacts.filter((a) => typeof a === 'string').slice(0, RUN_LIMITS.artifacts).map((a) => clip(a, RUN_LIMITS.artifact)) : [];
  if (x.durMs != null) { const d = Number(x.durMs); if (Number.isFinite(d) && d >= 0) rec.durMs = Math.round(d); else dropped.push('durMs(invalid)'); }
  if (x.summary != null) rec.summary = clip(x.summary, RUN_LIMITS.summary);
  return { rec, errors, dropped };
}

/**
 * appendRun(file, record, opts?) -> { ok, file?, rec?, errors?, dropped? }. Append-only, khong nem; loi -> canh bao stderr.
 * Vuot opts.maxBytes (mac dinh 5MB): file doi thanh <file>.old (ban .old cu bi de), ghi file moi, canh bao rotation.
 * Ghi qua appendJsonl (storage.mjs) nen van qua guardWrite/registry enforce.
 */
export function appendRun(file, record, opts = {}) {
  const warn = opts.warn || ((m) => { try { process.stderr.write(`runs-record: ${m}\n`); } catch {} });
  try {
    if (typeof file !== 'string' || !file) { warn('thieu duong dan file'); return { ok: false, errors: ['thieu duong dan file'] }; }
    const { rec, errors, dropped } = normalizeRun(record, opts);
    if (dropped.length) warn(`bo truong khong cho phep: ${dropped.join(',')}`);
    if (!rec) { warn(`tu choi ban ghi: ${errors.join('; ')}`); return { ok: false, errors, dropped }; }
    const maxBytes = opts.maxBytes ?? RUN_LIMITS.maxBytes;
    if (sizeOf(file) > maxBytes) warn(`rotation: ${file} > ${maxBytes}B -> .old`);
    const w = appendJsonl(file, rec, { maxBytes });
    if (!w) { warn(`khong ghi duoc ${file}`); return { ok: false, errors: ['write'], dropped }; }
    return { ok: true, file: w, rec, dropped };
  } catch (e) { try { process.stderr.write(`runs-record: loi ${e && e.message}\n`); } catch {} return { ok: false, errors: [String(e && e.message)] }; }
}
