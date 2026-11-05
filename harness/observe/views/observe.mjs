#!/usr/bin/env node
// Domain `observe`: mot cong doc audit/du lieu (chi doc, tru prune/data-prune mac dinh dry-run).
// Lenh: sizes | data-prune | ledger | report
// Ten domain cu (audit, audit-query, runs, data) chay qua compat/*.mjs -> goi main() o day voi tien to lenh.
import path from 'node:path';
import { spawnSync } from '../../core/runtime/proc.mjs';
import { fileURLToPath } from 'node:url';
import { samePath } from '../../core/io/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Lenh chay bang tien trinh con (giu y nguyen co/timeout cua tung CLI).
const SPAWN = {
  ledger: path.join(HERE, '..', 'ledger', 'cli.mjs'),
  report: path.join(HERE, '..', 'report', 'cli.mjs'),
};
const COMMANDS = ['sizes', 'data-prune', 'ledger', 'report'];
const USAGE = `usage: harness.mjs observe <${COMMANDS.join('|')}> [args]`;

/** argv = [lenh, ...tham so]. Tra ma thoat. */
export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === '--help') { console.log(USAGE); return cmd ? 0 : 2; }
  if (cmd === 'sizes') { const { sizesMain } = await import('./sizes.mjs'); return sizesMain(rest); }
  if (cmd === 'data-prune') { const { dataMain } = await import('./data.mjs'); return dataMain(['prune', ...rest]); }
  if (Object.hasOwn(SPAWN, cmd)) {
    const r = spawnSync(process.execPath, [SPAWN[cmd], ...rest], { stdio: 'inherit' });
    return r.status ?? 1;
  }
  console.error(`observe: lenh la: ${cmd}\n${USAGE}`);
  return 2;
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) main(process.argv.slice(2)).then((c) => process.exit(c));
