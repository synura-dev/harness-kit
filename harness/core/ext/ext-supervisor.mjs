// Giam sat tien trinh con external (do ext-host goi qua spawnSync): chay ext-runner, tu tinh timeout + tran output,
// het han/tran thi giet CA CAY (win32: taskkill /T /F; posix: kill process group) roi thoat 124/125 kem dau [ext-supervisor].
// Ly do: spawnSync timeout chi giet con truc tiep, chau mo coi (nhat la Windows). Event loop o day ranh (code ext chay o tien trinh con).
// argv: <timeoutMs> <maxBytes> <args cho node...>
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

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
  const inherit = maxB === 'inherit'; // lenh nguoi dung (manifest tty): stdio that, khong bat output, khong tran
  const timeoutMs = Math.max(1, Number(tms) || 30000), maxBytes = Math.max(1, Number(maxB) || 262144);
  const fwd = !inherit && process.env.HARNESS_STDIN_FORWARD === '1';
  let inp = ''; if (fwd) { try { inp = fs.readFileSync(0); } catch { inp = ''; } }
  // shortcut: inherit tren posix khong detached (giu terminal dieu khien) -> killTree roi ve kill pid truc tiep.
  const child = spawn(process.execPath, cmd, { stdio: inherit ? 'inherit' : [fwd ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: !win && !inherit, windowsHide: true, env: process.env });
  if (fwd) { child.stdin.on('error', () => {}); child.stdin.end(inp); }
  let bytes = 0, ended = false;
  const stop = (code, why) => {
    if (inherit && why === 'timeout') code = 197; // = TTY_TIMEOUT_CODE o ext-host (stderr khong bat duoc o inherit)
    if (ended) return; ended = true; clearTimeout(timer);
    killTree(child.pid);
    process.stderr.write(`\n${MARK} ${why}\n`);
    process.exitCode = code;
  };
  const pipe = (src, dst) => src.on('data', (b) => { if (ended) return; bytes += b.length; if (bytes > maxBytes) return stop(125, 'overflow'); dst.write(b); });
  if (!inherit) { pipe(child.stdout, process.stdout); pipe(child.stderr, process.stderr); }
  const timer = setTimeout(() => stop(124, 'timeout'), timeoutMs);
  child.on('error', (e) => { if (ended) return; ended = true; clearTimeout(timer); process.stderr.write(`${MARK} spawn-error ${String(e.message).slice(0, 120)}\n`); process.exitCode = 70; });
  child.on('close', (code) => { if (ended) return; ended = true; clearTimeout(timer); process.exitCode = code === null ? 70 : (inherit && code === 197 ? 1 : code); });
}

if (process.argv[1] && /ext-supervisor\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) main();
