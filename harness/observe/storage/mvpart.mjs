// `data mvpart <key> [--yes] [--keep-days N | --before YYYY-MM-DD] [--rest]`: chuyen TUNG phan vung date=YYYY-MM-DD da dong tu legacy sang path moi.
// Giu hom nay + hom qua (gio dia phuong; --keep-days N doi: giu N+1 ngay gan nhat gom hom nay). md5 truoc/sau tung phan vung,
// rename cung o; trung ten file o dich -> doi thanh <ten>.legacy.jsonl canh file moi (khong sua noi dung); EBUSY/EPERM -> bo qua.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataRoot, isInside } from '../../core/io/paths.mjs';
import { appendJsonl, dataPathFor, today } from '../../core/io/storage.mjs';
import { loadDataRegistry, resolveDataRel, setEntryPath } from '../../core/registry/data-registry.mjs';
import { manifest } from './mv.mjs';

const LOCK_TTL_MS = 5 * 60 * 1000;
const MVPART_LIMITS = { maxFiles: 5000, timeoutS: 60 };
const fmtB = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n > 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DATE_RE = /^date=(\d{4}-\d{2}-\d{2})$/;

function takeLock(root) {
  const file = path.join(root, '.state', 'mvpart.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' }); return file; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let j = null; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      if (j && Date.now() - j.ts < LOCK_TTL_MS) throw new Error(`abort: mvpart dang chay (pid ${j.pid})`);
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  }
  throw new Error('abort: khong lay duoc khoa mvpart');
}

/** Liet ke phan vung date= (de quy toi da 3 cap) duoi absRoot: [{rel:'gateway/date=D' | 'date=D', date}]. */
function findParts(absRoot, depth = 0, prefix = '') {
  const out = [];
  let ents; try { ents = fs.readdirSync(absRoot, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    const m = DATE_RE.exec(e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (m) out.push({ rel, date: m[1] });
    else if (depth < 3 && !e.name.startsWith('.')) out.push(...findParts(path.join(absRoot, e.name), depth + 1, rel));
  }
  return out;
}

/** Chuyen 1 phan vung: tra {moved,files,bytes,renamed,skipped?,reason?}. */
export function movePartition(src, dst, lim, fsx = fs) {
  const before = manifest(src, lim);
  if (before.truncated) return { skipped: true, reason: `manifest ${before.truncated}`, files: 0, bytes: 0 };
  const done = []; // [{from,to}] de hoan tac
  const kept = [];
  const back = (list) => { for (const d of list.reverse()) { if (fs.existsSync(d.a)) { kept.push(d.a); continue; } try { fs.renameSync(d.b, d.a); } catch {} } };
  let renamed = 0;
  try {
    for (const f of before.files) {
      const a = path.join(src, ...f.rel.split('/'));
      let b = path.join(dst, ...f.rel.split('/'));
      fs.mkdirSync(path.dirname(b), { recursive: true });
      if (fs.existsSync(b)) {
        const ext = path.extname(b);
        const stem = ext ? b.slice(0, -ext.length) : b;
        let k = 0; let nb2;
        do { nb2 = `${stem}.legacy${k ? k + 1 : ''}${ext}`; k++; } while (fs.existsSync(nb2) && k < 20);
        b = nb2;
        if (fs.existsSync(b)) throw Object.assign(new Error('dich .legacy da ton tai'), { code: 'EEXIST' });
        renamed++;
      }
      fsx.renameSync(a, b);
      done.push({ a, b });
    }
  } catch (e) {
    back(done);
    return { skipped: true, reason: (e.code || e.message) + (kept.length ? `; giu ca hai (src moi): ${kept.join(', ')}` : ''), files: 0, bytes: 0 };
  }
  // kiem md5 tai dich theo manifest cu (ten co the doi .legacy)
  let ok = true;
  for (let i = 0; i < before.files.length; i++) {
    try { if (crypto.createHash('md5').update(fs.readFileSync(done[i].b)).digest('hex') !== before.files[i].md5) { ok = false; break; } } catch { ok = false; break; }
  }
  if (!ok) {
    back(done);
    return { skipped: true, reason: 'md5 lech; da hoan tac' + (kept.length ? `; giu ca hai: ${kept.join(', ')}` : ''), files: 0, bytes: 0 };
  }
  // file moi xuat hien trong src sau manifest (writer): chuyen not; khong xoa de quy
  const conLai = [];
  const rest = [];
  const scan = (d, pre) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const rel = pre ? `${pre}/${e.name}` : e.name; if (e.isDirectory() && !e.isSymbolicLink()) scan(path.join(d, e.name), rel); else rest.push(rel); } };
  scan(src, '');
  let extra = 0;
  for (const rel of rest) {
    const r2 = moveFile(path.join(src, ...rel.split('/')), path.join(dst, ...rel.split('/')), fsx);
    if (r2.moved) { extra++; renamed += r2.renamed; } else conLai.push(rel);
  }
  const rmEmpty = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) if (e.isDirectory() && !e.isSymbolicLink()) rmEmpty(path.join(d, e.name)); try { fs.rmdirSync(d); } catch {} };
  rmEmpty(src);
  return { moved: true, files: before.files.length + extra, bytes: before.bytes, renamed, md5: before.md5, conLai };
}

/** Liet ke file con lai (khong thuoc date=) duoi absRoot, bo khoa *.lock: [rel posix]. */
function listRest(absRoot, lim) {
  const out = []; let truncated = null;
  const walk = (dir, pre) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (truncated) return;
      if (Date.now() > lim.deadline) { truncated = 'timeout'; return; }
      if (out.length >= lim.maxFiles) { truncated = `max-files ${lim.maxFiles}`; return; }
      const rel = pre ? `${pre}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!DATE_RE.test(e.name)) walk(path.join(dir, e.name), rel); }
      else if (e.isFile() && !e.name.endsWith('.lock')) out.push(rel);
    }
  };
  walk(absRoot, '');
  return { files: out, truncated };
}

/** Chuyen 1 file (md5 truoc/sau, trung ten -> .legacy, khong de). Tra {moved,bytes,renamed} | {skipped,reason}. */
function moveFile(a, b, fsx = fs) {
  let before; try { before = crypto.createHash('md5').update(fs.readFileSync(a)).digest('hex'); } catch (e) { return { skipped: true, reason: e.code || e.message }; }
  let renamed = 0;
  fs.mkdirSync(path.dirname(b), { recursive: true });
  if (fs.existsSync(b)) {
    const ext = path.extname(b);
    const stem = ext ? b.slice(0, -ext.length) : b;
    let k = 0; let nb2;
    do { nb2 = `${stem}.legacy${k ? k + 1 : ''}${ext}`; k++; } while (fs.existsSync(nb2) && k < 20);
    if (fs.existsSync(nb2)) return { skipped: true, reason: 'dich .legacy da ton tai' };
    b = nb2;
    renamed = 1;
  }
  try { fsx.renameSync(a, b); } catch (e) { return { skipped: true, reason: e.code || e.message }; }
  let ok = false; try { ok = crypto.createHash('md5').update(fs.readFileSync(b)).digest('hex') === before; } catch {}
  if (!ok) {
    if (fs.existsSync(a)) return { skipped: true, reason: `md5 lech; giu ca hai (${a} la file moi, ${b} la ban chuyen)` };
    try { fs.renameSync(b, a); } catch {}
    return { skipped: true, reason: 'md5 lech; da hoan tac' };
  }
  return { moved: true, bytes: fs.statSync(b).size, renamed };
}

export async function mvpartCmd(args = [], ctx = {}) {
  const lines = [];
  const L = (s) => lines.push(s);
  let lock = null;
  try {
    const yes = args.includes('--yes');
    const ki = args.indexOf('--keep-days');
    const keep = ki >= 0 ? Number(args[ki + 1]) : 1;
    const bi = args.indexOf('--before');
    const before = bi >= 0 ? args[bi + 1] : null;
    if (bi >= 0 && (!/^\d{4}-\d{2}-\d{2}$/.test(before || '') || ki >= 0)) throw new Error('abort: --before YYYY-MM-DD (khong kem --keep-days)');
    const rest = args.includes('--rest');
    const force = args.includes('--force');
    if (!Number.isInteger(keep) || keep < 0 || keep > 3650) throw new Error('abort: --keep-days 0..3650');
    const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && (args[i - 1] === '--keep-days' || args[i - 1] === '--before')));
    if (pos.length !== 1) throw new Error('abort: usage: data mvpart <key> [--yes] [--keep-days N | --before YYYY-MM-DD] [--rest] [--force]');
    const key = pos[0];
    const root = ctx.root || dataRoot();
    const reg = ctx.reg || loadDataRegistry({ registryFile: ctx.registryFile, workspacesDir: ctx.wsDir, noCache: true });
    if (reg.failed) throw new Error('abort: registry khong doc duoc');
    if (!reg.entries[key]) throw new Error(`abort: key khong co trong registry: ${key}`);
    const r = resolveDataRel(key, { registry: reg, env: ctx.env });
    if (!r.legacyRel || !r.exists.legacy) throw new Error('abort: khong co legacy ton tai de chuyen');
    if (r.legacyRel === r.rel) throw new Error('abort: legacy trung path');
    const absOld = path.join(root, ...r.legacyRel.split('/'));
    const absNew = path.join(root, ...r.rel.split('/'));
    if (!isInside(absOld, root) || !isInside(absNew, root)) throw new Error('abort: thoat khoi dataDir');
    const now = ctx.now ?? Date.now();
    const cut = new Date(now); cut.setDate(cut.getDate() - keep); // giu date >= cut
    const cutStr = before || ymd(cut);
    if (before && !force) { const lim1 = new Date(now); lim1.setDate(lim1.getDate() + 1); if (before > ymd(lim1)) throw new Error(`abort: --before ${before} qua xa tuong lai (> hom nay+1); them --force neu that su can`); }
    const lim = { maxFiles: ctx.opts?.maxFiles ?? MVPART_LIMITS.maxFiles, deadline: ctx.opts?.deadline ?? now + MVPART_LIMITS.timeoutS * 1000 };
    const parts = findParts(absOld).filter((p) => p.date < cutStr).sort((a, b) => (a.rel < b.rel ? -1 : 1));
    let nf = 0; let nb = 0; let moved = 0; let renamed = 0; const skipped = []; let truncated = null;
    if (!yes) {
      for (const p of parts) {
        if (Date.now() > lim.deadline) { truncated = 'timeout'; break; }
        const m = manifest(path.join(absOld, ...p.rel.split('/')), lim);
        nf += m.files.length; nb += m.bytes;
        if (nf > lim.maxFiles) { truncated = `max-files ${lim.maxFiles}`; break; }
      }
      L(`dry-run: se chuyen ${parts.length} phan vung (${nf} file, ${nb} bytes ${fmtB(nb)}) ${r.legacyRel} -> ${r.rel}; giu date >= ${cutStr}${truncated ? `  truncated: ${truncated}` : ''}`);
      if (rest) { const lr = listRest(absOld, lim); L(`rest (khong theo ngay): ${lr.files.length} file${lr.truncated ? ` truncated: ${lr.truncated}` : ''}`); }
      L('them --yes de chuyen');
      return { code: 0, lines, partitions: parts.length, files: nf, bytes: nb, truncated };
    }
    lock = takeLock(root);
    for (const p of parts) {
      if (Date.now() > lim.deadline) { truncated = 'timeout'; break; }
      if (nf >= lim.maxFiles) { truncated = `max-files ${lim.maxFiles}`; break; }
      const res = movePartition(path.join(absOld, ...p.rel.split('/')), path.join(absNew, ...p.rel.split('/')), lim, ctx.fsx || fs);
      if (res.moved) { if (res.conLai?.length) { skipped.push(`${p.rel} (con lai ${res.conLai.length})`); L(`con lai ${p.rel}: ${res.conLai.join(', ')}`); } moved++; nf += res.files; nb += res.bytes; renamed += res.renamed; L(`chuyen ${p.rel}: ${res.files} file ${res.bytes}B md5=${res.md5}${res.renamed ? ` (${res.renamed} file -> .legacy)` : ''}`); }
      else { skipped.push(p.rel); L(`bo qua ${p.rel}: ${res.reason}`); }
    }
    if (rest && !truncated) {
      const lr = listRest(absOld, lim); let rm = 0; let rb = 0; let rr = 0;
      for (const rel of lr.files) {
        const res = moveFile(path.join(absOld, ...rel.split('/')), path.join(absNew, ...rel.split('/')), ctx.fsx || fs);
        if (res.moved) { rm++; rb += res.bytes; rr += res.renamed; L(`rest ${rel}: ${res.bytes}B${res.renamed ? ' -> .legacy' : ''}`); } else { skipped.push(rel); L(`bo qua ${rel}: ${res.reason}`); }
      }
      nf += rm; nb += rb; renamed += rr; if (lr.truncated) truncated = lr.truncated;
      L(`rest: ${rm} file`);
    }
    if (args.includes('--drop-legacy')) {
      const left = listRest(absOld, lim); const lp = findParts(absOld);
      if (truncated || skipped.length || left.truncated || left.files.length || lp.length) L(`drop-legacy: bo qua, legacy con ${left.files.length} file/${lp.length} phan vung`);
      else {
        const rmEmpty = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) if (e.isDirectory() && !e.isSymbolicLink()) rmEmpty(path.join(d, e.name)); try { fs.rmdirSync(d); } catch {} };
        rmEmpty(absOld);
        const upd = setEntryPath(r.rel, r.rel, { registryFile: ctx.registryFile, workspacesDir: ctx.wsDir, dropLegacy: true });
        L(upd ? `drop-legacy: da bo legacy khoi registry (${upd.key})` : 'drop-legacy: khong ghi duoc registry');
      }
    }
    try { appendJsonl(dataPathFor('audit', `date=${today()}`, 'type=data-access', 'data-cli.jsonl'), { ts: new Date().toISOString(), cmd: 'mvpart', key, partitions: moved, files: nf, bytes: nb, legacyRenamed: renamed, skipped: skipped.length, truncated }); } catch {}
    L(`xong: ${moved} phan vung, ${nf} file, ${nb} bytes; bo qua ${skipped.length}${truncated ? `; truncated: ${truncated}` : ''}`);
    return { code: 0, lines, moved, files: nf, bytes: nb, skipped, truncated };
  } catch (e) { L(`data mvpart: ${e.message}`); return { code: /abort:/.test(e.message) ? 2 : 1, lines }; } finally { if (lock) try { fs.rmSync(lock, { force: true }); } catch {} }
}
