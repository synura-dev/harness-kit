#!/usr/bin/env node
// harness eval run|list|baseline|compare|bench [bench: xem bench/hook-latency.mjs] [--case S] [--cases-dir D] [--baseline-file F] [--hub-config-dir D] [--force] [--case-timeout-s N] [--timeout-s N] [--json] [--max-bytes N]
// Oracle tat dinh cho chinh harness (khong LLM). run: exit 1 neu co ca truot. compare: exit 1 neu co ca MOI truot so voi baseline, 2 neu chua co baseline.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommon, emit } from '../../core/io/out.mjs';
import { main as benchMain } from './bench/hook-latency.mjs';
import { loadCases, runAll, saveBaseline, readBaseline, compare, baselineFile, CASES_DIR, LIMITS } from './eval.mjs';

const USAGE = 'eval run|list|baseline|compare|bench [bench: --event E --n N --out F] [--case S] [--cases-dir D] [--baseline-file F] [--hub-config-dir D] [--force] [--case-timeout-s N] [--timeout-s N] [--json]';
const CMDS = ['run', 'list', 'baseline', 'compare'];
const posSec = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

export function parseArgs(argv) {
  const c = parseCommon(argv);
  const o = { cmd: null, json: c.json, raw: c.raw, maxBytes: c.maxBytes, totalTimeoutMs: c.timeoutS ? c.timeoutS * 1000 : LIMITS.totalTimeoutMs,
    caseTimeoutMs: LIMITS.caseTimeoutMs, dir: CASES_DIR, file: null, filter: null, hubConfigDir: null, force: false };
  const r = c.rest;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const [k, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const val = () => { const v = inline !== null ? inline : r[++i]; if (v === undefined) throw new Error(`thieu gia tri cho ${k}`); return v; };
    if (k === '--case') o.filter = val();
    else if (k === '--cases-dir') o.dir = path.resolve(val());
    else if (k === '--baseline-file') o.file = path.resolve(val());
    else if (k === '--hub-config-dir') o.hubConfigDir = path.resolve(val());
    else if (k === '--force' && inline === null) o.force = true;
    else if (k === '--case-timeout-s') { const n = posSec(val()); if (!n) throw new Error('--case-timeout-s phai > 0'); o.caseTimeoutMs = n * 1000; }
    else if (!o.cmd && !a.startsWith('-')) o.cmd = a;
    else throw new Error(`tham so la: ${a}`);
  }
  return o;
}

const caseLine = (c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.id} (${c.ms}ms)${c.ok ? '' : ' ' + (c.got.error || (c.got.miss || []).join('; '))}`;
function runSummary(r, title) {
  const lines = [`${title}: ${r.pass}/${r.total} pass, ${r.fail} fail (${r.ms}ms)`];
  for (const e of r.errors) lines.push(`loi ca: ${e}`);
  for (const c of r.cases) if (!c.ok) lines.push(caseLine(c));
  return lines;
}

export function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'bench') return benchMain(argv.slice(1)); // do do tre hook: cờ riêng, mac dinh chi in stdout
  let o;
  try { o = parseArgs(argv); } catch (e) { console.error('eval: ' + e.message + '\n' + USAGE); return 2; }
  if (!o.cmd) o.cmd = 'run'; // cong harness.mjs bo tu 'run' dau tien -> rong = run
  if (o.cmd === 'help') { console.log(USAGE); return 0; }
  if (!CMDS.includes(o.cmd)) { console.error(`eval: lenh la: ${o.cmd}\n${USAGE}`); return 2; }
  const out = { json: o.json, raw: o.raw, maxBytes: o.maxBytes };
  try {
    if (o.cmd === 'list') {
      const { cases, errors } = loadCases(o.dir, { filter: o.filter });
      const lines = [`eval list: ${cases.length} ca`, ...errors.map((e) => `loi ca: ${e}`), ...cases.map((c) => `${c.group.padEnd(12)} ${c.id.padEnd(38)} ${c.run.kind}  ${c.desc || ''}`)];
      emit({ summary: lines.join('\n'), data: { total: cases.length, errors, cases: cases.map(({ id, group, desc, run }) => ({ id, group, desc, kind: run.kind })) } }, out);
      return errors.length ? 1 : 0;
    }
    const opts = { dir: o.dir, filter: o.filter, caseTimeoutMs: o.caseTimeoutMs, totalTimeoutMs: o.totalTimeoutMs, hubConfigDir: o.hubConfigDir };
    const file = o.file || baselineFile();
    if (o.cmd === 'compare') {
      const base = readBaseline(file);
      if (!base) { console.error(`eval compare: chua co baseline (${file}); chay 'eval baseline' truoc`); return 2; }
      const r = runAll(opts);
      const c = compare(r, base);
      const lines = [`eval compare [config ${r.config}]: ${r.pass}/${r.total} pass (baseline ${base.pass}/${base.cases.length} luc ${base.at})`,
        `moi truot: ${c.newFail.join(', ') || '-'}`, `moi dat: ${c.newPass.join(', ') || '-'}`];
      if (c.added.length) lines.push(`ca moi: ${c.added.join(', ')}`);
      if (c.removed.length) lines.push(`ca bi bo: ${c.removed.join(', ')}`);
      for (const x of r.cases) if (!x.ok) lines.push(caseLine(x));
      emit({ summary: lines.join('\n'), data: { ...c, config: r.config, errors: r.errors, truncated: r.truncated, cases: r.cases }, truncated: r.truncated }, out);
      return c.regressed || r.errors.length ? 1 : 0;
    }
    const r = runAll(opts);
    const lines = runSummary(r, `eval ${o.cmd} [config ${r.config}]`);
    if (o.cmd === 'baseline') {
      if (!o.force && (r.fail || r.errors.length)) lines.push('KHONG ghi baseline: co ca truot/loi ca (khong ha chuan; --force can nguoi duyet)');
      else lines.push(`da luu baseline: ${saveBaseline(r, file, { force: o.force })}`);
    }
    emit({ summary: lines.join('\n'), data: r, truncated: r.truncated }, out);
    return r.fail || r.errors.length ? 1 : 0;
  } catch (e) { console.error('eval: ' + e.message); return 2; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
