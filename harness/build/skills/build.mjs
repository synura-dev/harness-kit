#!/usr/bin/env node
// Domain `build`: cong don cho viec cai/bao tri chinh harness. Lenh: skills | install | doctor | adapters.
// Ten domain cu (skills, install, doctor, adapters) la alias trong manifest -> goi domain nay voi tien to lenh.
// Moi lenh chay bang tien trinh con (giu nguyen co/timeout cua tung CLI).
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { samePath } from '../../core/io/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUB = {
  skills: path.join(HERE, 'cli.mjs'),
  install: path.join(HERE, '..', 'install', 'cli.mjs'),
  doctor: path.join(HERE, '..', '..', 'cli', 'commands', 'doctor.mjs'),
  adapters: path.join(HERE, '..', '..', 'tools', 'adapters', 'report.mjs'),
};
const USAGE = `usage: harness.mjs build <${Object.keys(SUB).join('|')}> [args]  (skills build|check|prune | install [--dry-run] | doctor [--adapters] | adapters [--write-readme|--write-arch])`;
// < tran cong (harness.mjs: 120s + 5s): con tu dung va bao `truncated: timeout` truoc khi cong kill.
export const LIMITS = { spawnTimeoutMs: 110000 };

/** argv = [lenh, ...tham so]. Tra ma thoat. */
export function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === '--help') { console.log(USAGE); return cmd ? 0 : 2; }
  if (!Object.hasOwn(SUB, cmd)) { console.error(`build: lenh la: ${cmd}\n${USAGE}`); return 2; }
  const r = spawnSync(process.execPath, [SUB[cmd], ...rest], { stdio: 'inherit', timeout: LIMITS.spawnTimeoutMs });
  if (r.error) { console.error(r.error.code === 'ETIMEDOUT' ? 'truncated: timeout' : String(r.error.message)); return 2; }
  return r.status ?? 1;
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
