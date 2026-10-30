// node harness/build/install/cli.mjs [--dry-run] [--skip-doctor] [--root D] [--json] [--timeout-s N] [--max-bytes N]
// harness install: kiem Node/bun -> build skill (--adopt) -> check -> doctor rut gon -> huong dan dang ky hook. Idempotent. Khong sua settings.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommon, emit } from '../../core/io/out.mjs';
import { workspaceRoot, samePath } from '../../core/io/paths.mjs';
import { install } from './install.mjs';

const USAGE = 'install [--dry-run] [--skip-doctor] [--root D] [--json] [--timeout-s N] [--max-bytes N]';

export function main(argv, io = {}, deps = {}) {
  const c = parseCommon(argv);
  const out = { json: c.json, raw: c.raw, maxBytes: c.maxBytes, ...io };
  let dry = false; let skipDoctor = false; let root = null; let err = null;
  const r = c.rest;
  for (let i = 0; i < r.length; i++) {
    if (r[i] === '--dry-run') dry = true;
    else if (r[i] === '--skip-doctor') skipDoctor = true;
    else if (r[i] === '--root') { root = r[++i]; if (!root || root.startsWith('--')) err = '--root thieu gia tri'; }
    else if (r[i] !== 'run') err = err || `tham so la: ${r[i]}`;
  }
  if (err) { emit({ summary: err + '\n' + USAGE }, out); return 2; }
  const res = install({ root: path.resolve(root || workspaceRoot()), apply: !dry, skipDoctor, timeoutS: c.timeoutS || 60, ...deps });
  const lines = [`harness install${res.apply ? '' : ' (dry-run, bo --dry-run de ghi)'}: ${res.ok ? 'OK' : 'CO LOI'}`];
  for (const s of res.steps) { lines.push(`[${s.ok === true ? 'OK' : s.ok === false ? 'LOI' : '--'}] ${s.step}`); for (const l of s.lines) lines.push('  ' + l); }
  emit({ summary: lines.join('\n'), data: res }, out);
  return res.ok ? 0 : 1;
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
