// harness/observe/views/sizes.mjs - `observe sizes`, doc-only: kich thuoc cac thu muc con cua <dir> (mac dinh data/ cua hub).
// Usage: node harness/cli/harness.mjs observe sizes [dir] [--timeout-s N=10] [--max-files N=50000]
// Qua han -> dung em, in `truncated: timeout|max_files`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceRoot, isInside, samePath } from '../../core/io/paths.mjs';

function dirSizes(root, { timeoutMs = 10000, maxFiles = 50000 } = {}) {
  const t0 = Date.now();
  let files = 0, truncated = null;
  const rows = [];
  const walk = (d) => {
    let total = 0;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return 0; }
    for (const e of ents) {
      if (truncated) break;
      if (Date.now() - t0 > timeoutMs) { truncated = 'timeout'; break; }
      if (files >= maxFiles) { truncated = 'max_files'; break; }
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) total += walk(p);
      else { files++; try { total += fs.statSync(p).size; } catch {} }
    }
    return total;
  };
  let top = [];
  try { top = fs.readdirSync(root, { withFileTypes: true }); } catch { return { rows, truncated, files }; }
  for (const e of top) {
    const p = path.join(root, e.name);
    if (e.isSymbolicLink()) continue;
    rows.push({ name: e.name, bytes: e.isDirectory() ? walk(p) : (() => { files++; try { return fs.statSync(p).size; } catch { return 0; } })() });
    if (truncated) break;
  }
  return { rows, truncated, files };
}

/** Tra ma thoat (0 ok, 2 loi tham so/ngoai hub); khong goi process.exit de caller giu ma. */
export function sizesMain(a) {
  const num = (f, d) => { const i = a.indexOf(f); return i >= 0 ? Number(a[i + 1]) || d : d; };
  const pos = a.filter((x, i) => !x.startsWith('-') && !(i > 0 && a[i - 1].startsWith('--')));
  const hub = workspaceRoot();
  const dir = path.resolve(hub, pos[0] || 'data');
  if (!isInside(dir, hub)) { console.error('observe sizes: thu muc nam ngoai hub'); return 2; }
  const r = dirSizes(dir, { timeoutMs: num('--timeout-s', 10) * 1000, maxFiles: num('--max-files', 50000) });
  r.rows.sort((x, y) => y.bytes - x.bytes);
  for (const x of r.rows) console.log(`${String(x.bytes).padStart(12)}  ${x.name}`);
  console.log(`total: ${r.rows.reduce((s, x) => s + x.bytes, 0)} bytes, ${r.files} files`);
  if (r.truncated) console.log(`truncated: ${r.truncated}`);
  return 0;
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) process.exit(sizesMain(process.argv.slice(2)));
