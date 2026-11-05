// Liet ke tien trinh (Win32_Process, roi xuong wmic). Dung chung cho cli/proc-watch va hooks/proc-orphans.
import { spawnSync } from './proc.mjs';

export const parseDate = (s) => {
  if (!s) return null;
  const m = /\/Date\((\d+)\)\//.exec(String(s));
  const t = m ? Number(m[1]) : Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

/** CreationDate cua wmic: yyyymmddHHMMSS.ffffff+mmm (gio dia phuong + do lech phut so voi UTC o cuoi) -> epoch ms dung. Thieu do lech -> coi la gio local may. Rac -> null. */
export function parseWmicDate(cd) {
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(?:\.(\d+))?([+-]\d{1,4})?/.exec(String(cd || '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const ms = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
  if (m[8] == null) return new Date(y, mo - 1, d, h, mi, s, ms).getTime();
  return Date.UTC(y, mo - 1, d, h, mi, s, ms) - Number(m[8]) * 60000;
}

/** Liet ke tien trinh (Win32_Process). Tra ve {procs, error?}. */
export function listProcesses({ timeoutMs = 15000, maxProcs = 5000 } = {}) {
  if (process.platform !== 'win32') return { procs: [], error: 'chi ho tro win32' };
  const ps = 'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; start=($_.CreationDate.ToUniversalTime().ToString("o")); cpu=([double]($_.KernelModeTime+$_.UserModeTime)/1e7); cmd=$_.CommandLine } } | ConvertTo-Json -Compress';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (r.status === 0 && r.stdout.trim()) {
    try {
      let a = JSON.parse(r.stdout); if (!Array.isArray(a)) a = [a];
      return { procs: a.slice(0, maxProcs).map((p) => ({ ...p, startMs: parseDate(p.start) })), truncated: a.length > maxProcs ? 'maxProcs' : undefined };
    } catch (e) { /* roi xuong wmic */ }
  }
  const w = spawnSync('wmic', ['process', 'get', 'ProcessId,ParentProcessId,Name,CreationDate,KernelModeTime,UserModeTime,CommandLine', '/format:csv'], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (w.status !== 0) return { procs: [], error: `powershell va wmic deu loi (${r.error?.message || r.status}; ${w.error?.message || w.status})` };
  const procs = [];
  for (const line of w.stdout.split(/\r?\n/).slice(1)) {
    const c = line.split(','); if (c.length < 8) continue; // Node,Cmd,CreationDate,KMT,Name,PPID,PID,UMT -> sap xep theo header
    const [, cmd, cd, kmt, name, ppid, pid, umt] = [c[0], c.slice(1, c.length - 6).join(','), ...c.slice(-6)];
    procs.push({ pid: +pid, ppid: +ppid, name, cmd, cpu: (Number(kmt) + Number(umt)) / 1e7, startMs: parseWmicDate(cd) });
    if (procs.length >= maxProcs) break;
  }
  return { procs };
}

// Dung chung: lay dong dau cua `<cmd> --version` (timeout 5s). null neu loi. Khong ton model.

export const ver = (cmd) => {
  try {
    const r = spawnSync(`${cmd} --version`, { encoding: 'utf8', timeout: 5000, shell: true });
    return r.status === 0 ? (r.stdout || '').trim().split('\n')[0] : null;
  } catch { return null; }
};

