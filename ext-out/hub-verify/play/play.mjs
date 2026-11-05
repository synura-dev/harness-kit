// harness/tools/play/play.mjs - chay playbook khong can model.
// Usage: node harness/tools/play/play.mjs <name|path> [--param k=v ...] [--yes] [--dry-run] [--timeout-s N] [--max-output-bytes N]
// Exit: 0 PASS|PASS_WITH_WARNINGS, 1 FAIL, 2 usage/validation, 3 ESCALATE (can model phan xu), 4 TIMEOUT, 6 DRYRUN (khong phai thanh cong).
// Don dep: node harness/tools/play/play.mjs --prune [--days N] [--yes]  (mac dinh dry-run).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceRoot } from '../../core/io/paths.mjs';
import { loadPlaybook, PlaybookError } from './playbook/schema.mjs';
import { runPlaybook, formatResult, prunePlayRuns } from './playbook/run.mjs';
import { samePath } from '../../core/io/paths.mjs';

const USAGE = 'Usage: node harness/tools/play/play.mjs <playbook-name|path> [--param k=v ...] [--yes] [--dry-run] [--timeout-s N<=1800] [--max-output-bytes N<=5000000]\n       node harness/tools/play/play.mjs --prune [--days N] [--yes]';

export const MAX_TIMEOUT_S = 1800;
const MAX_OUT_BYTES = 5000000;

export function parsePlayArgs(argv) {
  const o = { params: {}, yes: false, dryRun: false, prune: false };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new PlaybookError(`${a} thieu gia tri`); return argv[++i]; };
    if (a === '--yes') o.yes = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--prune') o.prune = true;
    else if (a === '--days') {
      const n = Number(val());
      if (!Number.isInteger(n) || n < 1 || n > 3650) throw new PlaybookError('--days phai la so nguyen 1..3650');
      o.days = n;
    }
    else if (a === '--param' || a === '-p') {
      const kv = val(); const eq = kv.indexOf('=');
      if (eq < 1) throw new PlaybookError(`--param can dang k=v: ${kv.slice(0, 30)}`);
      o.params[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === '--timeout-s' || a === '--max-output-bytes') {
      const n = Number(val());
      if (!Number.isInteger(n) || n < 1) throw new PlaybookError(`${a} phai la so nguyen duong`);
      if (a === '--timeout-s') { if (n > MAX_TIMEOUT_S) throw new PlaybookError(`--timeout-s toi da ${MAX_TIMEOUT_S}`); o.timeoutS = n; }
      else { if (n > MAX_OUT_BYTES) throw new PlaybookError(`--max-output-bytes toi da ${MAX_OUT_BYTES}`); o.maxOutputBytes = n; }
    } else if (a.startsWith('-')) throw new PlaybookError(`co la: ${a}`);
    else pos.push(a);
  }
  if (o.prune) { if (pos.length) throw new PlaybookError('--prune khong nhan playbook'); return o; }
  if (pos.length === 1 && pos[0] === 'list') { o.list = true; return o; }
  if (pos.length !== 1) throw new PlaybookError('can dung 1 ten/duong dan playbook');
  o.target = pos[0];
  return o;
}

const LIST_LIMITS = { maxFiles: 200, maxFileBytes: 262144, timeoutMs: 3000 };

// Liet ke playbook trong .agents/playbooks/*.json: [{name, description, params, steps}] + truncated ('max_files'|'timeout'|null).
export function listPlaybooks({ hub = workspaceRoot(), limits = {} } = {}) {
  const L = { ...LIST_LIMITS, ...limits };
  const t0 = Date.now();
  const dir = path.join(hub, '.agents', 'playbooks');
  const out = { playbooks: [], truncated: null };
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return out; }
  for (const n of names) {
    if (out.playbooks.length >= L.maxFiles) { out.truncated = 'max_files'; break; }
    if (Date.now() - t0 > L.timeoutMs) { out.truncated = 'timeout'; break; }
    const f = path.join(dir, n);
    try {
      if (fs.statSync(f).size > L.maxFileBytes) { out.playbooks.push({ name: n.replace(/\.json$/, ''), error: 'qua lon' }); continue; }
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      out.playbooks.push({ name: j.name || n.replace(/\.json$/, ''), description: String(j.description || '').slice(0, 160), params: Object.keys(j.params || {}), steps: Array.isArray(j.steps) ? j.steps.length : 0 });
    } catch { out.playbooks.push({ name: n.replace(/\.json$/, ''), error: 'json hong' }); }
  }
  return out;
}

async function main() {
  let out;
  try {
    const o = parsePlayArgs(process.argv.slice(2));
    if (o.list) {
      const r = listPlaybooks();
      for (const p of r.playbooks) console.log(p.error ? `${p.name}: [${p.error}]` : `${p.name} (${p.steps} buoc; params: ${p.params.join(',') || '-'}) - ${p.description}`);
      if (r.truncated) console.log(`truncated: ${r.truncated}`);
      process.exit(0);
    }
    if (o.prune) { console.log(JSON.stringify(prunePlayRuns({ days: o.days, yes: o.yes }))); process.exit(0); }
    const pb = loadPlaybook(o.target);
    out = await runPlaybook(pb, o);
  } catch (e) {
    if (e instanceof PlaybookError) {
      console.error(`play: ${e.message}`);
      for (const x of e.errors.slice(0, 20)) if (x !== e.message) console.error(`  - ${x}`);
      console.error(USAGE);
      process.exit(2);
    }
    console.error(`play: loi noi bo: ${e.message}`);
    process.exit(1);
  }
  console.log(formatResult(out.result));
  process.exit(out.exitCode);
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) main();
