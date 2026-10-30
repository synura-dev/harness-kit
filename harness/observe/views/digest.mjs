#!/usr/bin/env node
// Daily markdown digest: <root>/digest/YYYY-MM-DD.md (table: session, agent, tools, errors, tokens, duration).
// Bounded by limits (timeout / max bytes / max rows); reports `truncated:` instead of hanging.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditReadRoots } from '../../core/audit/audit-write.mjs';
import { loadAuditConfig, auditRoot } from '../../core/config/audit-config.mjs';
import { fmtDur as fmtDurCore } from '../../core/io/fmt.mjs';
import { ensureDataIgnore } from '../../core/io/paths.mjs';
import { listFiles, nodeRows } from './query/query.mjs';
import { replaceReason, isReadOnly, normalize, countDenied } from '../../core/agy/hints.mjs';

const durCell = (ms) => (ms >= 0 ? fmtDurCore(ms) : '');
const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

// rows (toRow format) -> one aggregate per (session, agent). tokens = max cumulative (Stop/SubagentStop), not a sum.
export function aggregate(rows, { includePhantom = false } = {}) {
  const g = new Map();
  for (const r of rows) {
    const aid = r.agent_id || 'main';
    const k = `${r.session_id}\u0000${aid}`;
    let a = g.get(k);
    if (!a) g.set(k, (a = { session: r.session_id, agent: r.agent_type || (r.agent_id ? r.agent_id : 'main'), agent_id: aid, project: r.project, tools: 0, errors: 0, tin: null, tout: null, model: null, t0: null, t1: null, stopOnly: true, typed: false }));
    if (r.event !== 'SubagentStop') a.stopOnly = false;
    if (r.agent_type) a.typed = true;
    if (r.project && !a.project) a.project = r.project;
    if (r.model) a.model = r.model;
    if (r.event === 'PostToolUse' || r.event === 'PostToolUseFailure') a.tools++;
    if (r.ok === false) a.errors++;
    if (r.in_tok != null) a.tin = Math.max(a.tin ?? 0, r.in_tok);
    if (r.out_tok != null) a.tout = Math.max(a.tout ?? 0, r.out_tok);
    const t = Date.parse(r.ts);
    if (t === t) { a.t0 = a.t0 === null ? t : Math.min(a.t0, t); a.t1 = a.t1 === null ? t : Math.max(a.t1, t); }
  }
  // legacy phantom rows (no data.phantom label): only SubagentStop, no agent_type, no tools/tokens
  const vals = [...g.values()].filter((a) => includePhantom || !(a.agent_id !== 'main' && a.stopOnly && !a.typed && a.tools === 0 && a.tin == null && a.tout == null));
  return vals.sort((x, y) => (x.session < y.session ? -1 : x.session > y.session ? 1 : x.agent_id === 'main' ? -1 : y.agent_id === 'main' ? 1 : x.agent_id < y.agent_id ? -1 : 1));
}

// agy Bash: ty le Bash/tool, so lenh thay duoc bang Read/Glob/Grep (replaceable), lenh read-only giong het lenh truoc trong cung phien (repeat), denied (tu log cua guard).
export function agyBash(rows, denied = 0) {
  const r = { tools: 0, bash: 0, replaceable: 0, repeat: 0, denied, ratio: 0 };
  const last = new Map();
  for (const e of rows) {
    if (e.cli !== 'agy' || e.event !== 'PostToolUse' || !e.tool) continue;
    r.tools++;
    if (e.tool !== 'Bash') { if (/^(Edit|Write)/.test(e.tool)) last.delete(e.session_id); continue; }
    r.bash++;
    const t = String(e.target || '');
    if (replaceReason(t)) r.replaceable++;
    const n = normalize(t);
    if (isReadOnly(t) && last.get(e.session_id) === n) r.repeat++;
    last.set(e.session_id, isReadOnly(t) ? n : null);
  }
  r.ratio = r.tools ? Math.round((1000 * r.bash) / r.tools) / 10 : 0;
  return r;
}

// agent_type x model: so lan, tokens; canh bao khi general-purpose > 50% luot subagent.
export function byAgentModel(aggs) {
  const m = new Map();
  for (const a of aggs) {
    if (a.agent_id === 'main') continue;
    const k = `${a.agent}\u0000${a.model || ''}`;
    const r = m.get(k) || { agent: a.agent, model: a.model || '', n: 0, tin: 0, tout: 0 };
    r.n++; r.tin += a.tin ?? 0; r.tout += a.tout ?? 0;
    m.set(k, r);
  }
  const rows = [...m.values()].sort((x, y) => y.n - x.n);
  const total = rows.reduce((n, r) => n + r.n, 0);
  const gp = rows.filter((r) => r.agent === 'general-purpose').reduce((n, r) => n + r.n, 0);
  return { rows, total, gp, warn: total > 0 && gp / total > 0.5 };
}

export function renderDigest(date, aggs, { truncated = null, maxRows = 200, agy = null } = {}) {
  const shown = aggs.slice(0, maxRows);
  const out = [`# Audit digest ${date}`, '', `sessions/agents: ${aggs.length}, tools: ${aggs.reduce((n, a) => n + a.tools, 0)}, errors: ${aggs.reduce((n, a) => n + a.errors, 0)}`, '',
    '| session | project | agent | tools | errors | tokens (in/out) | duration |', '| --- | --- | --- | ---: | ---: | ---: | ---: |'];
  for (const a of shown) out.push(`| ${cell(a.session)} | ${cell(a.project)} | ${cell(a.agent)} | ${a.tools} | ${a.errors} | ${a.tin == null && a.tout == null ? '' : `${a.tin ?? 0}/${a.tout ?? 0}`} | ${a.t0 !== null ? durCell(a.t1 - a.t0) : ''} |`);
  const am = byAgentModel(aggs);
  if (am.rows.length) {
    out.push('', '## Subagent theo agent_type x model', '', '| agent_type | model | luot | tokens (in/out) |', '| --- | --- | ---: | ---: |');
    for (const r of am.rows) out.push(`| ${cell(r.agent)} | ${cell(r.model)} | ${r.n} | ${r.tin}/${r.tout} |`);
    if (am.warn) out.push('', `CANH BAO: general-purpose chiem ${am.gp}/${am.total} luot subagent (>50%); uu tien agent chuyen biet (builder/verifier/scout...).`);
  }
  if (agy && agy.tools) out.push('', '## agy Bash', '', `agy bash ratio: ${agy.ratio}% (${agy.bash}/${agy.tools}), replaceable: ${agy.replaceable}, repeat: ${agy.repeat}, denied: ${agy.denied}`);
  if (aggs.length > shown.length) { truncated = truncated || 'max_rows'; }
  if (truncated) out.push('', `truncated: ${truncated}`);
  out.push('');
  return out.join('\n');
}

export async function writeDigest(date, opts = {}) {
  const root = opts.root || auditRoot();
  const L = loadAuditConfig().config.limits || {};
  const pick = (a, b, d) => (Number.isFinite(a) && a > 0 ? a : Number.isFinite(b) && b > 0 ? b : d);
  const lim = {
    deadline: Date.now() + pick(opts.timeoutMs, L.query_timeout_ms, 30000),
    maxBytes: pick(opts.maxBytes, L.query_max_bytes, 209715200),
    maxRows: pick(opts.maxRows, L.query_max_rows, 100000),
    truncated: null,
  };
  const outRows = pick(opts.digestMaxRows, L.digest_max_rows, 200);
  const files = (opts.root ? [root] : auditReadRoots()).flatMap((r) => listFiles(r, { date }));
  const rows = await nodeRows(files, { project: opts.project }, lim);
  const aggs = aggregate(rows, { includePhantom: !!opts.includePhantom });
  const text = renderDigest(date, aggs, { truncated: lim.truncated, maxRows: outRows, agy: agyBash(rows, (opts.root ? [root] : auditReadRoots()).reduce((n, r) => n + countDenied(r, date), 0)) });
  const dir = join(root, 'digest');
  ensureDataIgnore(); mkdirSync(dir, { recursive: true });
  const file = join(dir, `${date}.md`);
  writeFileSync(file, text);
  return { file, rows: Math.min(aggs.length, outRows), files: files.length, truncated: lim.truncated || (aggs.length > outRows ? 'max_rows' : null) };
}

async function main() {
  const a = process.argv.slice(2);
  const date = a[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) { console.error('usage: digest.mjs YYYY-MM-DD [--timeout sec] [--project p]'); process.exit(1); }
  const g = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const t = g('--timeout');
  const r = await writeDigest(date, { timeoutMs: t ? Number(t) * 1000 : undefined, project: g('--project'), includePhantom: a.includes('--include-phantom') });
  console.log(`digest: ${r.file} (sessions=${r.rows}, files=${r.files})` + (r.truncated ? `\ntruncated: ${r.truncated}` : ''));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error('digest: ' + e.message); process.exit(1); });
