// Chay bao cao: doc audit/so, danh gia muc, baseline, xuat. Tat ca doc co timeout/limit; het han -> truncated: timeout.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawnBackground } from '../../core/runtime/proc.mjs';
import { fileURLToPath } from 'node:url';
import { REPO_DIR, workspaceRoot } from '../../core/io/paths.mjs';
import { guardWrite } from '../../core/io/storage.mjs';
import { failureCandidates } from '../../core/audit/candidate-shape.mjs';
import { detectPatterns } from '../../evolve/loop/patterns.mjs';
import { readEvents } from '../ledger/job.mjs';
import { registeredExtRoots } from '../ledger/sources.mjs';
import { readLedger, ledgerFile, ledgerDir } from '../ledger/ledger.mjs';
import { loadSections, evaluateSection, renderReport, kpiSnapshot } from './engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPORT = Object.freeze({ timeoutS: 25, minIntervalDays: 7, lockMinutes: 10, obsidianMaxChars: 24000, obsidianFolder: '10 Projects/harness-kit/Reports', keepFiles: 12 });
export const NO_SOURCE = 'khong co nguon';
export const baselineFile = (o) => path.join(ledgerDir(o), 'report-baseline.json');
export const stateFile = (o) => path.join(ledgerDir(o), 'report-state.json');
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function writeJ(f, obj) {
  if (!guardWrite(f).ok) return false;
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj) + '\n', 'utf8'); return true; } catch { return false; }
}
/** Inventory thanh phan (command/hook/skill/agent/rule) tu prune de kpi-size co so. Loi -> undefined (muc bo qua). */
export async function loadInventory(hubDir) {
  try {
    const p = await import('../../evolve/loop/prune.mjs');
    const projectDir = hubDir || '';
    const inv = { command: p.inventoryCommands({ extRoots: registeredExtRoots(hubDir) }), hook: await p.inventoryHooks({}), skill: p.inventorySkills({ projectDir }), agent: p.inventoryAgents({ projectDir }), rule: p.inventoryRules({ projectDir }) };
    return Object.entries(inv).flatMap(([kind, list]) => (list || []).map((c) => ({ kind, name: c.name })));
  } catch { return undefined; }
}
/** Ext <name> co dang ky trong hub khong? Chung: khop ten trong thu muc ext hoac khoa trong manifest.json cua ext. Loi -> false. */
export function hasExt(hubDir, name) {
  const esc = String(name).replace(/[^\w.-]/g, '');
  if (!esc) return false;
  try { return registeredExtRoots(hubDir).some((r) => { try { return path.basename(r) === esc || fs.readFileSync(path.join(r, 'manifest.json'), 'utf8').includes('"' + esc + '"'); } catch { return false; } }); } catch { return false; }
}
/**
 * Cot KPI khai bao nguon bang `requires` (vd "ext:<ten>"). Nguon khong co -> hien "khong co nguon", khong 0/im.
 * core khong biet ten ext cu the; `has(kind, name)` tra nguon co khong. Sua truc tiep results.
 */
export function markNoSource(results, has) {
  for (const r of results) {
    const ms = Array.isArray(r.def.metric) ? r.def.metric : [r.def.metric];
    const miss = [];
    ms.forEach((m, i) => {
      const req = m && typeof m === 'object' && typeof m.requires === 'string' ? m.requires : null;
      const [kind, ...n] = req ? req.split(':') : [];
      if (req && !has(kind, n.join(':'))) miss.push({ i, req });
    });
    if (!miss.length) continue;
    if (!r.rows.length) { r.rows = [{ key: 'all', vals: ms.map((m, i) => (miss.some((x) => x.i === i) ? NO_SOURCE : null)) }]; if (!r.cols.length) r.cols = ms.map((m, i) => (m && m.as) || String(i)); }
    else for (const row of r.rows) for (const x of miss) row.vals[x.i] = NO_SOURCE;
    r.note = [r.note, ...miss.map((x) => (r.cols[x.i] || x.req) + ': ' + NO_SOURCE + ' (thieu ' + x.req + ')')].filter(Boolean).join('; ');
  }
  return results;
}
const safeRoot = () => { try { return workspaceRoot(); } catch { return ''; } };

/** Dung bao cao. opts: {days, nowMs, events, ledger, inventory, baseline, sections, projectDir, timeoutMs, dataOpts, defaultsDir}. */
export async function buildReport(opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const loaded = opts.sections ? { sections: opts.sections, errors: [], truncated: null }
    : loadSections({ projectDir: opts.projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? null, ...(opts.defaultsDir ? { defaultsDir: opts.defaultsDir } : {}) });
  const sections = loaded.sections.map((d) => (opts.days && d.window_days > 0 ? { ...d, window_days: opts.days } : d));
  const span = Math.max(1, ...sections.filter((d) => d.window_days > 0 && d.source !== 'ledger').map((d) => d.window_days * (d.compare === 'prev_window' ? 2 : 1)));
  const ev = opts.events ? { events: opts.events, truncated: null } : await readEvents({ days: span, nowMs, timeoutMs: opts.timeoutMs || REPORT.timeoutS * 1000 });
  const baseline = opts.baseline !== undefined ? opts.baseline : readJ(baselineFile(opts.dataOpts));
  const inventory = opts.inventory !== undefined ? opts.inventory : await loadInventory(opts.hubDir || safeRoot());
  const all = { events: ev.events, ledger: opts.ledger || readLedger(ledgerFile(opts.dataOpts)), inventory, baseline,
    // KPI2 = loi lap (error) + quy trinh lap (pattern): detectPatterns la phan thuan cua findPatterns (cung nguong, cung su kien da loc cua so)
    candidatesFn: (events, nowIso) => [...failureCandidates(events, nowIso), ...detectPatterns(events).items] };
  const ctx = { hubDir: opts.hubDir || safeRoot() };
  const results = markNoSource(sections.map((d) => evaluateSection(d, all, { nowMs, ctx })), opts.has || ((kind, name) => (kind === 'ext' ? hasExt(ctx.hubDir, name) : true)));
  const truncated = ev.truncated || loaded.truncated || null;
  const markdown = renderReport(results, { days: opts.days || 7, nowMs, truncated, baseline, errors: loaded.errors });
  return { markdown, results, truncated, errors: loaded.errors, nowMs };
}

/** Chot baseline tu ket qua (ghi state, tru dry-run). */
export function saveBaseline(res, opts = {}) {
  const b = { date: new Date(res.nowMs).toISOString().slice(0, 10), ts: res.nowMs, kpis: Object.fromEntries(res.results.map((r) => [r.def.id, kpiSnapshot(r)])) };
  return opts.dryRun ? { ok: false, baseline: b } : { ok: writeJ(baselineFile(opts.dataOpts), b), baseline: b };
}

/** Xuat vao Obsidian qua cong CLI (`harness obsidian put --section "Noi dung=..."`). Khong co duong an toan -> {ok:false, reason}. */
export function putObsidian(markdown, { run = spawnSync, cli = path.join(REPO_DIR, 'harness', 'cli', 'harness.mjs'), date = new Date().toISOString().slice(0, 10) } = {}) {
  if (markdown.length > REPORT.obsidianMaxChars) return { ok: false, reason: `qua dai (${markdown.length} > ${REPORT.obsidianMaxChars})` };
  try {
    const r = run(process.execPath, ['--no-warnings', cli, 'obsidian', 'put', '--folder', REPORT.obsidianFolder, '--title', `harness-weekly-${date}`, '--section', `Noi dung=${markdown}`], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    return r.status === 0 ? { ok: true } : { ok: false, reason: `obsidian put exit ${r.status}: ${String(r.stderr || r.stdout || r.error || '').trim().slice(0, 200)}` };
  } catch (e) { return { ok: false, reason: e.message }; }
}

const isoWeek = (ms) => { const d = new Date(ms); const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const dn = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dn); const y = t.getUTCFullYear(); return y + '-W' + String(Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400e3 + 1) / 7)).padStart(2, '0'); };
export const reportsDir = (o) => path.join(ledgerDir(o), 'reports');
/** Luon ghi bao cao .md theo tuan vao thu muc du lieu harness (ghi de cung tuan); giu toi da keepFiles file moi nhat. Tra duong dan hoac null. */
export function writeReportFile(markdown, { dataOpts, nowMs = Date.now(), keep = REPORT.keepFiles } = {}) {
  try {
    const dir = reportsDir(dataOpts); const f = path.join(dir, 'harness-weekly-' + isoWeek(nowMs) + '.md');
    if (!guardWrite(f).ok) return null;
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, markdown, 'utf8');
    const all = fs.readdirSync(dir).filter((n) => /^harness-weekly-.*\.md$/.test(n)).sort();
    for (const n of all.slice(0, Math.max(0, all.length - keep))) { try { fs.unlinkSync(path.join(dir, n)); } catch {} }
    return f;
  } catch { return null; }
}

export const markRun = (dataOpts, nowMs = Date.now()) => writeJ(stateFile(dataOpts), { lastRun: nowMs });

/** Kick hang tuan (<= 1 lan / 7 ngay, khoa nhe nhu kickJob cua ledger). Tra true neu da spawn. */
export function kickReport(dataOpts, ctx = {}, nowMs = Date.now()) {
  try {
    const st = readJ(stateFile(dataOpts)) || {};
    if (Number(st.lastRun) && nowMs - Number(st.lastRun) < REPORT.minIntervalDays * 86400e3) return false;
    const lock = path.join(ledgerDir(dataOpts), 'kick-report.json');
    const l = readJ(lock); if (l && nowMs - Number(l.ts) < REPORT.lockMinutes * 60e3) return false;
    if (!writeJ(lock, { ts: nowMs, pid: process.pid })) return false;
    const go = ctx.spawnReport || (() => {
      spawnBackground({ cmd: process.execPath, args: [path.join(HERE, 'cli.mjs'), '--weekly', '--timeout-s', String(REPORT.timeoutS)], key: 'report-weekly', deadlineMs: (REPORT.timeoutS + 60) * 1000, env: process.env });
    });
    go();
    return true;
  } catch { return false; }
}
