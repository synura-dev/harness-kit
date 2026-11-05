// Kick autopilot tien hoa (harness/evolve/loop/autopilot.mjs) detached khi qua han 24h. Chi doc state nhanh + khoa nhe; KHONG import evolve
// (hop dong import): spawn bang duong dan. Fail-open. Dung chung co che khoa kieu kickJob (kick.json) nhung khoa rieng.
import fs from 'node:fs';
import path from 'node:path';
import { spawnBackground } from '../../core/runtime/proc.mjs';
import { fileURLToPath } from 'node:url';
import { dataPathFor, readJson } from '../../core/io/storage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const AUTOPILOT_SCRIPT = path.join(HERE, '..', '..', 'evolve', 'loop', 'autopilot.mjs');
export const KICK = Object.freeze({ intervalHours: 24, lockMinutes: 5 });

/** Qua han (>=24h tu lastRun cua autopilot) va khoa kick het han -> spawn nen. Tra true neu da spawn. */
export function kickAutopilot(dataOpts, ctx = {}, nowMs = Date.now()) {
  try {
    const dir = dataPathFor('evolve', 'autopilot', { quiet: true, ...(dataOpts || {}) });
    const last = Number((readJson(path.join(dir, 'state.json'), {}) || {}).lastRun);
    if (last && nowMs - last < KICK.intervalHours * 3600e3) return false;
    const lock = path.join(dir, 'kick.json');
    try { const l = JSON.parse(fs.readFileSync(lock, 'utf8')); if (nowMs - Number(l.ts) < KICK.lockMinutes * 60e3) return false; } catch {}
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ ts: nowMs, pid: process.pid }));
    const go = ctx.spawnAutopilot || (() => {
      spawnBackground({ cmd: process.execPath, args: [AUTOPILOT_SCRIPT], key: 'evolve-autopilot', deadlineMs: 5 * 60e3, env: process.env });
    });
    go();
    return true;
  } catch { return false; }
}
