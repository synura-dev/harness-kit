// Batch check re cua doctor chay nen (<=1 lan/24h): data scan (runtime). Ghi state; hook chi doc. Khong check nang.
import fs from 'node:fs';
import path from 'node:path';
import { spawnBackground, spawnSync, bgDoneOnExit } from '../../core/runtime/proc.mjs';
import { fileURLToPath } from 'node:url';
import { cleanLine } from '../../core/audit/safe-text.mjs';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';

const REL = ['.state', 'data-check-doctor.json'];
const wj = (f, o) => { const t = `${f}.${process.pid}.tmp`; try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); return true; } catch { try { fs.unlinkSync(t); } catch {} return false; } };
const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
export const stateFile = (dd) => path.join(dd, ...REL);

/** Tinh danh sach loi (chuoi on dinh): chi check runtime = data scan (retention/dang ky/stray). Check phat trien nam o dev/. */
export async function collectErrors(hubRoot, repoDir) {
  const out = [];
  try {
    const gate = path.join(repoDir || hubRoot, 'harness', 'cli', 'harness.mjs');
    const r = spawnSync(process.execPath, [gate, 'data', 'scan', '--json'], { encoding: 'utf8', timeout: 20000, cwd: hubRoot });
    for (const w of JSON.parse(r.stdout).warnings || []) if (['retention', 'over-caps', 'unregistered', 'stray'].includes(w.rule)) out.push(`data: ${w.rule} ${w.path}`);
  } catch {}
  return [...new Set(out)];
}

/** Chay batch, ghi state: errors hien tai + fresh (loi moi so voi lan truoc, giu den khi da bao). */
export async function runBatch(dd, hubRoot, repoDir, now = Date.now(), collect = collectErrors) {
  const f = stateFile(dd); const prev = rd(f) || {};
  const errors = await collect(hubRoot, repoDir);
  const old = new Set(prev.errors || []);
  const fresh = errors.filter((e) => !old.has(e));
  const pending = [...new Set([...(prev.seen === false ? prev.fresh || [] : []), ...fresh])].filter((e) => errors.includes(e));
  wj(f, { lastRun: now, done: true, errors, fresh: pending, seen: pending.length === 0 });
  return { errors, fresh: pending };
}

/** Hook: spawn nen khi >= minIntervalHours; tra dong canh bao loi MOI (toi da maxLines) hoac []. */
export function doctorAuto(dd, cfg, ctx = {}) {
  try {
    const da = { enabled: true, minIntervalHours: 24, timeoutS: 60, maxLines: 5, ...(cfg.doctorAuto || {}) };
    const env = ctx.env || process.env;
    if (!da.enabled || env.HOOK_DATA_CHECK_DOCTOR === '0') return [];
    const f = stateFile(dd); const st = rd(f) || {}; const now = Date.now(); let lines = [];
    if (st.seen === false && Array.isArray(st.fresh) && st.fresh.length) {
      lines = st.fresh.slice(0, da.maxLines).map((e) => `doctor: loi moi ${cleanLine(e, 160)}`);
      if (st.fresh.length > da.maxLines) lines.push(`doctor: ... con ${st.fresh.length - da.maxLines} loi moi nua. Xem: harness doctor`);
      wj(f, { ...st, seen: true });
    }
    if (now - (Number(st.lastRun) || 0) >= da.minIntervalHours * 3600e3) {
      const lf = path.join(dd, '.state', 'data-check-doctor.lock'); const lock = rd(lf);
      if (!(lock && now - Number(lock.ts) < 5 * 60e3)) {
        wj(lf, { ts: now, pid: process.pid });
        (ctx.spawnDoctor || (() => {
          spawnBackground({ cmd: process.execPath, args: [fileURLToPath(import.meta.url), '--run', dd], key: 'doctor-auto', deadlineMs: 10 * 60e3, env: { ...process.env, HARNESS_GATEWAY: '1' } });
        }))();
      }
    }
    return lines;
  } catch { return []; }
}

/** Chay file worker voi timeout cung: worker quet dong bo cung khong chan timer cua thread chinh. -> 'done' | 'timeout' | 'error'. */
export function runInWorker(file, data, timeoutMs) {
  return new Promise((resolve) => {
    let w; try { w = new Worker(file, { workerData: data }); } catch { resolve('error'); return; }
    const t = setTimeout(() => { w.terminate().catch(() => {}); resolve('timeout'); }, timeoutMs);
    w.on('message', () => { clearTimeout(t); resolve('done'); });
    w.on('error', () => { clearTimeout(t); resolve('error'); });
    w.on('exit', () => { clearTimeout(t); resolve('done'); });
  });
}

if (!isMainThread && workerData && workerData.doctorBatch) { // thread con: quet dong bo o day
  try { await runBatch(workerData.dd, workerData.hubRoot, workerData.repoDir); } catch {}
  parentPort.postMessage('done');
} else if (process.argv[2] === '--run' && process.argv[3] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const { workspaceRoot, REPO_DIR } = await import('../../core/io/paths.mjs');
  bgDoneOnExit();
  const r = await runInWorker(fileURLToPath(import.meta.url), { doctorBatch: true, dd: process.argv[3], hubRoot: workspaceRoot(), repoDir: REPO_DIR }, 60000); // timeout cung ngat duoc
  try { fs.unlinkSync(path.join(process.argv[3], '.state', 'data-check-doctor.lock')); } catch {}
  process.exit(r === 'timeout' ? 2 : 0);
}
