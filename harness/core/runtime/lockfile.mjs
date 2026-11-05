// Khoa file nhe: tao `<file>.lock` bang flag wx, stale timeout, retry ngan co tran. Dong bo (dung duoc trong hook). Khong throw.
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { const t = Date.now() + ms; while (Date.now() < t); } };

/** Lay khoa. Tra ham release hoac null (het retry). Khoa cu hon staleMs bi coi la mo coi: rename sang ten duy nhat roi xoa (chi ben rename thanh cong moi di tiep). Release chi xoa khoa neu noi dung dung la cua minh. */
export function acquireLock(file, { staleMs = 15000, retries = 20, waitMs = 25 } = {}) {
  const lf = `${file}.lock`;
  const token = JSON.stringify({ pid: process.pid, ts: Date.now(), n: Math.random().toString(36).slice(2) });
  for (let i = 0; i <= retries; i++) {
    try {
      const fd = fs.openSync(lf, 'wx');
      try { fs.writeSync(fd, token); } catch { /* khong ghi duoc noi dung khoa */ }
      fs.closeSync(fd);
      return () => { try { if (fs.readFileSync(lf, 'utf8') === token) fs.unlinkSync(lf); } catch { /* da mat / cua nguoi khac */ } };
    } catch (e) {
      if (e && e.code === 'ENOENT') { try { fs.mkdirSync(path.dirname(lf), { recursive: true }); } catch { /* bo qua */ } continue; }
      if (reapStale(lf, staleMs)) continue;
      if (i < retries) sleep(waitMs);
    }
  }
  return null;
}

/** Don khoa stale an toan: rename sang ten duy nhat (chi mot ben thanh cong), kiem lai la stale that, roi xoa. true = nen thu tao khoa ngay. */
function reapStale(lf, staleMs) {
  try {
    if (Date.now() - fs.statSync(lf).mtimeMs <= staleMs) return false;
    const tomb = `${lf}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
    fs.renameSync(lf, tomb); // loi (da bi ben khac don/nha) -> nhay xuong catch
    let fresh = false;
    try { fresh = Date.now() - fs.statSync(tomb).mtimeMs <= staleMs; } catch { /* mat */ }
    if (fresh) { try { fs.linkSync(tomb, lf); } catch { /* lf da co khoa moi */ } } // lo rename nham khoa moi cua ben khac: tra lai neu con trong
    try { fs.unlinkSync(tomb); } catch { /* bo qua */ }
    return !fresh;
  } catch { return false; }
}

/** Chay fn duoi khoa. Tra {ok:true, value} hoac {ok:false} khi khong lay duoc khoa (fail-open: nguoi goi bo qua lan ghi nay). */
export function withLock(file, fn, opts) {
  const release = acquireLock(file, opts);
  if (!release) return { ok: false };
  try { return { ok: true, value: fn() }; } finally { release(); }
}
