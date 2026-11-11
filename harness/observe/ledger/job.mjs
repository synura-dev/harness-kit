// Job lo (nen, toi da 1 lan/gio nho hook kick, timeout cung): doc audit -> candidate + finding -> cap nhat so. Hook CHI doc ket qua.
// Mot job lo duy nhat: candidates (error) + patterns + prune (sources.mjs) -> so; roi autopilot evolve (tu kiem han 24h) chay noi tiep. CLI: node job.mjs [--timeout-s N] [--dry-run].
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceRoot } from '../../core/io/paths.mjs';
import { bgDoneOnExit } from '../../core/runtime/proc.mjs';
import { defaultCandidateSources } from './sources.mjs';
import { auditRoot } from '../../core/audit/audit-write.mjs';
import { dataReadRoots } from '../../core/registry/data-registry.mjs';
import { collectJsonlFiles, readAuditEvents } from '../../core/audit/scan.mjs';
import { failureCandidates } from '../../core/audit/candidate-shape.mjs';
import { loadDefinitions, evaluateAll } from './engine.mjs';
import { loadLedgerConfig, applyLedgerConfig } from './config.mjs';
import { readLedger, updateLedger, applyFindings, ledgerFile, mergeState, recordJobError, JOB, jobDue } from './ledger.mjs';
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
  const { defs: rawDefs, errors, truncated: dt } = loadDefinitions({ projectDir: opts.projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? null, hubDir, ...(opts.trusted ? { trusted: opts.trusted } : {}), ...(opts.defaultsDir ? { defaultsDir: opts.defaultsDir } : {}) });
  const lcfg = opts.ledgerConfig || loadLedgerConfig();
  const cfgWarn = new Set(lcfg.warnings || []); // job chay nen stdio ignore -> luu vao state (cfgWarnings), khong console.error
  const defs = applyLedgerConfig(rawDefs, lcfg);
  const days = Math.max(1, ...defs.filter((d) => d.source !== 'ledger').map((d) => Number(d.days) || 7));
  const ev = opts.events ? { events: opts.events, truncated: null } : await readEvents({ days, nowMs, timeoutMs: opts.timeoutMs || JOB.timeoutS * 1000 });
  const nowIso = new Date(nowMs).toISOString();
  let candidates = failureCandidates(ev.events, nowIso);
  const ctx = { hubDir, nowMs, warn: (w) => cfgWarn.add(String(w)) };
  for (const src of opts.candidateSources || []) { try { candidates = candidates.concat(await src(ev.events, nowIso, { ...ctx, defs, dryRun: !!opts.dryRun })); } catch {} } // pattern (repeated-pattern) + prune (deprecate|cap)
  const file = ledgerFile(opts.dataOpts);
  const f1 = evaluateAll(defs, { events: ev.events, candidates }, ctx, ['audit', 'candidates']);
  // Phan nang (doc audit) da xong; chi doc-sua-ghi so duoi khoa de khong mat warn_ts/chu thich cua hook/autopilot ghi xen.
  let entries = []; let f2 = [];
  const merge = (cur) => {
    let es = applyFindings(cur, f1, nowMs).entries;
    f2 = evaluateAll(defs, { ledger: es }, ctx, ['ledger']); // luat tren so (vd canh bao bi bo qua)
    es = applyFindings(es, f2, nowMs, undefined, { partial: true }).entries;
    entries = es; return es;
  };
  const truncated = ev.truncated || dt || null;
  if (opts.dryRun) merge(readLedger(file));
  else if (!updateLedger(file, merge, { lock: { retries: 200, waitMs: 25 } }).ok) { recordJobError(opts.dataOpts, 'lock', 'khong khoa duoc so', nowMs); return { defs: defs.length, errors, events: ev.events.length, findings: f1.length, entries: 0, truncated: 'lock', ms: Date.now() - t0 }; }
  // Ghi state moi (xoa loi cu); chay xong nhung bi cat theo timeout -> van ghi lastRun + lastError=timeout (hien o observe/doctor).
  if (!opts.dryRun) { mergeState(opts.dataOpts, { lastRun: nowMs, ms: Date.now() - t0, findings: f1.length + f2.length, truncated, defs: defs.length, errors: errors.length, cfgWarnings: [...cfgWarn].map((w) => w.replace(/\s+/g, ' ').slice(0, 160)).slice(0, 5), lastError: undefined, lastErrorAt: undefined, errWarnedAt: undefined, ...(truncated === 'timeout' ? { lastError: 'timeout: doc audit bi cat, du lieu mot phan', lastErrorAt: nowMs } : {}) }); }
  return { defs: defs.length, errors, events: ev.events.length, findings: f1.length + f2.length, entries: entries.length, truncated, ms: Date.now() - t0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bgDoneOnExit();
  const a = process.argv.slice(2);
  const ti = a.indexOf('--timeout-s');
  const timeoutMs = ti >= 0 && Number(a[ti + 1]) > 0 ? Number(a[ti + 1]) * 1000 : JOB.timeoutS * 1000;
  const dry = a.includes('--dry-run');
  const die = (kind, msg, code) => { console.error('ledger-job:', msg); if (!dry) recordJobError(undefined, kind, msg); process.exit(code); };
  const hard = setTimeout(() => die('timeout', 'timeout cung', 3), timeoutMs + 5000);
  runJob({ timeoutMs, dryRun: a.includes('--dry-run'), candidateSources: defaultCandidateSources() }).then(async (r) => {
    console.log(JSON.stringify(r)); clearTimeout(hard);
    if (!a.includes('--dry-run')) { // autopilot: tu bo qua neu <24h; fail-open; tran cung rieng
      const h2 = setTimeout(() => die('autopilot', 'autopilot timeout', 3), 115000);
      try { const { runAutopilot } = await import('../../evolve/loop/autopilot.mjs'); await runAutopilot({}); } catch (e) { recordJobError(undefined, 'autopilot', e && e.message); }
      clearTimeout(h2);
      try { const { demoteRun } = await import('../../evolve/loop/demote.mjs'); demoteRun({}); } catch (e) { recordJobError(undefined, 'demote', e && e.message); } // ha cap rule vo ich; fail-open
    }
    process.exit(0);
  }, (e) => die('exit', e && e.message, 1));
}
