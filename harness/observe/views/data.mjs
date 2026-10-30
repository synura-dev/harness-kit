// harness/observe/views/data.mjs - retention du lieu: `data prune [--yes] [--dir D] [--timeout-s N]` | `data sizes [dir] [--timeout-s N] [--max-files N]` (doc-only, xem sizes.mjs).
// Mac dinh dry-run (chi bao); --yes moi xoa. Retention: events 30 ngay, digests 90, runs 14, baselines giu 10 ban moi nhat (contract.mjs).
// root bat buoc = workspaceRoot() (hoac cha cua data dir neu HUB_DATA_DIR ngoai hub); qua han -> dung em, in `truncated: timeout`.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sizesMain } from './sizes.mjs';
import { pruneDir } from '../../core/io/jsonl-store.mjs';
import { workspaceRoot, dataRoot, isInside, samePath } from '../../core/io/paths.mjs';

const MAX_TIMEOUT_S = 120;
const USAGE = 'Usage: node harness/cli/harness.mjs data prune [--yes] [--dir <thu-muc-trong-hub>] [--timeout-s N<=120]  (mac dinh dry-run)';

export function parseDataArgs(argv) {
  const o = { cmd: null, yes: false, timeoutS: 30, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') o.yes = true;
    else if (a === '--dry-run') o.yes = false;
    else if (a === '--dir') { if (i + 1 >= argv.length) throw new Error('--dir thieu gia tri'); o.dir = argv[++i]; }
    else if (a === '--timeout-s') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > MAX_TIMEOUT_S) throw new Error(`--timeout-s phai la so nguyen 1..${MAX_TIMEOUT_S}`);
      o.timeoutS = n;
    } else if (a.startsWith('-')) throw new Error(`co la: ${a}`);
    else if (!o.cmd) o.cmd = a;
    else throw new Error(`thua tham so: ${a}`);
  }
  if (o.cmd !== 'prune') throw new Error('can lenh: prune');
  return o;
}

// root bat buoc: hub, tru khi dir nam ngoai hub (HUB_DATA_DIR) thi root = chinh dir.
export function runPrune({ dir, yes = false, timeoutS = 30, hub = workspaceRoot(), now } = {}) {
  const target = path.resolve(dir || dataRoot());
  const root = isInside(target, hub) ? hub : (dir ? null : target);
  if (!root) throw new Error(`--dir phai nam trong hub: ${dir}`);
  if (samePath(target, path.parse(target).root)) throw new Error('khong prune goc o dia');
  const r = pruneDir(target, { root, dryRun: !yes, timeoutMs: timeoutS * 1000, now });
  return { ...r, dryRun: !yes, dir: target };
}

export function dataMain(argv) {
  if (argv[0] === 'sizes') { sizesMain(argv.slice(1)); return 0; }
  let r;
  try { r = runPrune(parseDataArgs(argv)); } catch (e) { console.error(`data: ${e.message}\n${USAGE}`); return 2; }
  console.log(`${r.dryRun ? '[dry-run] ' : ''}data prune ${r.dir}: kept=${r.kept} removed=${r.removed}${r.dryRun ? ' (them --yes de xoa that)' : ''}`);
  for (const f of r.files.slice(0, 50)) console.log(`  - ${f}`);
  if (r.files.length > 50) console.log(`  ... con ${r.files.length - 50} muc`);
  if (r.truncated) console.log(`truncated: ${r.truncated}`);
  return 0;
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) process.exit(dataMain(process.argv.slice(2)));
