#!/usr/bin/env node
// harness evolve candidates|propose|check|apply|rollback|log|list. Xem README.md.
// Chung: --json --raw --max-bytes N --timeout-s N (scan audit).
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCommon, emit, posInt, capLines } from '../../core/io/out.mjs';
import { findCandidates, propose, check, apply, rollback, readLog, listProposals, LIMITS } from './loop.mjs';

const USAGE = 'evolve candidates [--days N] [--threshold N] [--limit N] [--source ext:<id>] | propose <cid> [--kind skill] [--target F] | check <pid> | apply <pid> --approve | rollback <ver> --approve [--force] | log [--limit N] | list | eval run|list|baseline|compare|bench';

export function parseArgs(argv) {
  const c = parseCommon(argv);
  const o = { cmd: null, arg: null, json: c.json, raw: c.raw, maxBytes: c.maxBytes, timeoutMs: c.timeoutS ? c.timeoutS * 1000 : LIMITS.scanTimeoutMs };
  const r = c.rest;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const [k, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const val = () => (inline !== null ? inline : r[++i]);
    if (k === '--days') o.days = posInt(val());
    else if (k === '--threshold') o.threshold = posInt(val());
    else if (k === '--limit') o.limit = posInt(val());
    else if (k === '--kind') o.kind = val();
    else if (k === '--source') o.source = val();
    else if (k === '--target') o.target = val();
    else if (k === '--approve') o.approve = true;
    else if (k === '--force') o.force = true;
    else if (!o.cmd && !a.startsWith('-')) o.cmd = a;
    else if (!o.arg && !a.startsWith('-')) o.arg = a;
    else throw new Error(`tham so la: ${a}`);
  }
  return o;
}

export async function render(o) {
  const need = () => { if (!o.arg) throw new Error(`thieu id\n${USAGE}`); return o.arg; };
  if (o.cmd === 'candidates') {
    const r = await findCandidates({ ...o, maxBytes: undefined });
    const items = r.items.slice(0, o.limit || LIMITS.listLimit);
    const lines = [`evolve candidates: ${r.total} loi lap >= ${r.threshold} lan / ${r.days} ngay (quet ${r.scanned} su kien)`,
      ...items.map((x) => `${x.id}  x${x.count}  phien=${x.sessions}  ${x.tool}  fp=${x.fp || '-'}  ${x.sample.slice(0, 90)}`)];
    return { code: 0, summary: capLines(lines, 40).join('\n'), data: { ...r, items }, truncated: r.truncated };
  }
  if (o.cmd === 'propose') {
    const p = await propose(need(), o);
    const s = `de xuat ${p.id}: ${p.kind} -> ${p.change.target} (tuong doi goc du lieu; ${p.status}${p.policy.ok ? '' : `: ${p.policy.reason}`})\nbang chung: fp=${p.evidence.fp || '-'} x${p.evidence.count} | ${p.evidence.sample.slice(0, 120)}\ntiep: evolve check ${p.id}`;
    return { code: 0, summary: s, data: p };
  }
  if (o.cmd === 'check') {
    const p = check(need(), o);
    const ck = p.check;
    // Oracle bo qua -> nhan SKIPPED (khong PASS): chi qua kiem policy/sha, chua eval that; van cho apply (exit 0), apply tu kiem lai.
    const label = !ck.ok ? 'LOAI' : ck.verdict === 'skipped' ? 'SKIPPED (policy+sha ok, chua eval; co the apply --approve sau khi nguoi doc noi dung)' : 'PASS';
    const s = `check ${p.id}: ${label}${ck.reason ? ` - ${ck.reason}` : ''}\noracle: ${ck.oracle || '-'}`;
    return { code: ck.ok ? 0 : 1, summary: s, data: p };
  }
  if (o.cmd === 'apply') {
    const r = apply(need(), o);
    const s = r.ok ? `da ap ${o.arg} -> ${r.target} (ver ${r.ver}); hoan tac: evolve rollback ${r.ver}` : `apply tu choi: ${r.reason}${r.manual ? `\n${r.manual}` : ''}`;
    return { code: r.code, summary: s, data: r };
  }
  if (o.cmd === 'rollback') {
    const r = rollback(need(), o);
    return { code: r.code, summary: r.ok ? `da khoi phuc ${r.target} (ver ${r.ver})` : `rollback tu choi: ${r.reason}`, data: r };
  }
  if (o.cmd === 'log') {
    const r = readLog(o);
    const lines = [`evolve log: ${r.items.length}/${r.total}`, ...r.items.map((x) => `${x.ts}  ${x.op.padEnd(8)} ${x.ok === false ? 'FAIL' : 'ok  '} ${x.id || x.ver || ''} ${x.ver && x.id ? x.ver : ''} ${x.reason || x.target || ''}`)];
    return { code: 0, summary: capLines(lines, 40).join('\n'), data: r, truncated: r.truncated };
  }
  if (o.cmd === 'list') {
    const ps = listProposals(o);
    const lines = [`evolve proposals: ${ps.length}`, ...ps.map((p) => `${p.id}  ${p.status}  ${p.kind} -> ${p.change.target}${p.ver ? `  ver=${p.ver}` : ''}`)];
    return { code: 0, summary: capLines(lines, 40).join('\n'), data: ps.map(({ change, ...p }) => ({ ...p, target: change.target })) };
  }
  throw new Error(`lenh la: ${o.cmd ?? '(trong)'}\n${USAGE}`);
}

// evolve eval ... -> evolve/eval/cli.mjs (domain `eval` cu la alias). Khong import (contract cam loop -> eval): spawn con.
// Tran con < tran cong (harness.mjs: timeout-s + 5s) de con tu dung truoc khi cong kill; het han thi diet ca cay tien trinh (Windows: taskkill /T).
export const EVAL_TIMEOUT_MS = 110000;
export function evalTimeoutMs(args) {
  const i = args.findIndex((a) => a === '--timeout-s' || a.startsWith('--timeout-s='));
  const v = i < 0 ? NaN : Number(args[i].includes('=') ? args[i].split('=')[1] : args[i + 1]);
  return Number.isFinite(v) && v > 0 ? v * 1000 : EVAL_TIMEOUT_MS;
}
function runEval(args, { script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'eval', 'cli.mjs') } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', timeout: evalTimeoutMs(args) });
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT' && r.pid && process.platform === 'win32') spawnSync('taskkill', ['/PID', String(r.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
    console.error(r.error.code === 'ETIMEDOUT' ? 'truncated: timeout' : r.error.message);
    return 2;
  }
  return r.status ?? 1;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'eval') return runEval(argv.slice(1));
  try {
    const o = parseArgs(argv);
    if (!o.cmd) { console.log(USAGE); return 0; }
    const r = await render(o);
    emit(r, { json: o.json, raw: o.raw, maxBytes: o.maxBytes });
    return r.code;
  } catch (e) { console.error('evolve: ' + e.message); return 2; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((c) => { process.exitCode = c; });
