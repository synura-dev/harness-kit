// Job lo (nen, toi da 1 lan/gio nho hook kick, timeout cung): doc audit -> candidate + finding -> cap nhat so. Hook CHI doc ket qua.
// CLI: node job.mjs [--timeout-s N] [--dry-run].
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceRoot } from '../../core/io/paths.mjs';
import { bgDoneOnExit } from '../../core/runtime/proc.mjs';
import { auditRoot } from '../../core/audit/audit-write.mjs';
import { dataReadRoots } from '../../core/registry/data-registry.mjs';
import { collectJsonlFiles, readAuditEvents } from '../../core/audit/scan.mjs';
import { failureCandidates } from '../../core/audit/candidate-shape.mjs';
import { loadDefinitions, evaluateAll } from './engine.mjs';
import { readLedger, writeLedger, applyFindings, ledgerFile, writeState, JOB, jobDue } from './ledger.mjs';
export { JOB, jobDue };

const DAY = 86400000;

function dateDirs(root) {
  const ls = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };
  const out = [];
  for (const a of ls(root)) {
    if (a.startsWith('date=')) out.push({ date: a.slice(5), dir: path.join(root, a) });
    else if (a.startsWith('type=')) for (const d of ls(path.join(root, a))) if (d.startsWith('date=')) out.push({ date: d.slice(5), dir: path.join(root, a, d) });
  }
  return out.sort((x, y) => y.date.localeCompare(x.date));
}

/** Doc su kien audit trong `days` ngay, co tran timeout/byte. Tra {events, truncated}. */
export async function readEvents({ days = 7, nowMs = Date.now(), timeoutMs = JOB.timeoutS * 1000, maxBytes = JOB.scanMaxBytes, roots } = {}) {
  const deadline = Date.now() + timeoutMs;
  const rs = roots || (dataReadRoots('audit').length ? dataReadRoots('audit') : [auditRoot()]);
  const fromDate = new Date(nowMs - days * DAY).toISOString().slice(0, 10);
  const events = []; let used = 0; let truncated = null;
  for (const { date, dir } of rs.flatMap(dateDirs)) {
    if (date < fromDate) continue;
    if (Date.now() > deadline) { truncated = 'timeout'; break; }
    let size = 0; for (const f of collectJsonlFiles(dir)) { try { size += fs.statSync(f).size; } catch {} }
    if (used + size > maxBytes) { truncated = 'max_bytes'; break; }
    used += size;
    const r = await readAuditEvents(dir, size + 1, deadline);
    events.push(...r.events);
    if (r.truncated) { truncated = r.truncated; break; }
  }
  return { events, truncated };
}

/** Chay engine + cap nhat so. opts: {projectDir, hubDir, nowMs, timeoutMs, dryRun, dataOpts, events, candidateSources[]}. */
export async function runJob(opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const hubDir = opts.hubDir || workspaceRoot();
  const t0 = Date.now();
  const { defs, errors, truncated: dt } = loadDefinitions({ projectDir: opts.projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? null, ...(opts.defaultsDir ? { defaultsDir: opts.defaultsDir } : {}) });
  const days = Math.max(1, ...defs.filter((d) => d.source !== 'ledger').map((d) => Number(d.days) || 7));
  const ev = opts.events ? { events: opts.events, truncated: null } : await readEvents({ days, nowMs, timeoutMs: opts.timeoutMs || JOB.timeoutS * 1000 });
  const nowIso = new Date(nowMs).toISOString();
  let candidates = failureCandidates(ev.events, nowIso);
  for (const src of opts.candidateSources || []) { try { candidates = candidates.concat(await src(ev.events, nowIso)); } catch {} } // vd nguon quy trinh lap kind='pattern'
  const ctx = { hubDir, nowMs };
  const file = ledgerFile(opts.dataOpts);
  let entries = readLedger(file);
  const f1 = evaluateAll(defs, { events: ev.events, candidates }, ctx, ['audit', 'candidates']);
  entries = applyFindings(entries, f1, nowMs).entries;
  const f2 = evaluateAll(defs, { ledger: entries }, ctx, ['ledger']); // luat tren so (vd canh bao bi bo qua)
  entries = applyFindings(entries, f2, nowMs, undefined, { partial: true }).entries;
  const truncated = ev.truncated || dt || null;
  if (!opts.dryRun) { writeLedger(file, entries); writeState(opts.dataOpts, { lastRun: nowMs, ms: Date.now() - t0, findings: f1.length + f2.length, truncated, defs: defs.length, errors: errors.length }); }
  return { defs: defs.length, errors, events: ev.events.length, findings: f1.length + f2.length, entries: entries.length, truncated, ms: Date.now() - t0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bgDoneOnExit();
  const a = process.argv.slice(2);
  const ti = a.indexOf('--timeout-s');
  const timeoutMs = ti >= 0 && Number(a[ti + 1]) > 0 ? Number(a[ti + 1]) * 1000 : JOB.timeoutS * 1000;
  const hard = setTimeout(() => { console.error('ledger-job: timeout cung'); process.exit(3); }, timeoutMs + 5000);
  runJob({ timeoutMs, dryRun: a.includes('--dry-run') }).then((r) => { console.log(JSON.stringify(r)); clearTimeout(hard); process.exit(0); }, (e) => { console.error('ledger-job:', e.message); process.exit(1); });
}
