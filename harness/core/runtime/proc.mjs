// Cong duy nhat de chay tien trinh con: luon windowsHide, timeout cung + giet ca cay, tac vu nen co so PID + khoa.
// Moi file khac KHONG import node:child_process truc tiep (doctor bao loi: rule proc-direct); ngoai le o PROC_EXCEPTIONS.
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WIN = process.platform === 'win32';
export const DEFAULT_TIMEOUT_MS = 600000;

/** Giet ca cay tien trinh (Windows: taskkill /T /F an). Nuot loi. */
export function killTree(pid) {
  if (!pid) return;
  try {
    if (WIN) cp.spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    else { try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); } }
  } catch { /* da chet */ }
}

const hide = (o) => ({ ...o, windowsHide: true });

/** spawnSync co windowsHide + timeout mac dinh; qua han -> giet cay (spawnSync chi giet con truc tiep). */
export function spawnSync(cmd, args, opts) {
  if (!Array.isArray(args)) { opts = args; args = undefined; }
  const o = hide({ timeout: DEFAULT_TIMEOUT_MS, ...(opts || {}) });
  const r = args ? cp.spawnSync(cmd, args, o) : cp.spawnSync(cmd, o);
  if (r.error && r.error.code === 'ETIMEDOUT') killTree(r.pid);
  return r;
}

/** spawn (async) co windowsHide. Khong tu dat timeout: nguoi goi quan ly (hoac dung spawnTimed). */
export function spawn(cmd, args, opts) {
  if (!Array.isArray(args)) { opts = args; args = []; }
  return cp.spawn(cmd, args, hide(opts || {}));
}

/** spawn async + timeout cung: qua han giet cay. Tra child. */
export function spawnTimed(cmd, args, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = opts;
  const child = spawn(cmd, args, rest);
  const t = setTimeout(() => killTree(child.pid), timeoutMs);
  if (t.unref) t.unref();
  child.on('exit', () => clearTimeout(t));
  return child;
}

// ---- Tac vu nen: so PID + khoa ----
export const ledgerPath = (dir) => path.join(dir || process.env.HARNESS_PROC_DIR || path.join(os.tmpdir(), 'harness-kit'), 'proc-ledger.json');
const readLedger = (f) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(j.entries) ? j.entries : []; } catch { return []; } };
function writeLedger(f, entries) {
  const t = `${f}.${process.pid}.tmp`;
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(t, JSON.stringify({ entries })); fs.renameSync(t, f); } catch { try { fs.unlinkSync(t); } catch {} }
}
export const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Dang co tac vu nen cung key chay (muc con song, chua qua han)? */
export function isRunning(key, { dir, now = Date.now(), alive = isAlive } = {}) {
  return readLedger(ledgerPath(dir)).some((e) => e.key === key && e.deadline > now && alive(e.pid));
}

/** Xoa muc theo key hoac pid (tac vu goi khi xong). */
export function ledgerDone({ key, pid } = {}, { dir } = {}) {
  const f = ledgerPath(dir);
  writeLedger(f, readLedger(f).filter((e) => !(key != null && e.key === key) && !(pid != null && e.pid === pid)));
}

/** Don so PID: PID chet -> xoa; qua han + con song -> kill neu matches(pid, cmd) roi xoa. Tra {removed, killed}. */
export function sweepLedger({ dir, now = Date.now(), alive = isAlive, kill = killTree, matches = () => true } = {}) {
  const f = ledgerPath(dir);
  const keep = []; let removed = 0, killed = 0;
  for (const e of readLedger(f)) {
    if (!alive(e.pid)) { removed++; continue; }
    if (e.deadline <= now) { if (matches(e.pid, e.cmd)) { kill(e.pid); killed++; } removed++; continue; }
    keep.push(e);
  }
  if (removed) writeLedger(f, keep);
  return { removed, killed };
}

/**
 * Chay tac vu nen: detached + unref + stdio ignore + ha uu tien; ghi so PID; khoa theo key (dang chay thi bo qua).
 * Tra pid hoac null (bi khoa / loi). detached chi xuat hien o day.
 */
export function spawnBackground({ cmd, args = [], key, deadlineMs = 10 * 60e3, dir, cwd, env, now = Date.now() }) {
  try {
    if (key && isRunning(key, { dir, now })) return null;
    const p = cp.spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd, env: env || process.env });
    p.on('error', () => {}); p.unref();
    if (!p.pid) return null;
    try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* khong dat duoc */ }
    const f = ledgerPath(dir);
    writeLedger(f, [...readLedger(f).filter((e) => e.pid !== p.pid), { pid: p.pid, key: key || null, cmd: [cmd, ...args].join(' ').slice(0, 300), startedAt: now, deadline: now + deadlineMs }]);
    return p.pid;
  } catch { return null; }
}
