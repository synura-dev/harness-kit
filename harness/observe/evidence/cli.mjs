#!/usr/bin/env node
// harness evidence list|summary [--session S] [--task T] [--since YYYY-MM-DD|ISO] [--days N] [--limit N] [--all]
//   [--read-max-bytes N] [--timeout-s N] [--max-bytes N] [--json] [--raw]. Chi doc audit; xem README.md.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommon, emit, posInt, capLines } from '../../core/io/out.mjs';
import { list, summary, LIMITS, KINDS } from './evidence.mjs';

const USAGE = 'evidence list|summary [--session S] [--task T] [--since D] [--days N] [--limit N] [--all] [--read-max-bytes N] [--timeout-s N] [--json] [--raw]';

export function parseArgs(argv) {
  const c = parseCommon(argv);
  const o = { cmd: null, json: c.json, raw: c.raw, maxBytes: c.maxBytes, timeoutMs: c.timeoutS ? c.timeoutS * 1000 : LIMITS.timeoutMs };
  const r = c.rest;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const [k, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const val = () => (inline !== null ? inline : r[++i]);
    if (k === '--session') o.session = val();
    else if (k === '--task') o.task = val();
    else if (k === '--since') o.since = val();
    else if (k === '--days') o.days = posInt(val());
    else if (k === '--limit') o.limit = posInt(val());
    else if (k === '--read-max-bytes') o.readMaxBytes = posInt(val());
    else if (k === '--all') o.all = true;
    else if (!o.cmd && !a.startsWith('-')) o.cmd = a;
    else throw new Error(`tham so la: ${a}`);
  }
  return o;
}

const short = (s) => (s ? String(s).slice(-12) : '-');

export function render(o) {
  if (o.cmd === 'list') {
    const r = list(o);
    const lines = [`evidence list: ${r.items.length}/${r.total} (files=${r.files})`,
      ...r.items.map((e) => [e.ts, (e.kind || '-').padEnd(6), e.outcome.padEnd(4), `exit=${e.exit_code ?? '-'}`, `task=${e.task_id || '-'}`, `sid=..${short(e.session_id)}`].join('  '))];
    return { summary: capLines(lines, LIMITS.maxLines).join('\n'), data: { items: r.items, total: r.total, files: r.files, truncated: r.truncated }, truncated: r.truncated, raw: JSON.stringify(r.raw, null, 2) };
  }
  if (o.cmd === 'summary') {
    const s = summary(o);
    const scope = [s.task && `task=${s.task}`, s.session && `session=${s.session}`].filter(Boolean).join(' ') || 'tat ca';
    const lines = [`evidence summary: ${s.total} ban ghi (${scope}, files=${s.files})`, `sua file cuoi: ${s.last_edit_ts || '-'}`];
    const order = [...KINDS, 'none'].filter((k) => s.kinds[k]);
    for (const k of order) {
      const v = s.kinds[k];
      lines.push(`${k.padEnd(6)} pass=${v.pass} fail=${v.fail} none=${v.none} | cuoi=${v.last_outcome}@${v.last_ts} | pass sau sua cuoi: ${v.fresh_pass ? 'co' : 'khong'}`);
    }
    if (!order.length) lines.push('(khong co bang chung)');
    const { raw, ...data } = s;
    return { summary: capLines(lines, LIMITS.maxLines).join('\n'), data, truncated: s.truncated, raw: JSON.stringify(raw, null, 2) };
  }
  throw new Error(`lenh la: ${o.cmd ?? '(trong)'}\n${USAGE}`);
}

export function main(argv = process.argv.slice(2)) {
  try {
    const o = parseArgs(argv);
    if (!o.cmd) { console.log(USAGE); return 0; }
    const r = render(o);
    emit(r, { json: o.json, raw: o.raw, maxBytes: o.maxBytes });
    return 0;
  } catch (e) { console.error('evidence: ' + e.message); return 2; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
