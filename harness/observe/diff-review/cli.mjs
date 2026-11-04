#!/usr/bin/env node
// harness review pack [dir] [--base R] [--json] [--raw] [--max-bytes N] [--timeout-s N]: goi review tat dinh tu git diff (base = merge-base main|master|origin/HEAD,
// gom thay doi chua commit). Chi doc; stdout <= 40 dong, khong chua noi dung dong diff. Phan doan de cho /code-review, /security-review, subagent reviewer.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCommon, emit, capLines } from '../../core/io/out.mjs';
import { LIMITS, FLAGS, buildPack, parseNumstat, parseNameStatus, parseAddedLines } from './pack.mjs';

const USAGE = 'review pack [dir] [--base R] [--json] [--raw] [--max-bytes N] [--timeout-s N]';
const BASES = ['main', 'master', 'origin/HEAD'];
const EVIDENCE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'evidence', 'cli.mjs'); // spawn, khong import (nhom con observe/evidence)

/** Thu thap git (spawnSync co timeout). Tra {status:'ok'|'not-git'|'no-base', ...}; khong nem. withEvidence=false bo qua doc audit (hook). */
export function collectGit({ cwd = process.cwd(), base = null, timeoutMs = LIMITS.timeoutMs, withEvidence = true } = {}) {
  const t0 = Date.now();
  const left = () => Math.max(0, timeoutMs - (Date.now() - t0));
  let timedOut = false;
  let top = null; // goc repo (git rev-parse --show-toplevel); lenh sau do chay trong top
  // Chi doc: khong khoa/cap nhat index (GIT_OPTIONAL_LOCKS=0), khong chay chuong trinh ngoai (--no-ext-diff/--no-textconv ben duoi), ten file khong bi quote.
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const git = (args) => {
    const t = left();
    if (t <= 0) { timedOut = true; return null; }
    const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: top || cwd, encoding: 'utf8', timeout: t, maxBuffer: LIMITS.readMaxBytes, windowsHide: true, env });
    if (r.error) { if (r.error.code === 'ETIMEDOUT') timedOut = true; return r.error.code === 'ENOBUFS' ? { status: 0, stdout: '', over: true } : null; }
    return r;
  };
  const out = (args) => { const r = git(args); return r && r.status === 0 ? r.stdout.trim() : null; };
  const to = () => (timedOut ? 'timeout' : null);

  top = out(['rev-parse', '--show-toplevel']);
  if (!top) return { status: 'not-git', dir: cwd, truncated: to() };
  const head = out(['rev-parse', '--short', 'HEAD']);
  if (!head) return { status: 'no-base', reason: 'repo chua co commit', repo: top, truncated: to() };
  let ref = null; let mb = null;
  for (const c of base ? [base] : BASES) {
    if (!out(['rev-parse', '--verify', '--quiet', `${c}^{commit}`])) continue;
    mb = out(['merge-base', c, 'HEAD']);
    if (mb) { ref = c; break; }
  }
  if (!mb) return { status: 'no-base', reason: `khong tim thay base (${(base ? [base] : BASES).join('|')})`, head, repo: top, truncated: to() };
  const baseSha = out(['rev-parse', '--short', mb]) || mb;

  const common = ['diff', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', mb];
  const ns = git([...common, '--numstat']);
  const st = git([...common, '--name-status']);
  const ad = git([...common, '-U0']);
  const un = out(['ls-files', '--others', '--exclude-standard']);
  let truncated = to();
  if ((ns && ns.over) || (ad && ad.over)) truncated = truncated || 'max_bytes';
  let evidence = null;
  const et = left();
  if (withEvidence && et > 0) {
    try { // spawn evidence summary (chi doc audit; tran rieng 3s) -> kinds.test.fresh_pass
      const r = spawnSync(process.execPath, [EVIDENCE_CLI, 'summary', '--json', '--timeout-s', '2'], { encoding: 'utf8', timeout: Math.min(et, 3000), maxBuffer: LIMITS.readMaxBytes, windowsHide: true });
      const s = r.status === 0 ? JSON.parse(r.stdout) : null;
      evidence = s && s.kinds ? { kinds: s.kinds } : null;
    } catch { evidence = null; }
  }
  return {
    status: 'ok', head, repo: top, base: baseSha, ref, evidence, truncated, untracked: un ? un.split('\n').filter(Boolean).length : 0,
    numstat: ns && ns.stdout ? parseNumstat(ns.stdout) : [], nameStatus: st && st.stdout ? parseNameStatus(st.stdout) : {},
    addedLines: ad && ad.stdout ? parseAddedLines(ad.stdout) : [],
  };
}

/** collectGit() -> pack (chi khi status ok). */
export const packOf = (c) => buildPack({ numstat: c.numstat, nameStatus: c.nameStatus, addedLines: c.addedLines, evidence: c.evidence, base: c.base, ref: c.ref, head: c.head, repo: c.repo, truncated: c.truncated });

const flagStr = (flags) => FLAGS.filter((f) => flags[f]).map((f) => `${f}=${flags[f]}`).join(' ');

/** pack -> mang dong (dong dau neu base). Dung chung cho CLI va hook (maxBundles dong bundle). */
export function packLines(p, { untracked = 0 } = {}) {
  const nf = p.bundles.reduce((n, b) => n + b.files.length, 0);
  const add = p.bundles.reduce((n, b) => n + b.files.reduce((m, f) => m + f.add, 0), 0);
  const del = p.bundles.reduce((n, b) => n + b.files.reduce((m, f) => m + f.del, 0), 0);
  const lines = [`review pack: repo=${p.repo} base=${p.ref || '-'}@${p.base} head=${p.head} | ${nf} file +${add} -${del} | ${p.bundles.length} bundle${p.truncated ? ' | truncated: ' + p.truncated : ''}`];
  if (Object.keys(p.flags).length) lines.push(`co: ${flagStr(p.flags)}`);
  for (const b of p.bundles) {
    const fl = FLAGS.map((f) => [f, b.files.filter((x) => x.flags.includes(f)).length]).filter(([, n]) => n).map(([f, n]) => `${f}:${n}`).join(' ');
    lines.push(`${b.id} (${b.files.length} file, ${b.lines} dong)${fl ? ' [' + fl + ']' : ''}: ${b.cmd}`);
  }
  const at = p.bundles.flatMap((b) => b.files.flatMap((f) => f.at || []));
  if (at.length) lines.push(`secret-like tai: ${at.slice(0, 8).join(' ')}${at.length > 8 ? ' ...' : ''}`);
  if (untracked) lines.push(`(+${untracked} file chua theo doi, khong nam trong diff)`);
  return lines;
}

export function parseArgs(argv) {
  const c = parseCommon(argv);
  const o = { cmd: null, json: c.json, raw: c.raw, maxBytes: c.maxBytes, timeoutMs: c.timeoutS ? c.timeoutS * 1000 : LIMITS.timeoutMs, base: null, dir: null };
  const r = c.rest;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const [k, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    if (k === '--base') o.base = inline !== null ? inline : r[++i];
    else if (!o.cmd && !a.startsWith('-')) o.cmd = a;
    else if (o.cmd && !o.dir && !a.startsWith('-')) o.dir = a;
    else throw new Error(`tham so la: ${a}`);
  }
  return o;
}

export function render(o, cwd = process.cwd()) {
  if (o.cmd !== 'pack') throw new Error(`lenh la: ${o.cmd ?? '(trong)'}\n${USAGE}`);
  // Qua cong `harness` CLI chay voi cwd = thu muc plugin (cong khong truyen cwd cua nguoi goi): khong co dir thi khong biet repo nao.
  if (!o.dir && process.env.HARNESS_GATEWAY === '1') throw new Error('qua cong harness can chi ro repo: harness review pack <dir> (cong chay CLI voi cwd = thu muc plugin)');
  if (o.dir && process.env.HARNESS_GATEWAY === '1' && !path.isAbsolute(o.dir)) throw new Error('qua cong harness, dir phai la duong dan tuyet doi (cong chay CLI voi cwd = thu muc plugin, khong resolve duoc duong dan tuong doi)');
  const c = collectGit({ cwd: o.dir ? path.resolve(cwd, o.dir) : cwd, base: o.base, timeoutMs: o.timeoutMs });
  if (c.status === 'not-git') return { summary: c.truncated ? `review pack: truncated: ${c.truncated} (chua xac dinh duoc repo)` : 'review pack: khong phai git repo (bo qua)', data: { status: 'not-git', bundles: [], flags: {} }, truncated: c.truncated };
  if (c.status === 'no-base') return { summary: `review pack: ${c.reason} (bo qua)`, data: { status: 'no-base', reason: c.reason, bundles: [], flags: {} }, truncated: c.truncated };
  const p = packOf(c);
  const lines = c.numstat.length ? packLines(p, { untracked: c.untracked }) : [`review pack: repo=${c.repo} base=${c.ref}@${c.base} head=${c.head} | ${c.truncated ? 'truncated: ' + c.truncated + ' (chua lay du diff)' : 'khong co thay doi so voi base'}`];
  return { summary: capLines(lines, LIMITS.maxLines).join('\n'), data: { status: 'ok', ...p, untracked: c.untracked }, truncated: p.truncated, raw: JSON.stringify(c.numstat, null, 2) };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const o = parseArgs(argv);
    if (!o.cmd) { console.log(USAGE); return 0; }
    emit(render(o), { json: o.json, raw: o.raw, maxBytes: o.maxBytes });
    return 0;
  } catch (e) { console.error('review: ' + e.message); return 2; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
