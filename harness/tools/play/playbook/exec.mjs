// Playbook exec: spawn khong qua shell, kill tree, summarize, capture.
import { spawn, spawnSync } from '../../../core/runtime/proc.mjs';
import { resolveBin } from '../bin.mjs';

// ---------- exec ----------
const CMD_META = /[&|<>^%"!\r\n]/;

/** exe -> {cmd,args} spawn duoc khong qua shell, hoac {error}. */
export function resolveSpawn(argv, { lookup } = {}) {
  const [exe, ...args] = argv;
  if (exe === 'node') return { cmd: process.execPath, args };
  const bin = resolveBin(exe, lookup ? { lookup } : undefined);
  if (bin.error) return { error: bin.error };
  if (bin.kind === 'exe') return { cmd: bin.path, args };
  if (/[\s&|<>^%"!()]/.test(bin.path)) return { error: `duong dan shim .cmd chua khoang trang/ky tu dac biet, cmd.exe quote khong an toan: dat ${exe.toUpperCase()}_BIN tro toi .exe (${bin.path.slice(0, 50)})` };
  const bad = args.find((a) => CMD_META.test(a));
  if (bad !== undefined) return { error: `doi so chua ky tu cmd.exe nguy hiem (${exe}.cmd): ${bad.slice(0, 30)}` };
  return { cmd: 'cmd.exe', args: ['/d', '/s', '/c', bin.path, ...args] };
}

function killChild(child) {
  try {
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000 });
    else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  } catch {}
}

export function execStep({ cmd, args, cwd, env, timeoutMs, maxBytes }) {
  return new Promise((resolve) => {
    let timedOut = false, done = false, truncated = false, fb = null;
    let out = '', err = '', outB = 0, errB = 0;
    const posix = process.platform !== 'win32';
    let child;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); if (fb) clearTimeout(fb); resolve({ stdout: out, stderr: err, truncated, ...r }); };
    const take = (cur, curB, chunk) => {
      const room = maxBytes - curB;
      if (room <= 0) { truncated = true; return [cur, curB]; }
      if (chunk.length > room) { truncated = true; chunk = chunk.subarray(0, room); }
      return [cur + chunk.toString('utf8'), curB + chunk.length];
    };
    const timer = setTimeout(() => {
      timedOut = true; if (child) killChild(child);
      fb = setTimeout(() => { try { child?.stdout?.destroy(); child?.stderr?.destroy(); } catch {} finish({ exit: null, timedOut: true, error: 'het gio, da kill nhung tien trinh khong dong (fallback 5s)' }); }, 5000);
    }, Math.max(1, timeoutMs));
    try { child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: posix, windowsHide: true }); }
    catch (e) { return finish({ exit: null, timedOut: false, error: e.message }); }
    child.stdout.on('data', (c) => { [out, outB] = take(out, outB, c); });
    child.stderr.on('data', (c) => { [err, errB] = take(err, errB, c); });
    child.on('error', (e) => finish({ exit: null, timedOut, error: e.message }));
    child.on('close', (code) => finish({ exit: timedOut ? null : code, timedOut }));
  });
}

export const clip = (s, n = 200) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function summarizeOutput(text, cfg = {}) {
  const { head = 0, tail = 3, match_regex, max_lines = 5 } = cfg;
  const lines = String(text).split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  if (!lines.length) return [];
  const pick = new Set();
  if (match_regex) { const re = new RegExp(match_regex); lines.forEach((l, i) => { if (re.test(l)) pick.add(i); }); }
  for (let i = 0; i < Math.min(head, lines.length); i++) pick.add(i);
  for (let i = Math.max(0, lines.length - tail); i < lines.length; i++) pick.add(i);
  let idx = [...pick].sort((a, b) => a - b);
  if (idx.length > max_lines) {
    // uu tien: dong khop + tail truoc, cat con lai
    const t = new Set(Array.from({ length: Math.min(tail, lines.length) }, (_, k) => lines.length - 1 - k));
    const tailIdx = idx.filter((i) => t.has(i)).slice(-max_lines);
    const rest = idx.filter((i) => !t.has(i)).slice(0, Math.max(0, max_lines - tailIdx.length));
    idx = [...rest, ...tailIdx].sort((a, b) => a - b);
  }
  return idx.map((i) => clip(lines[i]));
}

export function runCapture(cap, stdout) {
  if (cap.regex !== undefined) {
    const m = new RegExp(cap.regex).exec(stdout);
    if (!m) return { error: 'capture.regex khong khop' };
    return { value: m[1] !== undefined ? m[1] : m[0] };
  }
  if (cap.json_path !== undefined) {
    let j; try { j = JSON.parse(stdout); } catch { return { error: 'capture.json_path: stdout khong phai JSON' }; }
    for (const k of cap.json_path.split('.')) { if (j == null || typeof j !== 'object' || !(k in j)) return { error: `capture.json_path: khong co '${cap.json_path}'` }; j = j[k]; }
    return { value: typeof j === 'string' ? j : JSON.stringify(j) };
  }
  const ls = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, cap.lines);
  return { value: ls.join(',') };
}
