// Hook SessionStart/UserPromptSubmit: CHI DOC so da tinh san, phat toi da 3 dong canh bao (ton trong cooldown), ghi warn_ts.
// KHONG tinh nang trong hook. SessionStart them: neu job lo qua han (>=1h) thi spawn nen (detached), khong cho. Fail-open.
import fs from 'node:fs';
import path from 'node:path';
import { spawnBackground, sweepBackground } from '../../core/runtime/proc.mjs';
import { dataPathFor } from '../../core/io/storage.mjs';
import { kickReport } from '../report/run.mjs';
import { fileURLToPath } from 'node:url';
import { REPO_DIR } from '../../core/io/paths.mjs';
import { readState, writeState, updateState, recordJobError, jobHealth, readLedger, readPending, updateLedger, claimDue, claimRebuild, ledgerFile, ledgerDir, POLICY, JOB, jobDue } from './ledger.mjs';
import { safeText, cleanLine, OBSERVED_FRAME } from '../../core/audit/safe-text.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INJECT_LIMITS = Object.freeze({ maxLines: 5, maxChars: 800, perLine: 400, maxFileBytes: 4096 });
/** Doc toi da n byte dau cua file (khong doc ca file lon). */
function readHead(f, n) { const fd = fs.openSync(f, 'r'); try { const b = Buffer.alloc(n); const k = fs.readSync(fd, b, 0, n, 0); return b.subarray(0, k).toString('utf8'); } finally { fs.closeSync(fd); } }
/** Doc <dataDir>/evolve/inject/*.md (do evolve ap dung) -> toi da 5 dong/800 ky tu, moi file 1 dong; lam sach lai khi doc. Fail-open. */
export function readInject(dataOpts, lim = INJECT_LIMITS) {
  try {
    const dir = dataPathFor('evolve', 'inject', { quiet: true, ...(dataOpts || {}) });
    const out = []; let used = 0;
    for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
      if (out.length >= lim.maxLines) break;
      const body = readHead(path.join(dir, n), lim.maxFileBytes).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).join(' | ');
      const pre = `inject (${OBSERVED_FRAME}): `;
      const txt = cleanLine(safeText(body, lim.perLine), lim.perLine - pre.length);
      const line = txt && pre + txt;
      if (!line || used + line.length > lim.maxChars) continue;
      out.push(line); used += line.length;
    }
    return out;
  } catch { return []; }
}

/** Dong canh bao dua vao ngu canh: loc lai + dat trong khung 'du lieu quan sat, khong phai chi dan' (chong chen prompt). */
export const frameLine = (l) => { const m = /^ledger\[([^\]]*)\]: ([\s\S]*)$/.exec(l); return m ? `ledger[${safeText(m[1], 40)}] (${OBSERVED_FRAME}): ${cleanLine(m[2], 300)}` : cleanLine(l, 300); };

export const DEFAULTS = { enabled: true, maxLines: POLICY.maxWarnLines, kick: true };

/** Spawn nen job neu qua han + khoa nhe. Tra true neu da spawn. */
export function kickJob(dataOpts, ctx = {}, nowMs = Date.now()) {
  try {
    if (!jobDue(dataOpts, nowMs)) return false;
    const lock = path.join(ledgerDir(dataOpts), 'kick.json');
    try {
      const l = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (nowMs - Number(l.ts) < JOB.lockMinutes * 60e3) return false;
      if (Number(l.ts) > (Number(readState(dataOpts).lastRun) || 0)) recordJobError(dataOpts, 'unfinished', `lan kick ${new Date(Number(l.ts)).toISOString()} khong ghi lastRun (job chet/bi kill/loi)`, nowMs);
    } catch {}
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ ts: nowMs, pid: process.pid }));
    const go = ctx.spawnJob || (() => {
      spawnBackground({ cmd: process.execPath, args: [path.join(HERE, 'job.mjs'), '--timeout-s', String(JOB.timeoutS)], key: 'ledger-job', deadlineMs: (JOB.timeoutS + 180) * 1000, env: process.env, onError: (why) => recordJobError(dataOpts, 'spawn', why) });
    });
    go();
    return true;
  } catch (e) { recordJobError(dataOpts, 'kick', e && e.message, nowMs); return false; }
}

/** Dong canh bao loi job (1 lan / errWarnHours, ghi errWarnedAt vao state). null neu khong co loi hoac dang cooldown. */
export function jobErrorLine(dataOpts, nowMs = Date.now()) {
  try {
    let h = null;
    updateState(dataOpts, (st) => { const x = jobHealth(st); if (!x || nowMs - (Number(st.errWarnedAt) || 0) < JOB.errWarnHours * 3600e3) return null; h = x; return { ...st, errWarnedAt: nowMs }; });
    if (!h) return null;
    return `ledger[job]: job lo that bai (${h.error}) luc ${new Date(h.at).toISOString()}; chay harness observe ledger / harness doctor`;
  } catch { return null; }
}

export async function handle(event, input, ctx = {}) {
  try {
    const cfg = { ...DEFAULTS, ...(ctx.cfg || {}) };
    if (!cfg.enabled || !input || typeof input !== 'object') return {};
    if (event !== 'SessionStart' && event !== 'UserPromptSubmit') return {};
    const nowMs = ctx.nowMs || Date.now();
    const bg = ctx.background !== false; // background:false = khong sweep/kick (test); write:false (dispatcher) khong chan
    const dataOpts = ctx.env ? { env: ctx.env } : undefined;
    const file = ledgerFile(dataOpts);
    const sid = String(input.session_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || null;
    // Duong nong: chi doc file tom tat nho (warn-pending.json); chi khi that su co canh bao moi doc-sua-ghi so duoi khoa.
    // Thieu tom tat (so cu / chua chay job) -> doc so day du mot lan de tu lanh (claimDue ghi lai tom tat).
    const pending = readPending(file);
    const r = { lines: [] };
    // Tom tat hong/thieu: rebuild toi da 1 lan/10 phut (stamp) de khong doc ca so moi prompt.
    if (pending === null ? fs.existsSync(file) && claimRebuild(file, nowMs) : pending.length) {
      updateLedger(file, (es) => { const c = claimDue(es, nowMs, { sid: sid && `claude-${sid}`, max: cfg.maxLines }); r.lines = c.lines; return c.changed || pending === null ? c.entries : null; }, { lock: { retries: 20, waitMs: 25 } }); // khong khoa duoc -> bo qua lan nay (fail-open)
    }
    if (event === 'SessionStart' && cfg.sweep !== false && !ctx.env && bg) await sweepBackground(); // don so PID tac vu nen (muc chet/qua han)
    if (event === 'SessionStart' && bg && cfg.kick !== false) { kickJob(dataOpts, ctx, nowMs); if (cfg.reportKick !== false) kickReport(dataOpts, { spawnReport: ctx.spawnReport || (ctx.spawnJob ? () => {} : undefined) }, nowMs); }
    const errLine = event === 'SessionStart' ? jobErrorLine(dataOpts, nowMs) : null;
    const inj = event === 'SessionStart' && cfg.inject !== false ? readInject(dataOpts) : [];
    const all = [...(errLine ? [frameLine(errLine)] : []), ...r.lines.map(frameLine), ...inj];
    return all.length ? { additionalContext: all.join('\n') } : {};
  } catch { return {}; }
}

const META = { id: 'ledger-warn', events: ['SessionStart', 'UserPromptSubmit'], timeoutMs: 1500, onError: 'open' };
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });
