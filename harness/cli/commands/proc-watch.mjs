// harness/cli/commands/proc-watch.mjs
// Watchdog: quet cay tien trinh con cua claude/agy, liet ke tien trinh ket (tuoi > nguong).
// MAC DINH chi in + ghi log data/system/watchdog/date=YYYY-MM-DD/<sid>.jsonl. Chi --kill moi taskkill /PID /T /F
// va chi tren tien trinh: con chau cua claude/agy, ten trong allowlist, tuoi > killAgeMin, khong bi bao ve.
// Usage: node harness/cli/commands/proc-watch.mjs [--kill] [--list-age-min 10] [--kill-age-min 30] [--cpu-sec 60]
//        [--only-pid N] [--timeout-ms 15000] [--max-procs 5000] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from '../../core/runtime/proc.mjs';
import { fileURLToPath } from 'node:url';
import { samePath, ensureDataIgnore } from '../../core/io/paths.mjs';
import { dataPathFor } from '../../core/io/storage.mjs';
import { parseDate } from '../../core/runtime/proc-list.mjs';

export const DEFAULTS = {
  rootNames: ['claude.exe', 'agy.exe', 'agy'],
  watchNames: ['bash.exe', 'sh.exe', 'python.exe', 'python3.exe', 'node.exe', 'bun.exe', 'duckdb.exe', 'ping.exe', 'powershell.exe'],
  // KHONG BAO GIO kill (khop ten hoac dong lenh, khong phan biet hoa thuong)
  protectNames: ['claude.exe', 'cmd.exe', 'conhost.exe', 'chrome.exe', 'agy.exe', 'agy'],
  protectCmd: ['telegram', 'server.ts', 'mcp', 'native-host', 'chrome-native', 'proc-watch', 'claude-code', 'antigravity'],
  detachedShells: ['bash.exe', 'sh.exe'],
  listAgeMin: 10,
  killAgeMin: 30,
  cpuSec: 60,
  timeoutMs: 15000,
  maxProcs: 5000,
  maxLogBytes: 5 * 1024 * 1024,
};

export { listProcesses } from '../../core/runtime/proc-list.mjs';

/** Thuat toan thuan: nhan danh sach tien trinh, tra ve {listed, killable, protected}. */
export function analyze(procs, opts = {}, now = Date.now(), selfPid = process.pid) {
  const o = { ...DEFAULTS, ...opts };
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const lc = (s) => String(s || '').toLowerCase();
  const isRoot = (p) => o.rootNames.includes(lc(p.name));
  // Tien to: self + to tien (shell cua session hien tai) khong bao gio bi dong vao
  const shielded = new Set();
  for (let p = byPid.get(selfPid), n = 0; p && n < 64 && !shielded.has(p.pid); p = byPid.get(p.ppid), n++) shielded.add(p.pid);
  const underRoot = (p) => { // co to tien la root (claude/agy) khong?
    for (let q = byPid.get(p.ppid), n = 0; q && n < 64; q = byPid.get(q.ppid), n++) if (isRoot(q)) return true;
    return false;
  };
  // cay roi (cha da chet) bat nguon tu shell cua tool Bash cua Claude Code => coi nhu con cua claude da mo coi
  const detached = (p) => {
    let q = p;
    for (let n = 0; n < 64 && byPid.has(q.ppid); n++) q = byPid.get(q.ppid);
    return q !== p && o.detachedShells.includes(lc(q.name)) && lc(q.cmd).includes('shell-snapshots') && !isRoot(q);
  };
  const listed = [];
  for (const p of procs) {
    if (!o.watchNames.includes(lc(p.name)) || p.startMs == null) continue;
    const ageMin = (now - p.startMs) / 60000;
    if (ageMin < o.listAgeMin) continue;
    const descendant = underRoot(p);
    const orphan = !byPid.has(p.ppid) || (!descendant && detached(p));
    if (!descendant && !orphan) continue;
    const prot = shielded.has(p.pid) || o.protectNames.includes(lc(p.name)) || o.protectCmd.some((k) => lc(p.cmd).includes(k));
    listed.push({
      pid: p.pid, ppid: p.ppid, name: p.name, ageMin: Math.round(ageMin * 10) / 10, cpuSec: Math.round(p.cpu * 10) / 10,
      cpuHigh: p.cpu >= o.cpuSec, descendant, orphan, protected: prot,
      killable: (descendant || (orphan && byPid.has(p.ppid))) && !prot && ageMin >= o.killAgeMin && (o.onlyPid == null || o.onlyPid === p.pid),
      cmd: String(p.cmd || '').slice(0, 160),
    });
  }
  return { listed, killable: listed.filter((x) => x.killable) };
}

function writeLog(entry, root = dataPathFor('watchdog'), maxBytes = DEFAULTS.maxLogBytes) {
  const ts = new Date().toISOString();
  const dir = path.join(root, `date=${ts.slice(0, 10)}`);
  ensureDataIgnore(); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'proc-watch.jsonl');
  const line = JSON.stringify({ ts, ...entry }) + '\n';
  try { if (fs.statSync(f).size + line.length > maxBytes) return null; } catch {}
  fs.appendFileSync(f, line);
  return f;
}

function killTree(pid, run = spawnSync) {
  const r = run('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  return { pid, ok: r.status === 0, out: String(r.stdout || r.stderr || '').trim().slice(0, 200) };
}

/** @param deps {list, kill, log} de test. */
export function run(opts = {}, deps = {}) {
  const t0 = Date.now();
  const o = { ...DEFAULTS, ...opts };
  const { procs, error, truncated } = (deps.list || listProcesses)({ timeoutMs: o.timeoutMs, maxProcs: o.maxProcs });
  const res = { ...analyze(procs, o, Date.now(), o.selfPid ?? process.pid), killed: [], error, truncated };
  if (Date.now() - t0 > o.timeoutMs) res.truncated = 'timeout';
  if (o.kill) {
    for (const k of res.killable) {
      if (Date.now() - t0 > o.timeoutMs) { res.truncated = 'timeout'; break; }
      res.killed.push((deps.kill || killTree)(k.pid));
    }
  }
  (deps.log || writeLog)({ event: 'proc-watch', kill: !!o.kill, listed: res.listed, killed: res.killed, error, truncated: res.truncated });
  return res;
}

function parseWatchArgs(argv) {
  const o = {};
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], nx = argv[i + 1];
    if (a === '--kill') o.kill = true;
    else if (a === '--json') o.json = true;
    else if (a === '--list-age-min' && nx) o.listAgeMin = num(argv[++i]);
    else if (a === '--kill-age-min' && nx) o.killAgeMin = num(argv[++i]);
    else if (a === '--cpu-sec' && nx) o.cpuSec = num(argv[++i]);
    else if (a === '--only-pid' && nx) o.onlyPid = num(argv[++i]);
    else if (a === '--timeout-ms' && nx) o.timeoutMs = num(argv[++i]);
    else if (a === '--max-procs' && nx) o.maxProcs = num(argv[++i]);
  }
  return o;
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  const o = parseWatchArgs(process.argv.slice(2));
  const r = run(o);
  if (o.json) console.log(JSON.stringify(r, null, 2));
  else {
    for (const p of r.listed) console.log(`${p.killable ? 'KILLABLE' : p.protected ? 'protected' : 'listed'}\tpid=${p.pid}\t${p.name}\tage=${p.ageMin}m\tcpu=${p.cpuSec}s${p.cpuHigh ? '(high)' : ''}\t${p.cmd}`);
    console.log(`[proc-watch] listed=${r.listed.length} killable=${r.killable.length} killed=${r.killed.filter((k) => k.ok).length}${r.error ? ' error=' + r.error : ''}${r.truncated ? ' truncated: ' + r.truncated : ''}${o.kill ? '' : ' (chi log, them --kill de kill)'}`);
  }
}
