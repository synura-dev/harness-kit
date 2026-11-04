// Giam sat tien trinh con external (do ext-host goi qua spawnSync): chay ext-runner, tu tinh timeout + tran output,
// het han/tran thi giet CA CAY (win32: taskkill /T /F; posix: kill process group) roi thoat 124/125 kem dau [ext-supervisor].
// Ly do: spawnSync timeout chi giet con truc tiep, chau mo coi (nhat la Windows). Event loop o day ranh (code ext chay o tien trinh con).
// argv: <timeoutMs> <maxBytes> <args cho node...>
import { spawn, spawnSync } from 'node:child_process';

export const MARK = '[ext-supervisor]';
const win = process.platform === 'win32';

/** Giet ca cay tien trinh tu pid. Khong nem. */
export function killTree(pid) {
  if (!pid) return;
  if (win) { try { spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: 10000, stdio: 'ignore' }); } catch { /* da chet */ } return; }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* da chet */ } }
}

function main() {
  const [tms, maxB, ...cmd] = process.argv.slice(2);
  const timeoutMs = Math.max(1, Number(tms) || 30000), maxBytes = Math.max(1, Number(maxB) || 262144);
  const child = spawn(process.execPath, cmd, { stdio: ['ignore', 'pipe', 'pipe'], detached: !win, windowsHide: true, env: process.env });
  let bytes = 0, ended = false;
  const stop = (code, why) => {
    if (ended) return; ended = true; clearTimeout(timer);
    killTree(child.pid);
    process.stderr.write(`\n${MARK} ${why}\n`);
    process.exitCode = code;
  };
  const pipe = (src, dst) => src.on('data', (b) => { if (ended) return; bytes += b.length; if (bytes > maxBytes) return stop(125, 'overflow'); dst.write(b); });
  pipe(child.stdout, process.stdout); pipe(child.stderr, process.stderr);
  const timer = setTimeout(() => stop(124, 'timeout'), timeoutMs);
  child.on('error', (e) => { if (ended) return; ended = true; clearTimeout(timer); process.stderr.write(`${MARK} spawn-error ${String(e.message).slice(0, 120)}\n`); process.exitCode = 70; });
  child.on('close', (code) => { if (ended) return; ended = true; clearTimeout(timer); process.exitCode = code === null ? 70 : code; });
}

if (process.argv[1] && /ext-supervisor\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) main();
