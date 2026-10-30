#!/usr/bin/env node
// Xoa phan vung date= cu hon retention_days. Mac dinh --dry-run; can --yes de xoa that.
import { readdirSync, readFileSync, rmSync, existsSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAuditConfig, auditRoot } from '../../core/config/audit-config.mjs';
import { statSync } from 'node:fs';
import { dataPathFor } from '../../core/io/storage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const dayStr = (d) => d.toISOString().slice(0, 10);

function retentionDays(files) {
  const n = loadAuditConfig(files).config.retention_days;
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

export function prune({ root = auditRoot(), runsRoot = dataPathFor('runs', { mode: 'read', quiet: true }), days = retentionDays(), yes = false, now = new Date(), onceDay = false, timeoutMs = loadAuditConfig().config.limits?.query_timeout_ms ?? 30000 } = {}) {
  const deadline = Date.now() + (timeoutMs > 0 ? timeoutMs : 30000);
  const res = { root, days, dryRun: !yes, removed: [], skipped: null, truncated: null };
  if (!existsSync(root)) return res;
  const realRoot = realpathSync(root);
  const marker = join(realRoot, '.state', 'prune.marker');
  const today = dayStr(now);
  if (onceDay) {
    try { if (readFileSync(marker, 'utf8').trim() === today) { res.skipped = 'da chay hom nay'; return res; } } catch {}
  }
  const cutoff = dayStr(new Date(now.getTime() - days * 86400000));
  // ung vien: v2 <root>/date=D, v1 <root>/type=T/date=D, digest <root>/digest/D.md
  const cands = [];
  const isDate = (n) => /^date=\d{4}-\d{2}-\d{2}$/.test(n);
  for (const t of readdirSync(realRoot, { withFileTypes: true })) {
    if (t.isDirectory() && isDate(t.name)) cands.push([join(realRoot, t.name), t.name.slice(5)]);
    else if (t.isDirectory() && t.name.startsWith('type=')) {
      for (const d of readdirSync(join(realRoot, t.name), { withFileTypes: true })) if (d.isDirectory() && isDate(d.name)) cands.push([join(realRoot, t.name, d.name), d.name.slice(5)]);
    } else if (t.isDirectory() && t.name === 'digest') {
      for (const d of readdirSync(join(realRoot, t.name), { withFileTypes: true })) { const m = d.isFile() && d.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/); if (m) cands.push([join(realRoot, t.name, d.name), m[1]]); }
    }
  }
  // data/runs/* (.log/.json): theo mtime (khong co ngay trong ten)
  try {
    if (existsSync(runsRoot)) {
      const rr = realpathSync(runsRoot);
      for (const d of readdirSync(rr, { withFileTypes: true })) {
        if (!d.isFile() || !/.(log|json)$/.test(d.name)) continue;
        const p = join(rr, d.name);
        let m; try { m = statSync(p).mtime; } catch { continue; }
        cands.push([p, dayStr(m)]);
      }
    }
  } catch {}
  for (const [p, date] of cands) {
    if (date >= cutoff) continue;
    if (Date.now() > deadline) { res.truncated = 'timeout'; break; }
    const rp = realpathSync(p);
    if (!rp.startsWith(realRoot + sep) && !(runsRoot && rp.startsWith(realpathSync(runsRoot) + sep))) continue; // symlink thoat root
    res.removed.push(p);
    if (yes) rmSync(rp, { recursive: true, force: true });
  }
  if (onceDay && yes && !res.truncated) { try { mkdirSync(dirname(marker), { recursive: true }); writeFileSync(marker, today); } catch {} }
  return res;
}

function main() {
  const a = process.argv.slice(2);
  const i = a.indexOf('--days');
  const days = i >= 0 ? parseInt(a[i + 1], 10) : undefined;
  if (i >= 0 && !(days >= 0)) { console.error('prune: --days khong hop le'); process.exit(1); }
  const ti = a.indexOf('--timeout');
  const sec = ti >= 0 ? Number(a[ti + 1]) : undefined;
  if (ti >= 0 && !(sec > 0)) { console.error('prune: --timeout (giay) khong hop le'); process.exit(1); }
  const r = prune({ days, ...(sec ? { timeoutMs: sec * 1000 } : {}), yes: a.includes('--yes') && !a.includes('--dry-run'), onceDay: a.includes('--once-per-day') });
  if (r.skipped) return console.log(`prune: bo qua (${r.skipped})`);
  console.log(`prune: root=${r.root} giu ${r.days} ngay ${r.dryRun ? '[DRY-RUN, them --yes de xoa that]' : ''}`);
  for (const p of r.removed) console.log((r.dryRun ? 'se xoa ' : 'da xoa ') + p);
  if (!r.removed.length) console.log('khong co gi de xoa');
  if (r.truncated) console.log(`truncated: ${r.truncated}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
