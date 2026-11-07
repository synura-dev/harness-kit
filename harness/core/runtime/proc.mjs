// Cong duy nhat de chay tien trinh con: luon windowsHide, timeout cung + giet ca cay, tac vu nen co so PID + khoa.
// Moi file khac KHONG import node:child_process truc tiep (doctor bao loi: rule proc-direct); ngoai le o PROC_EXCEPTIONS.
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPathFor } from '../io/storage.mjs';
import { withLock } from './lockfile.mjs';

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
// So PID: state cua data harness (zone system, khoa 'proc' trong observe/storage/registry.json); chi khi khong resolve duoc moi roi ve tmpdir.
// Muc: {pid, key, cmd, script?, needle, startedAt, deadline}. Them dong khong khoa; sweep don duoi khoa (withLock).
function procDir() {
  try { return dataPathFor('proc', { quiet: true }); } catch { return path.join(os.tmpdir(), 'harness-kit'); }
}
export const ledgerPath = (dir) => path.join(dir || process.env.HARNESS_PROC_DIR || procDir(), 'proc-ledger.jsonl');
// So = JSONL chi-noi-them: {op:'add',...entry} | {op:'done',pid?,key?}. Doc = gop cac dong theo thu tu. Them 1 dong nho khong can khoa; chi sweep don (compact) duoi khoa.
const fold = (text) => {
  const m = new Map();
  for (const ln of text.split('\n')) {
    if (!ln) continue;
    let r; try { r = JSON.parse(ln); } catch { continue; } // dong rach/do -> bo qua
    if (r.op === 'add') { m.delete(r.pid); const { op, ...e } = r; m.set(r.pid, e); }
    else if (r.op === 'done') for (const [p, e] of m) if ((r.pid != null && e.pid === r.pid) || (r.key != null && e.key === r.key)) m.delete(p);
  }
  return [...m.values()];
};
/** So cu proc-ledger.json (mang muc): doc gop mot lan roi doi ten .bak (lan sau bo qua). Fail-open. */
function legacyEntries(f) {
  const old = f.replace(/\.jsonl$/, '.json');
  if (old === f) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(old, 'utf8'));
    try { fs.renameSync(old, old + '.bak'); } catch { /* bo qua */ }
    return Array.isArray(arr) ? arr.filter((e) => e && e.pid != null) : [];
  } catch { return []; }
}
export const readLedger = (f) => {
  const legacy = legacyEntries(f).map((e) => JSON.stringify({ op: 'add', ...e })).join('\n');
  try { return fold(legacy + '\n' + fs.readFileSync(f, 'utf8')); } catch { return legacy ? fold(legacy) : []; }
};
/** Them 1 dong vao so, cung khoa voi compact (retry ngan); khong lay duoc khoa -> van ghi noi (hiem). Loi tam thoi (EPERM/EBUSY) thu lai; van loi -> false. */
function appendLedger(f, rec, held = false) {
  if (!held) {
    const r = withLock(f, () => appendLedger(f, rec, true), { retries: 10, waitMs: 20 });
    if (r.ok) return r.value;
  }
  for (let i = 0; i < 20; i++) {
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(rec) + '\n'); return true; } catch { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } catch { /* bo qua */ } }
  }
  return false;
}
export const COMPACT_MIN_BYTES = 65536;
/** Don so khi file > COMPACT_MIN_BYTES: so-va-thay. Doc + stat size, dung noi dung moi, stat lai ngay truoc rename; size doi (co dong noi them) -> bo lan nay. Tra true neu da thay. */
export function compactLedger(f, { minBytes = COMPACT_MIN_BYTES } = {}) {
  const t = `${f}.${process.pid}.tmp`;
  try {
    const size = fs.statSync(f).size;
    if (size <= minBytes) return false;
    const entries = fold(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(t, entries.map((e) => JSON.stringify({ op: 'add', ...e }) + '\n').join(''));
    if (fs.statSync(f).size !== size) { fs.unlinkSync(t); return false; }
    fs.renameSync(t, f);
    return true;
  } catch { try { fs.unlinkSync(t); } catch { /* bo qua */ } return false; }
}
export const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Dang co tac vu nen cung key chay (muc con song, chua qua han)? */
export function isRunning(key, { dir, now = Date.now(), alive = isAlive } = {}) {
  return readLedger(ledgerPath(dir)).some((e) => e.key === key && e.deadline > now && alive(e.pid));
}

/** Xoa muc theo key hoac pid (tac vu goi khi xong). */
export function ledgerDone({ key, pid } = {}, { dir } = {}) {
  if (key == null && pid == null) return;
  appendLedger(ledgerPath(dir), { op: 'done', pid: pid ?? null, key: key ?? null });
}

export const SWEEP = Object.freeze({ staleAfterMs: 24 * 3600e3, startToleranceMs: 30000, minIntervalMs: 3600e3 });
const nrm = (s) => String(s || '').replace(/\\/g, '/').toLowerCase();

/**
 * Doi chieu tien trinh song voi muc so: true = dung tien trinh ta spawn; false = PID bi tai dung (khac); null = khong ro (khong doc duoc lenh).
 * Dung khi: lenh doc duoc va chua ca duong dan script day du (needle) VA thoi diem tao tien trinh khop startedAt (+-tolerance, khong som hon).
 */
export function matchEntry(e, live, tol = SWEEP.startToleranceMs) {
  if (!live || !String(live.cmd || '').trim()) return null;
  const needle = nrm(e.needle || e.script);
  if (!needle) return null;
  if (!nrm(live.cmd).includes(needle)) return false;
  if (!Number.isFinite(live.startMs) || !Number.isFinite(e.startedAt)) return null;
  return live.startMs >= e.startedAt - tol && live.startMs <= e.startedAt + tol;
}

/**
 * Don so PID: PID chet -> xoa; qua han + con song -> kill CHI khi matches(pid, cmd, entry) === true roi xoa.
 * matches === false (PID tai dung) -> xoa muc, KHONG kill. matches null/loi (khong doc duoc lenh) -> KHONG kill, giu muc den khi qua han + staleAfterMs.
 * Tra {removed, killed}.
 */
export function sweepLedger({ dir, now = Date.now(), alive = isAlive, kill = killTree, matches = () => null, staleAfterMs = SWEEP.staleAfterMs } = {}) {
  const f = ledgerPath(dir);
  let removed = 0, killed = 0; let toKill = [];
  // Trong khoa chi doc + quyet dinh + ghi so; kill (taskkill dong bo, co the toi 10s/PID) lam SAU khi nha khoa (khoa stale 15s).
  const r = withLock(f, () => {
    const es = readLedger(f);
    const keep = []; removed = 0; killed = 0; toKill = []; const gone = [];
    for (const e of es) {
      if (!alive(e.pid)) { removed++; gone.push(e.pid); continue; }
      if (e.deadline > now) { keep.push(e); continue; }
      let m = null; try { m = matches(e.pid, e.cmd, e); } catch { m = null; }
      if (m === true) { toKill.push(e.pid); killed++; removed++; gone.push(e.pid); continue; }
      if (m === false) { removed++; gone.push(e.pid); continue; }
      if (now - e.deadline >= staleAfterMs) { removed++; gone.push(e.pid); continue; } // khong xac minh duoc: chi bo muc, khong kill
      keep.push(e);
    }
    for (const pid of gone) appendLedger(f, { op: 'done', pid, key: null }, true);
    compactLedger(f);
    return true;
  }, { staleMs: 15000, retries: 120, waitMs: 25 });
  const ok = r.ok;
  if (ok) for (const pid of toKill) { try { kill(pid); } catch { /* da chet */ } }
  return { removed, killed };
}

const scriptOf = (args) => { for (const a of args) { const s = String(a); if (/\.(mjs|cjs|js|ts)$/i.test(s)) return path.resolve(s); } return null; };

/**
 * Chay tac vu nen: detached + unref + stdio ignore + ha uu tien; ghi so PID (kem script day du + startedAt); khoa theo key (dang chay thi bo qua).
 * Tra pid hoac null (bi khoa / loi). detached chi xuat hien o day.
 */
export function spawnBackground({ cmd, args = [], key, deadlineMs = 10 * 60e3, dir, cwd, env, now = Date.now(), onError, verbatim }) {
  const fail = (why) => { try { if (typeof onError === 'function') onError(why); } catch { /* fail-open */ } return null; }; // bi khoa (dang chay) KHONG la loi
  try {
    if (key && isRunning(key, { dir, now })) return null;
    const penv = { ...(env || process.env), ...(key ? { HARNESS_BG_KEY: key } : {}), ...(dir ? { HARNESS_PROC_DIR: dir } : {}) };
    const startedAt = Date.now();
    const p = cp.spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd, env: penv, ...(verbatim ? { windowsVerbatimArguments: true } : {}) });
    p.on('error', (e) => fail('spawn: ' + (e && e.message))); p.unref();
    if (!p.pid) return fail('spawn: khong co pid');
    try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* khong dat duoc */ }
    const script = scriptOf(args);
    const entry = { pid: p.pid, key: key || null, cmd: [cmd, ...args].join(' ').slice(0, 300), script, needle: script || [cmd, ...args].join(' ').slice(0, 400), startedAt, deadline: now + deadlineMs };
    appendLedger(ledgerPath(dir), { op: 'add', ...entry });
    return p.pid;
  } catch (e) { return fail('spawn: ' + (e && e.message)); }
}

/** Trong chinh script con (chay qua spawnBackground): khi thoat xoa muc khoi so PID (ledgerDone). Khong co HARNESS_BG_KEY -> khong lam gi. */
export function bgDoneOnExit() {
  if (!process.env.HARNESS_BG_KEY) return;
  const dir = process.env.HARNESS_PROC_DIR || undefined;
  process.on('exit', () => { try { ledgerDone({ pid: process.pid }, { dir }); } catch { /* fail-open */ } });
}

/** Quet dong bo (CHI chay trong tien trinh nen proc-sweep.mjs): liet ke tien trinh that, doi chieu, don so. Fail-open. */
export async function sweepNow({ dir, listProc } = {}) {
  try {
    const list = listProc || (await import('./proc-list.mjs')).listProcesses;
    let byPid = null;
    const matches = (pid, _cmd, e) => {
      if (!byPid) { const r = list({ timeoutMs: 5000 }); byPid = r.error ? new Map() : new Map(r.procs.map((p) => [p.pid, p])); }
      return matchEntry(e, byPid.get(pid));
    };
    return sweepLedger({ dir, matches });
  } catch { return null; }
}

const SWEEP_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'proc-sweep.mjs');
/** Hook goi: KHONG quet dong bo. Kich quet nen (key proc-sweep), toi da 1 lan/gio (dau thoi gian trong file stamp). Tra {kicked}. */
export function sweepBackground({ dir, now = Date.now(), spawn = spawnBackground } = {}) {
  try {
    const stamp = path.join(path.dirname(ledgerPath(dir)), 'proc-sweep.stamp');
    try { if (now - fs.statSync(stamp).mtimeMs < SWEEP.minIntervalMs) return { kicked: false }; } catch { /* chua co stamp */ }
    try { fs.mkdirSync(path.dirname(stamp), { recursive: true }); fs.writeFileSync(stamp, String(now)); } catch { /* khong ghi duoc */ }
    const pid = spawn({ cmd: process.execPath, args: [SWEEP_SCRIPT], key: 'proc-sweep', deadlineMs: 2 * 60e3, dir });
    return { kicked: !!pid };
  } catch { return { kicked: false }; }
}
