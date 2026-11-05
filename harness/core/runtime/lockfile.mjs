// Khoa file nhe: tao `<file>.lock` bang flag wx, stale timeout, retry ngan co tran. Dong bo (dung duoc trong hook). Khong throw.
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { const t = Date.now() + ms; while (Date.now() < t); } };

/** Lay khoa. Tra ham release hoac null (het retry). Khoa cu hon staleMs bi coi la mo coi va don. */
export function acquireLock(file, { staleMs = 15000, retries = 20, waitMs = 25 } = {}) {
  const lf = `${file}.lock`;
  for (let i = 0; i <= retries; i++) {
    try {
      const fd = fs.openSync(lf, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() })); } catch { /* khong ghi duoc noi dung khoa */ }
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(lf); } catch { /* da mat */ } };
    } catch (e) {
      if (e && e.code === 'ENOENT') { try { fs.mkdirSync(path.dirname(lf), { recursive: true }); } catch { /* bo qua */ } continue; }
      try { if (Date.now() - fs.statSync(lf).mtimeMs > staleMs) { fs.unlinkSync(lf); continue; } } catch { /* khoa vua duoc nha */ }
      if (i < retries) sleep(waitMs);
    }
  }
  return null;
}

/** Chay fn duoi khoa. Tra {ok:true, value} hoac {ok:false} khi khong lay duoc khoa (fail-open: nguoi goi bo qua lan ghi nay). */
export function withLock(file, fn, opts) {
  const release = acquireLock(file, opts);
  if (!release) return { ok: false };
  try { return { ok: true, value: fn() }; } finally { release(); }
}
