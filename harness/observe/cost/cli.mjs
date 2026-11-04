#!/usr/bin/env node
// harness cost summary|top [--since 7d|24h|YYYY-MM-DD] [--by model|role|day|session] [--limit N] [--read-max-bytes N] [--timeout-s N] [--max-bytes N] [--json] [--raw]
// Chi doc audit; xem README.md. Gia uoc tinh, cap nhat tay (cost.config.json); thieu gia -> cost=null.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommon, emit, posInt, capLines } from '../../core/io/out.mjs';
import { summary, top, LIMITS, BY } from './cost.mjs';

const USAGE = 'cost summary [--since 7d] [--by model|role|day|session] | cost top [--limit N] [--since 7d]  [--read-max-bytes N] [--timeout-s N] [--max-bytes N] [--json]';

export function parseCostArgs(argv) {
  const c = parseCommon(argv);
  const o = { cmd: null, json: c.json, raw: c.raw, maxBytes: c.maxBytes, timeoutMs: c.timeoutS ? c.timeoutS * 1000 : LIMITS.timeoutMs };
  const r = c.rest;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const [k, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const val = () => (inline !== null ? inline : r[++i]);
    if (k === '--since') o.since = val();
    else if (k === '--by') { o.by = val(); if (!BY.includes(o.by)) throw new Error(`--by phai la ${BY.join('|')}`); }
    else if (k === '--limit') o.limit = posInt(val());
    else if (k === '--read-max-bytes') o.readMaxBytes = posInt(val());
    else if (!o.cmd && !a.startsWith('-')) o.cmd = a;
    else throw new Error(`tham so la: ${a}`);
  }
  return o;
}

const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
const usd = (c) => (c === null || c === undefined ? 'null' : '$' + c.toFixed(4));
const dur = (ms) => (ms === null || ms === undefined ? '-' : ms >= 60000 ? (ms / 60000).toFixed(1) + 'm' : Math.round(ms / 1000) + 's');
export async function render(o) {
  if (o.cmd === 'summary') {
    const s = await summary(o);
    const row = (g) => `${String(g.key).slice(0, 36).padEnd(36)} runs=${String(g.runs).padStart(4)} in=${k(g.tokens_in).padStart(7)} out=${k(g.tokens_out).padStart(7)} cache=${k(g.tokens_cache).padStart(7)} cost=${usd(g.cost)}${g.cheaper_possible ? ` cheaper_possible=${g.cheaper_possible}` : ''}`;
    const lines = [`cost summary by ${s.by} since ${s.since.slice(0, 16)}Z (audit, scanned=${s.scanned} su kien; gia: UOC TINH, cap nhat tay${s.priced ? '' : ' - CHUA co gia -> cost=null'})`,
      ...s.groups.map(row), row(s.total)];
    if (!s.policy) lines.push('(khong co chinh sach models -> khong co co cheaper_possible)');
    return { summary: capLines(lines, LIMITS.maxLines).join('\n'), data: s, truncated: s.truncated };
  }
  if (o.cmd === 'top') {
    const t = await top(o);
    const lines = [`cost top ${t.items.length}/${t.total} since ${t.since.slice(0, 16)}Z (xep theo cost, roi tong token; scanned=${t.scanned})`,
      ...t.items.map((x) => `${x.ts.slice(5, 16)} ${x.kind.padEnd(4)} ${x.role.padEnd(16)} ${String(x.model || '-').replace('claude-', '').padEnd(12)} turns=${x.turns ?? '-'} dur=${dur(x.dur_ms)} in=${k(x.tokens_in)} out=${k(x.tokens_out)} cache=${k(x.tokens_cache)} cost=${usd(x.cost)}${x.cheaper_possible ? ' cheaper_possible' : ''}`)];
    return { summary: capLines(lines, LIMITS.maxLines).join('\n'), data: t, truncated: t.truncated };
  }
  throw new Error(`lenh la: ${o.cmd ?? '(trong)'}\n${USAGE}`);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const o = parseCostArgs(argv);
    if (!o.cmd) { console.log(USAGE); return 0; }
    emit(await render(o), { json: o.json, raw: o.raw, maxBytes: o.maxBytes });
    return 0;
  } catch (e) { console.error('cost: ' + e.message); return 2; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((c) => { process.exitCode = c; });
