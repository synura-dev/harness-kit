#!/usr/bin/env node
// harness observe report [--days N] [--out -|obsidian] [--dry-run] [--baseline] [--weekly] [--json] [--raw] [--timeout-s N]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommon, emit, posInt } from '../../core/io/out.mjs';
import { buildReport, saveBaseline, putObsidian, markRun, REPORT } from './run.mjs';

const USAGE = 'report [--days N] [--out -|obsidian] [--dry-run] [--baseline] [--weekly] [--json] [--raw] [--timeout-s N]';

export function parseArgs(argv) {
  const c = parseCommon(argv);
  const o = { json: c.json, raw: c.raw, maxBytes: c.maxBytes, timeoutS: c.timeoutS, days: null, out: '-', dryRun: false, baseline: false, weekly: false };
  const r = c.rest;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const [k, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const val = () => (inline !== null ? inline : r[++i]);
    if (k === '--days') o.days = posInt(val()) || null;
    else if (k === '--out') { o.out = val(); if (!['-', 'obsidian'].includes(o.out)) throw new Error('out phai la - hoac obsidian'); }
    else if (k === '--dry-run') o.dryRun = true;
    else if (k === '--baseline') o.baseline = true;
    else if (k === '--weekly') { o.weekly = true; o.out = 'obsidian'; }
    else if (k !== 'report') throw new Error(`tham so la: ${a}`);
  }
  return o;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const o = parseArgs(argv);
    const res = await buildReport({ days: o.days, timeoutMs: (o.timeoutS || REPORT.timeoutS) * 1000 });
    const notes = [];
    if (o.baseline) { const b = saveBaseline(res, { dryRun: o.dryRun }); notes.push(o.dryRun ? `baseline (dry-run, khong ghi): ${b.baseline.date}` : b.ok ? `baseline da chot: ${b.baseline.date}` : 'baseline: khong ghi duoc'); }
    let md = res.markdown;
    if (o.out === 'obsidian' && !o.dryRun) {
      const p = putObsidian(md);
      if (p.ok) { if (o.weekly) markRun(); notes.push('da put vao Obsidian'); md = null; }
      else notes.push(`khong put duoc (${p.reason}) - in stdout de hub tu put`);
    } else if (o.weekly && !o.dryRun) markRun();
    const summary = [md, notes.length && `ghi chu: ${notes.join('; ')}`].filter(Boolean).join('\n');
    emit({ summary, data: { markdown: res.markdown, notes, truncated: res.truncated, errors: res.errors }, truncated: res.truncated, raw: md ?? '' }, { json: o.json, raw: o.raw, maxBytes: o.maxBytes });
    return 0;
  } catch (e) { console.error('report: ' + e.message + '\n' + USAGE); return 2; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((c) => { process.exitCode = c; });
