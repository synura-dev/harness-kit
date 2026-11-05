// Hook SessionStart/UserPromptSubmit: CHI DOC so da tinh san, phat toi da 3 dong canh bao (ton trong cooldown), ghi warn_ts.
// KHONG tinh nang trong hook. SessionStart them: neu job lo qua han (>=1h) thi spawn nen (detached), khong cho. Fail-open.
import fs from 'node:fs';
import path from 'node:path';
import { spawnBackground, sweepBackground } from '../../core/runtime/proc.mjs';
import { dataPathFor } from '../../core/io/storage.mjs';
import { kickReport } from '../report/run.mjs';
import { kickAutopilot } from './autopilot-kick.mjs';
import { fileURLToPath } from 'node:url';
import { REPO_DIR } from '../../core/io/paths.mjs';
import { readLedger, writeLedger, claimDue, ledgerFile, ledgerDir, POLICY, JOB, jobDue } from './ledger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INJECT_LIMITS = Object.freeze({ maxLines: 5, maxChars: 800, perLine: 400 });
/** Doc <dataDir>/evolve/inject/*.md (do evolve ap dung) -> toi da 5 dong/800 ky tu, moi file 1 dong; lam sach lai khi doc. Fail-open. */
export function readInject(dataOpts, lim = INJECT_LIMITS) {
  try {
    const dir = dataPathFor('evolve', 'inject', { quiet: true, ...(dataOpts || {}) });
    const out = []; let used = 0;
    for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
      if (out.length >= lim.maxLines) break;
      const body = fs.readFileSync(path.join(dir, n), 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).join(' | ');
      const line = body.replace(/[\u0000-\u001f\u007f-\u009f`<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, lim.perLine);
      if (!line || used + line.length > lim.maxChars) continue;
      out.push(line); used += line.length;
    }
    return out;
  } catch { return []; }
}

export const DEFAULTS = { enabled: true, maxLines: POLICY.maxWarnLines, kick: true };

/** Spawn nen job neu qua han + khoa nhe. Tra true neu da spawn. */
export function kickJob(dataOpts, ctx = {}, nowMs = Date.now()) {
  try {
    if (!jobDue(dataOpts, nowMs)) return false;
    const lock = path.join(ledgerDir(dataOpts), 'kick.json');
    try { const l = JSON.parse(fs.readFileSync(lock, 'utf8')); if (nowMs - Number(l.ts) < JOB.lockMinutes * 60e3) return false; } catch {}
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ ts: nowMs, pid: process.pid }));
    const go = ctx.spawnJob || (() => {
      spawnBackground({ cmd: process.execPath, args: [path.join(HERE, 'job.mjs'), '--timeout-s', String(JOB.timeoutS)], key: 'ledger-job', deadlineMs: (JOB.timeoutS + 60) * 1000, env: process.env });
    });
    go();
    return true;
  } catch { return false; }
}

export async function handle(event, input, ctx = {}) {
  try {
    const cfg = { ...DEFAULTS, ...(ctx.cfg || {}) };
    if (!cfg.enabled || !input || typeof input !== 'object') return {};
    if (event !== 'SessionStart' && event !== 'UserPromptSubmit') return {};
    const nowMs = ctx.nowMs || Date.now();
    const dataOpts = ctx.env ? { env: ctx.env } : undefined;
    const file = ledgerFile(dataOpts);
    const sid = String(input.session_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || null;
    const r = claimDue(readLedger(file), nowMs, { sid: sid && `claude-${sid}`, max: cfg.maxLines });
    if (r.changed) writeLedger(file, r.entries);
    if (event === 'SessionStart' && cfg.sweep !== false && !ctx.env) await sweepBackground(); // don so PID tac vu nen (muc chet/qua han)
    if (event === 'SessionStart' && cfg.kickAutopilot !== false) kickAutopilot(dataOpts, { ...ctx, spawnAutopilot: ctx.spawnAutopilot || (ctx.spawnJob ? () => {} : undefined) }, nowMs); // evolve autopilot 1 lan/24h
    if (event === 'SessionStart' && cfg.kick !== false) { kickJob(dataOpts, ctx, nowMs); if (cfg.reportKick !== false) kickReport(dataOpts, { spawnReport: ctx.spawnReport || (ctx.spawnJob ? () => {} : undefined) }, nowMs); }
    const inj = event === 'SessionStart' && cfg.inject !== false ? readInject(dataOpts) : [];
    const all = [...r.lines, ...inj];
    return all.length ? { additionalContext: all.join('\n') } : {};
  } catch { return {}; }
}

const META = { id: 'ledger-warn', events: ['SessionStart', 'UserPromptSubmit'], timeoutMs: 1500, onError: 'open' };
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });
