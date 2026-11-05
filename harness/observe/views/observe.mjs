#!/usr/bin/env node
// Domain `observe`: mot cong doc audit/du lieu (chi doc, tru prune/data-prune mac dinh dry-run).
// Lenh: view [YYYY-MM-DD] | why | map | query | digest | prune | runs | sizes | data-prune | cost | evidence
// Ten domain cu (audit, audit-query, runs, data) chay qua compat/*.mjs -> goi main() o day voi tien to lenh.
import path from 'node:path';
import { spawnSync } from '../../core/runtime/proc.mjs';
import { fileURLToPath } from 'node:url';
import { workspaceRoot, samePath } from '../../core/io/paths.mjs';
import { auditReadRoots } from '../../core/audit/audit-write.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Lenh chay bang tien trinh con (giu y nguyen co/timeout cua tung CLI).
const SPAWN = {
  query: path.join(HERE, 'query', 'query.mjs'),
  digest: path.join(HERE, 'digest.mjs'),
  prune: path.join(HERE, 'prune.mjs'),
  cost: path.join(HERE, '..', 'cost', 'cli.mjs'),
  evidence: path.join(HERE, '..', 'evidence', 'cli.mjs'),
  ledger: path.join(HERE, '..', 'ledger', 'cli.mjs'),
};
const COMMANDS = ['view', 'why', 'map', 'query', 'digest', 'prune', 'runs', 'sizes', 'data-prune', 'cost', 'evidence', 'ledger'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const USAGE = `usage: harness.mjs observe <${COMMANDS.join('|')}> [args]  (view [YYYY-MM-DD] mac dinh khi chi co ngay)`;

async function view(args) {
  const timeoutIdx = args.indexOf('--timeout');
  const timeoutMs = timeoutIdx >= 0 && Number(args[timeoutIdx + 1]) ? Number(args[timeoutIdx + 1]) * 1000 : 30000;
  const mbIdx = args.indexOf('--max-bytes');
  let maxBytes;
  if (mbIdx >= 0) {
    const v = Number(args[mbIdx + 1]);
    if (!Number.isFinite(v) || v <= 0) { console.error('--max-bytes phai la so duong'); return 2; }
    maxBytes = v;
  }
  try {
    const { runAuditReview } = await import('./review/review.mjs');
    const res = await runAuditReview(args.find((a) => DATE.test(a)), { timeoutMs, maxBytes });
    console.log(res.lines.join('\n'));
    return 0;
  } catch (err) {
    console.error('audit-review error:', err.message);
    return 1;
  }
}

/** argv = [lenh, ...tham so]. Tra ma thoat. */
export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === '--help') { console.log(USAGE); return cmd ? 0 : 2; }
  if (cmd === 'view') return view(rest);
  if (DATE.test(cmd)) return view(argv);
  if (cmd === 'why' || cmd === 'map') {
    const { runWhyMap } = await import('./review/why-map.mjs');
    console.log(runWhyMap(cmd, rest, auditReadRoots()));
    return 0;
  }
  if (cmd === 'runs') { const { run } = await import('./runs.mjs'); return run(rest).code; }
  if (cmd === 'sizes') { const { sizesMain } = await import('./sizes.mjs'); sizesMain(rest); return 0; }
  if (cmd === 'data-prune') { const { dataMain } = await import('./data.mjs'); return dataMain(['prune', ...rest]); }
  if (Object.hasOwn(SPAWN, cmd)) {
    const r = spawnSync(process.execPath, [SPAWN[cmd], ...rest], { stdio: 'inherit' });
    return r.status ?? 1;
  }
  console.error(`observe: lenh la: ${cmd}\n${USAGE}`);
  return 2;
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) main(process.argv.slice(2)).then((c) => process.exit(c));
