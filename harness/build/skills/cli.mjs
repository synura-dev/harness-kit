// node harness/build/skills/cli.mjs <build|check|prune> [--apply] [--force] [--adopt] [--src D] [--target D]... [--root D]
//   [--json] [--raw] [--max-bytes N] [--timeout-s N]
// build/prune mac dinh dry-run (--apply moi ghi/xoa). check exit 1 khi lech. Skill khong marker khong bao gio bi dung.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommon, emit } from '../../core/io/out.mjs';
import { workspaceRoot, samePath } from '../../core/io/paths.mjs';
import { build, check, prune } from './skills.mjs';

const USAGE = 'skills <build|check|prune> [--apply] [--force] [--adopt] [--src D] [--target D]... [--root D] [--json] [--timeout-s N] [--max-bytes N]';

export function parseArgs(argv) {
  const c = parseCommon(argv);
  const o = { cmd: null, apply: false, force: false, adopt: false, src: null, targets: [], root: null, err: null, common: c };
  const r = c.rest;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const val = () => { const v = r[++i]; if (!v || v.startsWith('--')) o.err = `${a} thieu gia tri`; return v; };
    if (a === '--apply') o.apply = true;
    else if (a === '--force') o.force = true;
    else if (a === '--adopt') o.adopt = true;
    else if (a === '--src') o.src = val();
    else if (a === '--target') o.targets.push(val());
    else if (a === '--root') o.root = val();
    else if (!o.cmd && !a.startsWith('--')) o.cmd = a;
    else o.err = o.err || `tham so la: ${a}`;
  }
  return o;
}

export function main(argv, io = {}) {
  const o = parseArgs(argv);
  const c = o.common;
  const out = { json: c.json, raw: c.raw, maxBytes: c.maxBytes, ...io };
  if (o.err || !['build', 'check', 'prune'].includes(o.cmd)) { emit({ summary: (o.err ? o.err + '\n' : '') + USAGE }, out); return 2; }
  const root = path.resolve(o.root || workspaceRoot());
  const base = { root, src: o.src, targets: o.targets, timeoutS: c.timeoutS };
  if (o.cmd === 'build') {
    const r = build({ ...base, apply: o.apply, force: o.force, adopt: o.adopt });
    const lines = [`skills build${r.apply ? '' : ' (dry-run, them --apply de ghi)'}: ${r.items.length} muc, ${r.problems.length} loi`];
    for (const it of r.items) lines.push(`  ${it.action}${it.action !== 'skip' && !r.apply ? ' (se)' : ''}: ${it.target}`);
    for (const p of r.problems) lines.push(`  LOI: ${p}`);
    emit({ summary: lines.join('\n'), data: r, truncated: r.truncated }, out);
    return r.problems.length || r.truncated ? 1 : 0;
  }
  if (o.cmd === 'check') {
    const r = check(base);
    const lines = [`skills check: ${r.ok ? 'OK' : r.issues.length + ' lech'} (${r.checked} cap nguon-dich)`];
    for (const it of r.issues) lines.push(`  ${it.issue}: ${it.target || it.skill}${it.detail ? ' - ' + it.detail : ''}`);
    emit({ summary: lines.join('\n'), data: r, truncated: r.truncated }, out);
    return r.ok ? 0 : 1;
  }
  const r = prune({ ...base, apply: o.apply, force: o.force });
  const lines = [`skills prune${r.apply ? '' : ' (dry-run, them --apply de xoa)'}: ${r.items.length} thu muc mo coi co marker`];
  for (const it of r.items) lines.push(`  ${it.removed ? 'da xoa' : it.skipped ? 'bo qua (' + it.skipped + ')' : 'se xoa'}: ${it.target}`);
  for (const p of r.problems) lines.push(`  CANH BAO: ${p}`);
  emit({ summary: lines.join('\n'), data: r, truncated: r.truncated }, out);
  return r.truncated ? 1 : 0;
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
