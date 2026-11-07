#!/usr/bin/env node
// harness evolve candidates|propose|check|apply|rollback|log|list. Xem README.md.
// Chung: --json --raw --max-bytes N --timeout-s N (scan audit).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommon, emit, posInt, capLines } from '../../core/io/out.mjs';
import { findPatterns } from './patterns.mjs';
import { runAutopilot, queueOp, confirmTty } from './autopilot.mjs';
import { findCandidates, propose, check, apply, rollback, readLog, listProposals, LIMITS } from './loop.mjs';

const USAGE = 'evolve scan [--kind error|pattern|deprecate] [--days N] [--limit N] [--threshold N] [--sessions K] [--source ext:<id>] [--record] | propose <cid> [--kind skill] [--target F] | check <pid> | apply <pid> --approve | rollback <ver> --approve [--force] | log [--limit N] | list | autopilot [--dry-run] [--force] | queue [--approve <id>|--reject <id>]';

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
    else if (k === '--sessions') o.sessions = posInt(val());
    else if (k === '--record') o.record = true;
    else if (k === '--reject') o.reject = true;
    else if (k === '--dry-run') o.dryRun = true;
    else if (k === '--limit') o.limit = posInt(val());
    else if (k === '--kind') o.kind = val();
    else if (k === '--source') o.source = val();
    else if (k === '--target') o.target = val();
    else if (k === '--approve') o.approve = true;
    else if (k === '--force') o.force = true;
    else if (k === '--cost') o.cost = true;
    else if (k === '--by-project') o.byProject = true;
    else if (k === '--detail') o.detail = val();
    else if (!o.cmd && !a.startsWith('-')) o.cmd = a;
    else if (!o.arg && !a.startsWith('-')) o.arg = a;
    else throw new Error(`tham so la: ${a}`);
  }
  return o;
}

const SCAN_KINDS = ['error', 'pattern', 'deprecate'];
const SCANNERS = {
  async error(o) {
      const r = await findCandidates({ ...o, maxBytes: undefined });
      const items = r.items.slice(0, o.limit || LIMITS.listLimit);
      const lines = [`evolve scan error: ${r.total} loi lap >= ${r.threshold} lan / ${r.days} ngay (quet ${r.scanned} su kien)`,
        ...items.map((x) => `${x.id}  x${x.count}  phien=${x.sessions}  ${x.tool}  fp=${x.fp || '-'}  ${x.sample.slice(0, 90)}`)];
      return { code: 0, summary: capLines(lines, 40).join('\n'), data: { ...r, items }, truncated: r.truncated };
  },
  async pattern(o) {
      const r = await findPatterns({ ...o, maxBytes: undefined });
      const items = r.items.slice(0, o.limit || LIMITS.listLimit);
      const lines = [`evolve scan pattern: ${r.total} quy trinh lap / ${r.days} ngay (quet ${r.scanned} su kien)${r.truncated ? ` truncated: ${r.truncated}` : ''}`,
        ...(r.skipped.prompt ? [`bo qua prompt: ${r.skipped.prompt}`] : []),
        ...items.map((x) => `${x.id}  ${x.subkind}  x${x.count}  phien=${x.sessions}  ${x.cost_ms}ms  ${x.sample.slice(0, 110)}`)];
      return { code: 0, summary: capLines(lines, 40).join('\n'), data: { ...r, items }, truncated: r.truncated };
  },
  deprecate: (o) => import('./prune-cli.mjs').then((m) => m.runPrune(o)),
};

export async function render(o) {
  const need = () => { if (!o.arg) throw new Error(`thieu id\n${USAGE}`); return o.arg; };
  if (o.cmd === 'autopilot') {
    const r = await runAutopilot({ dryRun: o.dryRun, force: o.force });
    const L = (t, a) => a.map((x) => `  ${t}: ${x.entry || x.ver || x.id || x.fp || x} ${x.reason || ''}`.trimEnd());
    const lines = [`evolve autopilot${r.dryRun ? ' (dry-run, khong ghi)' : ''}${r.skipped ? `: bo qua - ${r.skipped}` : ''}`,
      `ap dung ${r.applied.length} | xep hang ${r.queued.length} | ke hoach ${r.planned.length} | tu choi ${r.refused.length} | rollback ${r.rolledBack.length} | giu ${r.kept.length} | loi ${r.errors.length}`,
      ...L('ap', r.applied), ...L('hang', r.queued), ...L('ke hoach', r.planned), ...L('cam', r.refused), ...L('rollback', r.rolledBack), ...r.errors.map((e) => `  loi: ${e}`)];
    return { code: r.errors.length ? 1 : 0, summary: capLines(lines, 40).join('\n'), data: r };
  }
  if (o.cmd === 'queue') {
    const r = await queueOp({ approve: o.approve ? o.arg : null, reject: o.reject ? o.arg : null });
    if (r.items) return { code: 0, summary: capLines([`evolve queue: ${r.items.length} cho duyet / ${r.total}`, ...r.items.flatMap((q) => [`${q.id}  ${q.kind} -> ${q.target || '-'}  ${q.reason}`, ...(q.sha ? [`  sha256=${q.sha}`] : []), ...(q.after_preview ? q.after_preview.split('\n').map((l) => `  | ${l}`) : []), ...(q.after_truncated ? ['  | ... (cat 40 dong)'] : [])])], 200).join('\n'), data: r };
    return { code: r.code, summary: r.code === 0 ? `queue ${r.id}: ${r.status}${r.ver ? ` (ver ${r.ver})` : r.manual ? ' (sua tay: khong co duong ap tu dong)' : ''}` : `queue tu choi: ${r.reason}`, data: r };
  }
  if (o.cmd === 'scan') {
    const kinds = o.kind ? [o.kind] : ['error', 'pattern', 'deprecate'];
    if (kinds.some((k) => !SCAN_KINDS.includes(k))) throw new Error(`--kind phai thuoc ${SCAN_KINDS.join('|')}`);
    const rs = [];
    for (const k of kinds) rs.push(await SCANNERS[k](o));
    return { code: 0, summary: rs.map((r) => r.summary).join('\n'), data: o.kind ? rs[0].data : Object.fromEntries(kinds.map((k, i) => [k, rs[i].data])), truncated: rs.find((r) => r.truncated)?.truncated };
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
    // Cong duyet: --approve qua CLI phai co nguoi xac nhan TTY (nhu queue --approve). Chi autopilot noi bo (goi ham) tu duyet muc 1.
    const gate = o.approve ? await confirmTty(`Ap dung ${need()} (evolve apply)?`, o) : true;
    if (gate === null) return { code: 2, summary: 'apply: can TTY de xac nhan (agent khong tu duyet)', data: { ok: false, code: 2, reason: 'can TTY (agent khong tu duyet)' } };
    if (gate === false) return { code: 1, summary: 'apply: khong dong y', data: { ok: false, code: 1, reason: 'khong dong y' } };
    const r = apply(need(), o);
    const s = r.ok ? `da ap ${o.arg} -> ${r.target} (ver ${r.ver}); hoan tac: evolve rollback ${r.ver}` : `apply tu choi: ${r.reason}${r.manual ? `\n${r.manual}` : ''}`;
    return { code: r.code, summary: s, data: r };
  }
  if (o.cmd === 'rollback') {
    const gate = o.approve ? await confirmTty(`Khoi phuc ${need()} (evolve rollback)?`, o) : true;
    if (gate === null) return { code: 2, summary: 'rollback: can TTY de xac nhan (agent khong tu duyet)', data: { ok: false, code: 2, reason: 'can TTY (agent khong tu duyet)' } };
    if (gate === false) return { code: 1, summary: 'rollback: khong dong y', data: { ok: false, code: 1, reason: 'khong dong y' } };
    const r = rollback(need(), o);
    return { code: r.code, summary: r.ok ? `da khoi phuc ${r.target} (ver ${r.ver})` : `rollback tu choi: ${r.reason}`, data: r };
  }
  if (o.cmd === 'log') {
    const r = readLog(o);
    const lines = [`evolve log: ${r.items.length}/${r.total}`, ...r.items.map((x) => `${x.ts}  ${x.op.padEnd(8)} ${x.ok === false ? 'FAIL' : 'ok  '} ${x.id || x.ver || ''} ${x.ver && x.id ? x.ver : ''} ${x.op === 'effect' ? `${x.verdict}/${x.action} ` : ''}${x.reason || x.target || ''}`)];
    return { code: 0, summary: capLines(lines, 40).join('\n'), data: r, truncated: r.truncated };
  }
  if (o.cmd === 'list') {
    const ps = listProposals(o);
    const lines = [`evolve proposals: ${ps.length}`, ...ps.map((p) => `${p.id}  ${p.status}  ${p.kind} -> ${p.change.target}${p.ver ? `  ver=${p.ver}` : ''}${p.effect && p.effect.verdict ? `  verdict=${p.effect.verdict}` : ''}`)];
    return { code: 0, summary: capLines(lines, 40).join('\n'), data: ps.map(({ change, ...p }) => ({ ...p, target: change.target })) };
  }
  throw new Error(`lenh la: ${o.cmd ?? '(trong)'}\n${USAGE}`);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const o = parseArgs(argv);
    if (!o.cmd) { console.log(USAGE); return 0; }
    const r = await render(o);
    emit(r, { json: o.json, raw: o.raw, maxBytes: o.maxBytes });
    return r.code;
  } catch (e) { console.error('evolve: ' + e.message); return 2; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((c) => { process.exitCode = c; });
