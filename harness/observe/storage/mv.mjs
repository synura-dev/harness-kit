// Lenh `data mv <from> <to> [--yes]`: chuyen thu muc/tep trong dataDir co kiem md5 truoc/sau, rollback khi lech, cap nhat registry.
// ctx: { root?, reg?, registryFile?, wsDir?, hubRoot?, opts?:{deadline,maxFiles} }. Tra {code, lines}. Dry-run mac dinh.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataRoot, isInside, samePath } from '../../core/io/paths.mjs';
import { appendJsonl, dataPathFor, today } from '../../core/io/storage.mjs';
import { loadDataRegistry, setEntryPath } from '../../core/registry/data-registry.mjs';
import { walk, LIMITS } from './data.mjs';

const LOCK_TTL_MS = 5 * 60 * 1000;
const posix = (x) => String(x).replace(/\\/g, '/').replace(/\/+$/, '');
const fmtB = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n > 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`);

/** Chuan hoa + kiem '<rel>' trong dataDir. Nem Error('abort: ...'). */
function checkRel(x, what) {
  const s = posix(x ?? '');
  if (!s) throw new Error(`abort: thieu ${what}`);
  if (path.isAbsolute(s) || /^[A-Za-z]:/.test(s) || s.startsWith('/')) throw new Error(`abort: ${what} khong duoc la duong dan tuyet doi`);
  if (s.split('/').some((p) => p === '..' || p === '.' || p === '')) throw new Error(`abort: ${what} co '..'`);
  return s;
}

/** Manifest md5: {files:[{rel,size,md5}], bytes, md5(total), truncated}. */
export function manifest(abs, { maxFiles = LIMITS.maxFiles, deadline = Date.now() + LIMITS.timeoutS * 1000 } = {}) {
  const st = fs.lstatSync(abs);
  const list = st.isDirectory() ? walk(abs, { maxFiles, deadline }) : { files: [{ p: abs, size: st.size }], truncated: null };
  let truncated = list.truncated;
  const files = [];
  for (const f of list.files.sort((a, b) => (a.p < b.p ? -1 : 1))) {
    if (Date.now() > deadline) { truncated = 'timeout'; break; }
    const rel = st.isDirectory() ? posix(path.relative(abs, f.p)) : path.basename(abs);
    files.push({ rel, size: f.size, md5: crypto.createHash('md5').update(fs.readFileSync(f.p)).digest('hex') });
  }
  const total = crypto.createHash('md5');
  let bytes = 0;
  for (const f of files) { total.update(`${f.rel}\0${f.size}\0${f.md5}\n`); bytes += f.size; }
  return { files, bytes, md5: total.digest('hex'), truncated };
}

/** Rename nguoc (rollback). -> null neu ok | chuoi loi voi duong dan chinh xac. KHONG nuot loi. */
export function rollbackRename(from, to) {
  try { fs.renameSync(from, to); return null; } catch (e) { return `rollback rename THAT BAI (${e.code || e.message}): du lieu dang o "${from}", can chuyen thu cong ve "${to}"`; }
}

export function takeLock(root) {
  const file = path.join(root, '.state', 'mv.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' }); return file; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let j = null; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      if (j && Date.now() - j.ts < LOCK_TTL_MS) throw new Error(`abort: mv dang chay (pid ${j.pid}); thu lai sau (khoa het han 5 phut)`);
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  }
  throw new Error('abort: khong lay duoc khoa mv');
}

export async function mvCmd(args = [], ctx = {}) {
  const lines = [];
  const L = (s) => lines.push(s);
  const fail = (e) => { L(`data mv: ${e.message}`); return { code: /abort:/.test(e.message) ? 2 : 1, lines }; };
  let lock = null;
  try {
    const yes = args.includes('--yes');
    const pos = args.filter((a) => !a.startsWith('--'));
    if (pos.length !== 2) throw new Error('abort: usage: data mv <from> <to> [--yes]');
    const from = checkRel(pos[0], 'from');
    const to = checkRel(pos[1], 'to');
    const root = ctx.root || dataRoot();
    const reg = ctx.reg || loadDataRegistry({ registryFile: ctx.registryFile, workspacesDir: ctx.wsDir, noCache: true });
    if (reg.failed) throw new Error(`abort: registry khong doc duoc${reg.failedFiles?.length ? ' (' + reg.failedFiles.join(', ') + ')' : ''}`);
    if (to === from || to.startsWith(from + '/')) throw new Error('abort: to nam trong from');
    const absFrom = path.join(root, ...from.split('/'));
    const absTo = path.join(root, ...to.split('/'));
    if (!isInside(absFrom, root) || samePath(absFrom, root) || !isInside(absTo, root) || samePath(absTo, root)) throw new Error('abort: from/to thoat khoi dataDir');
    if (!fs.existsSync(absFrom)) throw new Error(`abort: from khong ton tai: ${from}`);
    const st = fs.lstatSync(absFrom);
    if (st.isSymbolicLink() || !(st.isDirectory() || st.isFile())) throw new Error('abort: from phai la thu muc hoac tep thuong');
    if (fs.existsSync(absTo)) throw new Error(`abort: dich da ton tai, khong ghi de: ${to}`);
    const hit = Object.entries(reg.entries).find(([k, e]) => posix((e && e.path) || k) === from);
    if (!hit) throw new Error(`abort: ${from} chua co trong registry; chay: harness data register <zone>/<domain>/<tool> --class <c> --owner <o>`);
    const lim = { maxFiles: ctx.opts?.maxFiles ?? LIMITS.maxFiles, deadline: ctx.opts?.deadline ?? Date.now() + LIMITS.timeoutS * 1000 };
    const before = manifest(absFrom, lim);
    const show = (tag, m) => L(`${tag}: ${m.files.length} file, ${m.bytes} bytes (${fmtB(m.bytes)}), md5=${m.md5}${m.truncated ? `  truncated: ${m.truncated}` : ''}`);
    if (!yes) {
      L(`dry-run: se chuyen ${from} -> ${to} (key ${hit[0]})`);
      show('before', before);
      L('them --yes de chuyen; hoan tac: data mv ' + to + ' ' + from + ' --yes');
      return { code: 0, lines, manifest: before };
    }
    if (before.truncated) throw new Error(`abort: manifest bi cat (${before.truncated}); khong the xac minh md5`);
    lock = takeLock(root);
    fs.mkdirSync(path.dirname(absTo), { recursive: true });
    try { fs.renameSync(absFrom, absTo); } catch (e) { throw new Error(`abort: rename that bai (${e.code || e.message}); chi ho tro cung o dia`); }
    const after = manifest(absTo, { ...lim, deadline: Date.now() + LIMITS.timeoutS * 1000 });
    if (after.truncated || after.md5 !== before.md5 || after.files.length !== before.files.length) {
      const rb = rollbackRename(absTo, absFrom);
      throw new Error(`abort: md5 lech sau rename; ${rb || 'da rename nguoc'}`);
    }
    let upd = null;
    try { upd = setEntryPath(from, to, { registryFile: ctx.registryFile, workspacesDir: ctx.wsDir }); } catch (e) { upd = null; L(`canh bao ghi registry loi: ${e.message}`); }
    if (!upd) {
      const rb = rollbackRename(absTo, absFrom);
      throw new Error(`abort: khong cap nhat duoc registry; ${rb || 'da rename nguoc'}`);
    }
    try { appendJsonl(dataPathFor('audit', `date=${today()}`, 'type=data-access', 'data-cli.jsonl'), { ts: new Date().toISOString(), cmd: 'mv', from, to, key: upd.key, files: after.files.length, bytes: after.bytes, md5: after.md5 }); } catch {}
    L(`da chuyen ${from} -> ${to} (key ${upd.key}; legacy giu trong registry)`);
    show('before', before);
    show('after ', after);
    L('md5 khop');
    return { code: 0, lines, before, after };
  } catch (e) { return fail(e); } finally { if (lock) try { fs.rmSync(lock, { force: true }); } catch {} }
}
