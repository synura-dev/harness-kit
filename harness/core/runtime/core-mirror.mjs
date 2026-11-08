// Ban sao loi harness (agy): sandbox run_command cua agy DOC duoc file trong goc plugin nhung KHONG liet ke (readdir EPERM) -> Bun khong resolve duoc import.
// syncCoreMirror chep <pluginRoot>/harness (+ plugin.json) sang <dataDir>/core/<version>/ (thu muc agy liet ke/ghi duoc). CHI dung cho tien trinh con ext do bin/harness chay trong agy,
// KHONG BAO GIO cho hook/guard (agent ghi duoc thu muc nay) - hook luon nap tu goc plugin that. Tuong thich: node tu goc, Bun tu ban sao.
// shortcut: stamp = sha1(duong dan+size+mtime) thay vi bam noi dung (re); chan tran so file/byte, het han dung em.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pluginLayerDirs } from '../config/config.mjs';

export const MIRROR_LIMITS = Object.freeze({ maxFiles: 5000, maxBytes: 64 * 1024 * 1024, timeoutMs: 8000 });
const SKIP_DIR = new Set(['node_modules', '.git']);
const EXTRA = [['.antigravity-plugin', 'plugin.json'], ['.claude-plugin', 'plugin.json']];

/** Duong goc ban sao cho mot version. */
export const mirrorRoot = (dataDir, version) => path.join(dataDir, 'core', String(version));

function collect(pluginRoot, lim, deadline) {
  const files = []; let bytes = 0;
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(pluginRoot, rel), { withFileTypes: true })) {
      if (Date.now() > deadline) throw new Error('timeout');
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(r); continue; }
      if (!e.isFile() || e.name.endsWith('.test.mjs')) continue;
      const st = fs.statSync(path.join(pluginRoot, r));
      bytes += st.size;
      if (files.length >= lim.maxFiles || bytes > lim.maxBytes) throw new Error('limit');
      files.push({ rel: r, size: st.size, mtime: Math.trunc(st.mtimeMs) });
    }
  };
  walk('harness');
  for (const x of EXTRA) { const r = path.join(...x); try { const st = fs.statSync(path.join(pluginRoot, r)); files.push({ rel: r, size: st.size, mtime: Math.trunc(st.mtimeMs) }); } catch { /* khong co */ } }
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  return files;
}

/** <dataDir>/core that su (khong symlink/junction, realpath dung vi tri) hoac null; tao neu chua co. */
function safeCoreDir(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const coreDir = path.join(dataDir, 'core');
  let l = null; try { l = fs.lstatSync(coreDir); } catch { /* chua co */ }
  if (!l) fs.mkdirSync(coreDir);
  else if (l.isSymbolicLink() || !l.isDirectory()) return null;
  return fs.realpathSync(coreDir) === path.join(fs.realpathSync(dataDir), 'core') ? coreDir : null;
}

/**
 * Kiem ban sao MOI LAN dung (agent ghi duoc thu muc ban sao): moi file trong <mirrorDir>/harness phai co file cung duong dan trong <pluginRoot>/harness
 * (doc truc tiep, khong liet ke goc) va cung noi dung; thua/sai -> {ok:false, file}. Chan tran so file/byte.
 */
export function verifyCoreMirror({ pluginRoot, mirrorDir, limits = {} }) {
  const lim = { ...MIRROR_LIMITS, ...limits };
  let n = 0, bytes = 0;
  const bad = (file, why) => ({ ok: false, file, reason: why });
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(mirrorDir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { const x = walk(r); if (x) return x; continue; }
      if (!e.isFile()) return bad(r, 'khong phai file');
      const a = path.join(mirrorDir, r), b = path.join(pluginRoot, r);
      let sa, sb; try { sa = fs.statSync(a); sb = fs.statSync(b); } catch { return bad(r, 'khong co ban goc'); }
      bytes += sa.size;
      if (++n > lim.maxFiles || bytes > lim.maxBytes) return bad(r, 'vuot gioi han');
      if (sa.size !== sb.size || !fs.readFileSync(a).equals(fs.readFileSync(b))) return bad(r, 'khac ban goc');
    }
    return null;
  };
  const extra = () => { for (const x of EXTRA) { const r = path.join(...x); let a; try { a = fs.readFileSync(path.join(mirrorDir, r)); } catch { continue; } let b; try { b = fs.readFileSync(path.join(pluginRoot, r)); } catch { return bad(r, 'khong co ban goc'); } if (!a.equals(b)) return bad(r, 'khac ban goc'); } return null; };
  try { return walk('harness') || extra() || { ok: true, files: n }; } catch (e) { return bad('harness', String((e && e.message) || e)); }
}

/**
 * Cho bin/harness trong agy: {dir} neu ban sao co + verify sach; {warn} neu co nhung hong/giả mạo; null neu khong ap dung (khong agy / chua co ban sao).
 */
export function pickCoreMirror({ root, env = process.env, limits }) {
  if (!(env.ANTIGRAVITY_AGENT || '').trim()) return null;
  try {
    const data = pluginLayerDirs({ env, repoDir: root }).primaryDir;
    if (!data || !/[\\/]\.gemini[\\/]config[\\/]plugins[\\/][^\\/]+$/i.test(path.resolve(root))) return null;
    const version = String(JSON.parse(fs.readFileSync(path.join(root, '.antigravity-plugin', 'plugin.json'), 'utf8')).version || '');
    const dir = mirrorRoot(data, version);
    if (!version || !fs.existsSync(path.join(dir, 'harness', 'core', 'ext', 'ctx.mjs'))) return null;
    const v = verifyCoreMirror({ pluginRoot: root, mirrorDir: dir, limits });
    return v.ok ? { dir } : { warn: `harness: ban sao loi khong dung duoc (${v.file}: ${v.reason}); dung goc plugin. Mo phien agy moi de dong bo lai.` };
  } catch { return null; }
}

/**
 * @returns {{ok:boolean, action:'copied'|'fresh'|'skipped', dir?:string, files?:number, reason?:string}} khong nem loi.
 */
export function syncCoreMirror({ pluginRoot, dataDir, version, limits = {} }) {
  const lim = { ...MIRROR_LIMITS, ...limits };
  try {
    if (!pluginRoot || !dataDir || !version) return { ok: false, action: 'skipped', reason: 'thieu tham so' };
    const files = collect(pluginRoot, lim, Date.now() + lim.timeoutMs);
    const digest = crypto.createHash('sha1').update(String(version) + JSON.stringify(files)).digest('hex');
    const dest = mirrorRoot(dataDir, version);
    const stampFile = path.join(dest, '.stamp.json');
    // coreDir nam trong thu muc agent ghi duoc: hook chay ngoai sandbox -> tuyet doi khong theo symlink/junction (readdir/rm/ghi) ra ngoai.
    const coreDir = safeCoreDir(dataDir);
    if (!coreDir) return { ok: false, action: 'skipped', reason: 'core/ la symlink/junction hoac ngoai dataDir; bo qua, khong xoa gi' };
    let st = null; try { st = fs.lstatSync(dest); } catch { /* chua co */ }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) return { ok: false, action: 'skipped', reason: 'ban sao la symlink/khong phai thu muc; bo qua' };
    let fresh = false;
    try { fresh = JSON.parse(fs.readFileSync(stampFile, 'utf8')).digest === digest && verifyCoreMirror({ pluginRoot, mirrorDir: dest, limits: lim }).ok; } catch { /* chua co */ }
    if (!fresh) {
      const tmp = path.join(coreDir, `.tmp-${version}-${process.pid}-${Date.now()}`);
      try {
        for (const f of files) { const to = path.join(tmp, f.rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(pluginRoot, f.rel), to); }
        fs.writeFileSync(path.join(tmp, '.stamp.json'), JSON.stringify({ version: String(version), digest, files: files.length }));
        fs.rmSync(dest, { recursive: true, force: true });
        fs.renameSync(tmp, dest);
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }
    for (const e of fs.readdirSync(coreDir)) {
      const p = path.join(coreDir, e);
      if (p === dest || !/^(\d[\w.+-]*|\.tmp-.*)$/.test(e)) continue;
      try { const l = fs.lstatSync(p); if (l.isDirectory() && !l.isSymbolicLink()) fs.rmSync(p, { recursive: true, force: true }); } catch { /* bo qua */ }
    }
    return { ok: true, action: fresh ? 'fresh' : 'copied', dir: dest, files: files.length };
  } catch (e) { return { ok: false, action: 'skipped', reason: String((e && e.message) || e) }; }
}
