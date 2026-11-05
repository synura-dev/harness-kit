// Batch check re cua doctor chay nen (<=1 lan/24h): ref, import, manifest, clutter, stray. Ghi state; hook chi doc. Khong check nang.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REL = ['.state', 'data-check-doctor.json'];
const wj = (f, o) => { const t = `${f}.${process.pid}.tmp`; try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); return true; } catch { try { fs.unlinkSync(t); } catch {} return false; } };
const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
export const stateFile = (dd) => path.join(dd, ...REL);

/** Tinh danh sach loi (chuoi on dinh) tu cac check re. Moi nhom check bao try rieng. */
export async function collectErrors(hubRoot, repoDir) {
  const out = [];
  const M = (p) => import(new URL(p, import.meta.url).href);
  try { const { checkManifest, checkRegistry } = await M('../../core/checks/manifest-check.mjs'); for (const m of [...checkManifest(hubRoot), ...checkRegistry(hubRoot)]) out.push(`manifest: ${m}`); } catch {}
  try {
    const { buildScanInput, collectStray } = await M('../../core/checks/scan-input.mjs');
    const { checkRefs } = await M('../../core/checks/ref-check.mjs');
    const { scanTree } = await M('../../core/checks/import-check.mjs');
    const { checkClutter, checkStray } = await M('../../core/checks/clutter-check.mjs');
    const si = buildScanInput(hubRoot);
    if (path.resolve(hubRoot).toLowerCase() === path.resolve(repoDir).toLowerCase()) for (const e of checkRefs({ files: si.files, exists: si.exists }).errors) out.push(`ref: ${e.file}:${e.line} -> ${e.ref}`);
    const imp = scanTree(hubRoot);
    for (const v of imp.violations) out.push(`import: ${v.file}:${v.line} ${v.from} -> ${v.to}`);
    for (const m of imp.missing) out.push(`import: ${m.file}:${m.line} thieu ${m.spec}`);
    for (const f of checkClutter(si.files, si.registry).findings) if (f.severity === 'error') out.push(`clutter: ${f.rule} ${f.path}`);
    for (const s of checkStray(collectStray(hubRoot).entries)) out.push(`stray: ${s.path}`);
  } catch {}
  return [...new Set(out)];
}

/** Chay batch, ghi state: errors hien tai + fresh (loi moi so voi lan truoc, giu den khi da bao). */
export async function runBatch(dd, hubRoot, repoDir, now = Date.now(), collect = collectErrors) {
  const f = stateFile(dd); const prev = rd(f) || {};
  const errors = await collect(hubRoot, repoDir);
  const old = new Set(prev.errors || []);
  const fresh = errors.filter((e) => !old.has(e));
  const pending = [...new Set([...(prev.seen === false ? prev.fresh || [] : []), ...fresh])].filter((e) => errors.includes(e));
  wj(f, { lastRun: now, done: true, errors, fresh: pending, seen: pending.length === 0 });
  return { errors, fresh: pending };
}

/** Hook: spawn nen khi >= minIntervalHours; tra dong canh bao loi MOI (toi da maxLines) hoac []. */
export function doctorAuto(dd, cfg, ctx = {}) {
  try {
    const da = { enabled: true, minIntervalHours: 24, timeoutS: 60, maxLines: 5, ...(cfg.doctorAuto || {}) };
    const env = ctx.env || process.env;
    if (!da.enabled || env.HOOK_DATA_CHECK_DOCTOR === '0') return [];
    const f = stateFile(dd); const st = rd(f) || {}; const now = Date.now(); let lines = [];
    if (st.seen === false && Array.isArray(st.fresh) && st.fresh.length) {
      lines = st.fresh.slice(0, da.maxLines).map((e) => `doctor: loi moi ${String(e).slice(0, 160)}`);
      if (st.fresh.length > da.maxLines) lines.push(`doctor: ... con ${st.fresh.length - da.maxLines} loi moi nua. Xem: harness doctor`);
      wj(f, { ...st, seen: true });
    }
    if (now - (Number(st.lastRun) || 0) >= da.minIntervalHours * 3600e3) {
      const lf = path.join(dd, '.state', 'data-check-doctor.lock'); const lock = rd(lf);
      if (!(lock && now - Number(lock.ts) < 5 * 60e3)) {
        wj(lf, { ts: now, pid: process.pid });
        (ctx.spawnDoctor || (() => {
          const p = spawn(process.execPath, [fileURLToPath(import.meta.url), '--run', dd], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, HARNESS_GATEWAY: '1' } });
          p.on('error', () => {}); p.unref();
        }))();
      }
    }
    return lines;
  } catch { return []; }
}

if (process.argv[2] === '--run' && process.argv[3] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const { workspaceRoot, REPO_DIR } = await import('../../core/io/paths.mjs');
  const kill = setTimeout(() => process.exit(2), 60000); // timeout cung: dung em, lan sau thu lai
  try { await runBatch(process.argv[3], workspaceRoot(), REPO_DIR); } catch {}
  clearTimeout(kill);
  try { fs.unlinkSync(path.join(process.argv[3], '.state', 'data-check-doctor.lock')); } catch {}
  process.exit(0);
}
