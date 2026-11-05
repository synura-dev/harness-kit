#!/usr/bin/env node
// dev/eval/bench/hook-latency.mjs - do do tre hook Claude Code: doc .claude/settings.json, chay lenh hook THAT qua bash,
// bao p50/p95 moi hook + chuoi tuan tu moi event. Chi doc settings, khong sua harness.
// Goi qua cong: node harness/cli/harness.mjs eval bench [--event E[,E2]] [--n N] [--timeout-s N] [--settings F] [--project-dir D] [--bash PATH] [--json] [--out F [--force]]
// MAC DINH chi in stdout (markdown; --json = JSON). CHI ghi file khi co --out <path>; khong bao gio ghi de docs/research/hook-latency-baseline.md
// va khong ghi de file co san neu thieu --force. Tran: --n (mac dinh 20), --timeout-s tran tong (mac dinh 300; het gio dung em, truncated: timeout).
// Hook chay that => audit ghi session `latency-base` (chap nhan).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from '../../../harness/core/runtime/proc.mjs';
import { fileURLToPath } from 'node:url';
import { workspaceRoot, samePath } from '../../../harness/core/io/paths.mjs';
import { loadConfig } from '../../../harness/core/config/config.mjs';

const EVENTS = Object.freeze(['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit']);
export const LIMITS = Object.freeze({ n: 20, maxN: 200, totalTimeoutS: 300, hookTimeoutS: 5, maxBuffer: 1048576 });
const SAMPLE_TOOL = 'Bash';
// Shell cua hook tren Windows = Git Bash (KHONG dung `bash` tran: co the la WSL). Uu tien --bash > env HARNESS_BASH > <ProgramFiles>/Git/bin/bash.exe > `bash`.
const findBash = (explicit) => {
  if (explicit) return explicit;
  if (process.env.HARNESS_BASH) return process.env.HARNESS_BASH;
  for (const pf of [process.env.ProgramFiles, process.env.ProgramW6432, process.env['ProgramFiles(x86)']]) {
    if (!pf) continue;
    const f = path.join(pf, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(f)) return f;
  }
  return 'bash';
};
const USAGE = 'eval bench [--event E[,E2]] [--n N] [--timeout-s N] [--settings F] [--project-dir D] [--bash PATH] [--json] [--out F [--force]]';

const payloads = (cwd) => {
  const base = { session_id: 'latency-base', cwd };
  return {
    PreToolUse: { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'latency-pre' },
    PostToolUse: { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: '', stderr: '', interrupted: false }, tool_use_id: 'latency-post' },
    Stop: { ...base, hook_event_name: 'Stop', stop_hook_active: false },
    UserPromptSubmit: { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'ls' },
  };
};

// Matcher: PreToolUse/PostToolUse loc theo ten tool (regex neo); Stop/UserPromptSubmit khong co matcher.
function matches(group, event) {
  if (event !== 'PreToolUse' && event !== 'PostToolUse') return true;
  const m = group.matcher;
  if (!m || m === '*') return true;
  try { return new RegExp(`^(?:${m})$`).test(SAMPLE_TOOL); } catch { return false; }
}
const labelOf = (cmd) => {
  const m = String(cmd).match(/\$CLAUDE_PROJECT_DIR\/([^"]+)"?(.*)$/);
  return m ? (m[1] + m[2]).trim() : String(cmd);
};

/** Danh sach hook command khop matcher cho cac event. */
export function collectEntries(settings, events = EVENTS) {
  const entries = [];
  for (const ev of events) {
    for (const g of (settings && settings.hooks && settings.hooks[ev]) || []) {
      if (!matches(g, ev)) continue;
      for (const h of g.hooks || []) {
        if (h.type !== 'command' || typeof h.command !== 'string') continue;
        entries.push({ event: ev, matcher: g.matcher ?? '(none)', command: h.command, label: labelOf(h.command), timeout: Number(h.timeout) > 0 ? Number(h.timeout) : LIMITS.hookTimeoutS });
      }
    }
  }
  return entries;
}

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
}
const stats = (runs) => {
  const ms = runs.map((r) => r.ms);
  return {
    n: runs.length, p50: r1(pct(ms, 0.5)), p95: r1(pct(ms, 0.95)),
    min: ms.length ? r1(Math.min(...ms)) : null, max: ms.length ? r1(Math.max(...ms)) : null,
    nonZeroExit: runs.filter((r) => r.status !== 0).length, timedOut: runs.filter((r) => r.timedOut).length,
  };
};

/** Chay do. opts: {settings (obj), projectDir, bash, n, events[], totalTimeoutMs}. Tra {meta, hooks, chains, truncated}. */
function runBench(opts) {
  const n = opts.n > 0 ? Math.min(opts.n, LIMITS.maxN) : LIMITS.n;
  const events = opts.events && opts.events.length ? opts.events : EVENTS;
  const projectDir = opts.projectDir;
  const bash = findBash(opts.bash);
  const t0 = Date.now();
  const deadline = t0 + (opts.totalTimeoutMs > 0 ? opts.totalTimeoutMs : LIMITS.totalTimeoutS * 1000);
  const entries = collectEntries(opts.settings, events);
  const pl = payloads(projectDir);
  const runOnce = (e) => {
    const t = process.hrtime.bigint();
    const r = spawnSync(bash, ['-c', e.command], {
      input: JSON.stringify(pl[e.event]), cwd: projectDir, encoding: 'utf8', windowsHide: true, maxBuffer: LIMITS.maxBuffer,
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir }, timeout: Math.min(e.timeout * 1000, Math.max(1000, deadline - Date.now())),
    });
    return { ms: Number(process.hrtime.bigint() - t) / 1e6, status: r.status, timedOut: !!(r.error && r.error.code === 'ETIMEDOUT'), spawnError: r.error && r.error.code !== 'ETIMEDOUT' ? r.error.code || 'error' : null };
  };
  const out = { meta: { startedAt: new Date(t0).toISOString(), n, events, bash, node: process.version, platform: process.platform, sampleTool: SAMPLE_TOOL, projectDir }, hooks: [], chains: [], truncated: null };
  // 1) tung hook rieng le, n lan
  outer: for (const e of entries) {
    const runs = [];
    for (let i = 0; i < n; i++) {
      if (Date.now() > deadline) { out.truncated = 'timeout'; if (runs.length) out.hooks.push({ event: e.event, matcher: e.matcher, label: e.label, partial: true, ...stats(runs) }); break outer; }
      runs.push(runOnce(e));
    }
    out.hooks.push({ event: e.event, matcher: e.matcher, label: e.label, ...stats(runs) });
  }
  // 2) chuoi tuan tu moi event (cac hook khop matcher), tong moi vong. Bo qua neu da het gio.
  if (!out.truncated) {
    chains: for (const ev of events) {
      const chain = entries.filter((e) => e.event === ev);
      if (!chain.length) continue;
      const totals = [];
      const asRuns = () => totals.map((ms) => ({ ms, status: 0, timedOut: false }));
      for (let i = 0; i < n; i++) {
        if (Date.now() > deadline) { out.truncated = 'timeout'; if (totals.length) out.chains.push({ event: ev, hooks: chain.length, partial: true, ...stats(asRuns()) }); break chains; }
        let sum = 0;
        for (const e of chain) sum += runOnce(e).ms;
        totals.push(sum);
      }
      out.chains.push({ event: ev, hooks: chain.length, ...stats(asRuns()) });
    }
  }
  out.meta.finishedAt = new Date().toISOString();
  out.meta.elapsedSec = Math.round((Date.now() - t0) / 1000);
  return out;
}

const row = (...c) => `| ${c.join(' | ')} |`;
function renderMarkdown(out) {
  const L = ['# Hook latency', ''];
  L.push(`- Do luc: ${out.meta.startedAt} -> ${out.meta.finishedAt} (${out.meta.elapsedSec}s)`);
  L.push(`- Moi hook ${out.meta.n} lan, spawn qua bash (${out.meta.bash}), CLAUDE_PROJECT_DIR="${out.meta.projectDir}", stdin mau (${out.meta.sampleTool} \`ls\`, session_id latency-base). Chuoi = chay tuan tu moi hook khop matcher, do tong moi vong.`);
  L.push(`- Truncated: ${out.truncated ?? 'khong'}.`, '', '## Tung hook (ms)', '');
  L.push(row('Event', 'Matcher', 'Hook', 'n', 'p50', 'p95', 'min', 'max', 'exit!=0', 'timeout'), row(...Array(10).fill('---')));
  for (const h of out.hooks) L.push(row(h.event, h.matcher, h.label, h.n, h.p50, h.p95, h.min, h.max, h.nonZeroExit, h.timedOut));
  L.push('', '## Chuoi tuan tu moi event (ms, tong moi vong)', '', row('Event', 'So hook', 'n', 'p50', 'p95', 'min', 'max', 'partial'), row(...Array(8).fill('---')));
  for (const c of out.chains) L.push(row(c.event, c.hooks, c.n, c.p50, c.p95, c.min, c.max, c.partial ? 'co' : ''));
  return L.join('\n') + '\n';
}

// Thu muc doc lay tu config workspace (docsDir, mac dinh 'docs'); khong cung docs/ cua hub.
const docsDir = () => { try { return loadConfig('workspace', { root: workspaceRoot() }).config.docsDir || 'docs'; } catch { return 'docs'; } };
const DEFAULT_DOC = () => path.join(workspaceRoot(), docsDir(), 'research', 'hook-latency-baseline.md');

/** Ghi --out an toan: khong ghi de doc mac dinh, khong ghi de file co san neu thieu force. Nem Error khi tu choi. */
export function writeDocOut(file, text, { force = false, protect = DEFAULT_DOC() } = {}) {
  const abs = path.resolve(file);
  if (samePath(abs, protect)) throw new Error(`tu choi ghi de doc mac dinh (${protect}); dung --out khac`);
  if (fs.existsSync(abs) && !force) throw new Error(`${abs} da ton tai; them --force de ghi de`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
  return abs;
}

export function parseArgs(argv) {
  const o = { events: null, n: LIMITS.n, timeoutS: LIMITS.totalTimeoutS, settings: null, projectDir: null, bash: null, json: false, out: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const k = eq > 0 ? a.slice(0, eq) : a;
    const val = () => { const v = eq > 0 ? a.slice(eq + 1) : argv[++i]; if (v === undefined) throw new Error(`thieu gia tri cho ${k}`); return v; };
    if (k === '--event') o.events = (o.events || []).concat(val().split(',').map((x) => x.trim()).filter(Boolean));
    else if (k === '--n') o.n = Number(val());
    else if (k === '--timeout-s') o.timeoutS = Number(val());
    else if (k === '--settings') o.settings = path.resolve(val());
    else if (k === '--project-dir') o.projectDir = path.resolve(val());
    else if (k === '--bash') o.bash = val();
    else if (k === '--out') o.out = val();
    else if (k === '--json') o.json = true;
    else if (k === '--force') o.force = true;
    else throw new Error(`tham so la: ${a}`);
  }
  if (!Number.isInteger(o.n) || o.n < 1 || o.n > LIMITS.maxN) throw new Error(`--n phai la so nguyen 1..${LIMITS.maxN}`);
  if (!(o.timeoutS > 0)) throw new Error('--timeout-s phai > 0');
  const bad = (o.events || []).filter((e) => !EVENTS.includes(e));
  if (bad.length) throw new Error(`event la: ${bad.join(', ')} (${EVENTS.join('|')})`);
  return o;
}

export function main(argv = process.argv.slice(2), io = {}) {
  const out = io.out || ((s) => console.log(s));
  const err = io.err || ((s) => console.error(s));
  let o;
  try { o = parseArgs(argv); } catch (e) { err(`eval bench: ${e.message}\n${USAGE}`); return 2; }
  const hub = workspaceRoot();
  const settingsFile = o.settings || path.join(hub, '.claude', 'settings.json');
  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8').replace(/^﻿/, '')); } catch (e) { err(`eval bench: khong doc duoc settings ${settingsFile}: ${e.message}`); return 2; }
  const projectDir = o.projectDir || (o.settings ? path.dirname(path.dirname(settingsFile)) : hub);
  const res = runBench({ settings, projectDir: projectDir.split(path.sep).join('/'), bash: o.bash, n: o.n, events: o.events, totalTimeoutMs: o.timeoutS * 1000 });
  const text = o.json ? JSON.stringify(res, null, 2) + '\n' : renderMarkdown(res);
  let note = '';
  if (o.out) {
    try { note = `\nda ghi: ${writeDocOut(o.out, text, { force: o.force })}`; } catch (e) { err(`eval bench: ${e.message}`); out(text.trimEnd()); return 2; }
  }
  out(text.trimEnd() + note);
  return 0;
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) process.exitCode = main();
