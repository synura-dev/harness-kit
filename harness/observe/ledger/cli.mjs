#!/usr/bin/env node
// harness observe ledger [--status open|warned|acted|ignored|resolved] [--action warn|report|..] [--limit N] [--json] [--raw]
// Chi doc so su co (data/system/ledger/ledger.jsonl) + trang thai job lo.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommon, emit, posInt, capLines } from '../../core/io/out.mjs';
import { readLedger, ledgerFile, readState, jobHealth, updateLedger, STATUSES } from './ledger.mjs';

const USAGE = 'ledger close --kind <rule> [--match <s>] [--yes] | ledger [--status open|warned|acted|ignored|resolved] [--action A] [--limit N] [--json] [--raw]';

export function parseArgs(argv) {
  const c = parseCommon(argv);
  const o = { json: c.json, raw: c.raw, maxBytes: c.maxBytes, limit: 30 };
  const r = c.rest;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const [k, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const val = () => (inline !== null ? inline : r[++i]);
    if (k === '--status') { o.status = val(); if (!STATUSES.includes(o.status)) throw new Error(`status phai thuoc ${STATUSES.join('|')}`); }
    else if (k === '--action') o.action = val();
    else if (k === '--limit') o.limit = posInt(val()) || 30;
    else if (k !== 'ledger' && k !== 'list') throw new Error(`tham so la: ${a}`);
  }
  return o;
}

export function render(o, file = ledgerFile(), state = readState()) {
  const all = readLedger(file);
  const rows = all.filter((e) => (!o.status || e.status === o.status) && (!o.action || e.action === o.action))
    .sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)));
  const items = rows.slice(0, o.limit);
  const counts = {}; for (const e of all) counts[e.status] = (counts[e.status] || 0) + 1;
  const lastRun = state.lastRun ? new Date(state.lastRun).toISOString() : '-';
  const lines = [`ledger: ${items.length}/${rows.length} (tong ${all.length}; ${STATUSES.filter((s) => counts[s]).map((s) => `${s}=${counts[s]}`).join(' ') || 'rong'}) job=${lastRun}${state.truncated ? ' truncated: ' + state.truncated : ''}`,
    ...(jobHealth(state) ? [`[warn] job loi: ${jobHealth(state).error} (${new Date(jobHealth(state).at).toISOString()})`] : []),
    ...items.map((e) => `${String(e.last_seen).slice(0, 16)}  ${e.status.padEnd(8)} ${e.rule}  warn=${e.warn_count || 0}  ${String(e.message || e.fp).slice(0, 90)}`)];
  return { summary: capLines(lines, 40).join('\n'), data: { items, total: rows.length, counts, state }, truncated: rows.length > items.length ? 'limit' : state.truncated || null, raw: JSON.stringify(items, null, 2) };
}

/** Muc chua resolved khop rule=kind va (neu co) sample/message chua match. */
export function closable(entries, { kind, match }) {
  const m = match ? String(match).toLowerCase() : null;
  return entries.filter((e) => e.status !== 'resolved' && e.rule === kind && (!m || `${e.sample || ''} ${e.message || ''}`.toLowerCase().includes(m)));
}

/** ledger close --kind K [--match S] [--yes]: mac dinh dry-run, in so muc se dong; --yes dat status=resolved. */
export function closeMain(argv, file = ledgerFile()) {
  const o = { kind: null, match: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kind') o.kind = argv[++i]; else if (a === '--match') o.match = argv[++i]; else if (a === '--yes') o.yes = true;
    else throw new Error(`tham so la: ${a}`);
  }
  if (!o.kind) throw new Error('thieu --kind <rule>');
  const hit = new Set(closable(readLedger(file), o).map((e) => e.id));
  if (o.yes && hit.size) updateLedger(file, (all) => all.map((e) => (hit.has(e.id) ? { ...e, status: 'resolved', due: false } : e)));
  console.log(`${o.yes ? 'da dong' : 'dry-run: se dong'} ${hit.size} muc (rule=${o.kind}${o.match ? ' match=' + o.match : ''})${o.yes ? '' : ' - them --yes de dong'}`);
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'close') { try { return closeMain(argv.slice(1)); } catch (e) { console.error('ledger: ' + e.message + '\n' + USAGE); return 2; } }
  try { emit(render(parseArgs(argv)), { json: parseArgs(argv).json, raw: parseArgs(argv).raw, maxBytes: parseArgs(argv).maxBytes }); return 0; }
  catch (e) { console.error('ledger: ' + e.message + '\n' + USAGE); return 2; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
