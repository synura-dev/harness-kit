#!/usr/bin/env node
// Doc audit log (hive-partition JSONL) khong can doc file tho. Xem QUERY.md.
// Diem vao mong; logic o query/ (files, rows, engine, duck, format, args).
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditReadRoots } from '../../../core/audit/audit-write.mjs';
import { loadAuditConfig, auditRoot } from '../../../core/config/audit-config.mjs';
import { listFiles } from './files.mjs';
import { toRow, rowMatches, nodeRows } from './rows.mjs';
import { runCheckpoint, runSpec } from './engine.mjs';
import { baseSql, duckdbAvailable, duckRun } from './duck.mjs';
import { formatTable, formatMd, formatJsonl } from './format.mjs';
import { parseQueryArgs } from './args.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export { auditRoot, listFiles, toRow, rowMatches, nodeRows, duckdbAvailable, formatTable, formatMd, formatJsonl };
const loadReports = () => JSON.parse(readFileSync(join(HERE, 'reports.json'), 'utf8')).reports;

// ---- API chinh ----
export async function runReport(name, filters = {}, opts = {}) {
  const root = opts.root || auditRoot();
  const rep = loadReports().find((r) => r.name === name);
  if (!rep) throw new Error(`Khong co report '${name}'. Co: ${loadReports().map((r) => r.name).join(', ')}`);
  for (const k of rep.requires || []) if (!filters[k]) throw new Error(`report '${name}' can --${k}`);
  const L = loadAuditConfig().config.limits || {};
  const pick = (a, b, d) => (Number.isFinite(a) && a > 0 ? a : Number.isFinite(b) && b > 0 ? b : d);
  const lim = {
    deadline: Date.now() + pick(opts.timeoutMs, L.query_timeout_ms, 30000),
    maxBytes: pick(opts.maxBytes, L.query_max_bytes, 209715200),
    maxRows: pick(opts.maxRows, L.query_max_rows, 100000),
    truncated: null,
  };
  const want = opts.backend || 'auto';
  const files = (opts.root ? [root] : auditReadRoots()).flatMap((r) => listFiles(r, filters)).sort((a, b) => (a.path < b.path ? -1 : 1));
  let kind = null;
  if (want !== 'node') {
    kind = duckdbAvailable();
    if (!kind && want === 'duckdb') throw new Error('Khong tim thay duckdb (CLI hoac @duckdb/node-api)');
  }
  let backend = 'node';
  if (kind && files.length > 0) {
    try { await duckRun(kind, 'SELECT 1', { deadline: Date.now() + 10000, maxBytes: 1 << 20, truncated: null }); backend = 'duckdb-' + kind; } catch (e) { if (want === 'duckdb') throw e; kind = null; }
  }
  let queryFiles = files;
  if (name === 'checkpoint' && !filters.session && !filters.date && !filters.since && !filters.until) {
    const dates = [...new Set(files.map((f) => f.date))].filter(Boolean).sort();
    if (dates.length > 0) {
      const latestDate = dates[dates.length - 1];
      queryFiles = files.filter((f) => f.date === latestDate);
    }
  }
  const rows = backend === 'node' ? await nodeRows(queryFiles, filters, lim) : null;
  if (name === 'checkpoint' && backend === 'node') {
    return runCheckpoint(rows, queryFiles, filters, lim, backend);
  }
  const sections = [];
  for (const s of rep.sections) {
    if (lim.truncated === 'timeout' || Date.now() > lim.deadline) { lim.truncated = lim.truncated || 'timeout'; break; }
    let out;
    if (backend === 'node') out = runSpec(rows, s.node);
    else out = await duckRun(kind, `WITH ${baseSql(files, filters)} ${s.sql}`, lim);
    const rl = filters.limit ?? (name === 'events' ? 50 : null);
    if (rl) out = out.slice(0, rl);
    if (out.length > lim.maxRows) { out = out.slice(0, lim.maxRows); lim.truncated = lim.truncated || 'max_rows'; }
    sections.push({ title: s.title, rows: out });
  }
  return { report: name, backend, files: files.length, truncated: lim.truncated, sections };
}

async function main() {
  try {
    const a = parseQueryArgs(process.argv.slice(2));
    const opts = { backend: a.backend, timeoutMs: a.timeoutMs, maxBytes: a.maxBytes, maxRows: a.maxRows };
    if (a.digest) {
      const { writeDigest } = await import('../digest.mjs');
      const r = await writeDigest(a.digest, { ...opts, project: a.project });
      console.log(`digest: ${r.file} (sessions=${r.rows}, files=${r.files})` + (r.truncated ? `\ntruncated: ${r.truncated}` : ''));
      return;
    }
    const res = await runReport(a.report || 'events', a, opts);
    if (a.format === 'json') console.log(JSON.stringify(res, null, 2));
    else if (a.format === 'jsonl') console.log(formatJsonl(res));
    else if (a.format === 'md') console.log(formatMd(res));
    else console.log(formatTable(res) + `\n[backend=${res.backend}, files=${res.files}]`);
  } catch (e) { console.error('query: ' + e.message); process.exit(1); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
