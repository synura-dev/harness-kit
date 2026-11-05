// node dev/checks/run.mjs [--strict] - check phat trien: ref, import, clutter, manifest, proc-direct, stray. Khong nap luc chay.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScanInput, collectStray } from './scan-input.mjs';
import { checkRefs } from './ref-check.mjs';
import { scanTree } from './import-check.mjs';
import { checkClutter, checkStray } from './clutter-check.mjs';
import { checkManifest, checkRegistry } from './manifest-check.mjs';
import { scanProcDirect } from './proc-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = [];
const si = buildScanInput(root);
for (const e of checkRefs({ files: si.files, exists: si.exists }).errors) out.push(`ref ${e.file}:${e.line} -> ${e.ref}`);
const imp = scanTree(root);
for (const v of imp.violations) out.push(`import ${v.file}:${v.line} ${v.from} -> ${v.to}`);
for (const m of imp.missing) out.push(`import ${m.file}:${m.line} thieu ${m.spec}`);
for (const f of checkClutter(si.files, si.registry).findings) out.push(`clutter [${f.severity}] ${f.rule} ${f.path}`);
for (const s of checkStray(collectStray(root).entries)) out.push(`stray ${s.path}`);
for (const m of [...checkManifest(root), ...checkRegistry(root)]) out.push(`manifest ${m}`);
for (const v of scanProcDirect(root)) out.push(`proc-direct ${v.file}:${v.line}`);
out.slice(0, 50).forEach((l) => console.log('[warn]', l));
console.log(`[checks] findings=${out.length}`);
if (process.argv.includes('--strict') && out.length) process.exitCode = 1;
