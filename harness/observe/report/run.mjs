// Chay bao cao: doc audit/so, danh gia muc, baseline, xuat. Tat ca doc co timeout/limit; het han -> truncated: timeout.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawnBackground } from '../../core/runtime/proc.mjs';
import { fileURLToPath } from 'node:url';
import { REPO_DIR, workspaceRoot } from '../../core/io/paths.mjs';
import { loadConfig } from '../../core/config/config.mjs';
import { guardWrite } from '../../core/io/storage.mjs';
import { failureCandidates } from '../../core/audit/candidate-shape.mjs';
import { detectPatterns } from '../../evolve/loop/patterns.mjs';
import { readEvents } from '../ledger/job.mjs';
import { listRegistered } from '../../core/ext/ext-trust.mjs';
import { registeredExtRoots } from '../ledger/sources.mjs';
import { readLedger, ledgerFile, ledgerDir } from '../ledger/ledger.mjs';
import { AVG_WINDOWS, loadSections, evaluateSection, renderReport, kpiSnapshot } from './engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPORT = Object.freeze({ timeoutS: 25, minIntervalDays: 7, lockMinutes: 10, obsidianMaxChars: 24000, obsidianFolder: '10 Projects/harness-kit/Reports', keepFiles: 12 });
// Tham so tinh toan (mac dinh trong code; ghi de: config/report (loadConfig), env HARNESS_REPORT_*, co CLI --avg-of/--compare).
export const REPORT_DEFAULTS = Object.freeze({ avgOf: AVG_WINDOWS, avgOfMax: 30, compare: 'all' }); // compare: all|prev|avg|baseline
export const COMPARE_MODES = Object.freeze(['all', 'prev', 'avg', 'baseline']);
/** Gop mac dinh < config < flag; gia tri sai -> mac dinh. */
export function resolveReport(flags = {}, o = {}) {
  const f = Object.fromEntries(Object.entries(flags).filter(([, v]) => v != null));
  let c = {}; try { c = loadConfig('report', { defaults: REPORT_DEFAULTS, flags: f, ...(o.env ? { env: o.env } : {}), ...(o.root ? { root: o.root } : {}) }).config; } catch { /* mac dinh */ }
  const n = Math.floor(Number(c.avgOf));
  return { avgOf: n >= 1 ? Math.min(n, REPORT_DEFAULTS.avgOfMax) : REPORT_DEFAULTS.avgOf, compare: COMPARE_MODES.includes(c.compare) ? c.compare : REPORT_DEFAULTS.compare };
}
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
export function hasExt(hubDir, name, list = listRegistered) {
  const id = String(name);
  if (!id) return false;
  try { return list({ workspace: hubDir }).some((e) => e && e.id === id); } catch { return false; }
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
/** Task tu ext projects (`harness projects tasks --all --json` = mang). Fail-open: loi/khong phai mang -> undefined. */
export const TASK_LIMIT = 200; // tran cua `projects tasks --limit`; cham tran -> truncated
export function loadTasks(hubDir, { run = spawnSync, cli = path.join(REPO_DIR, 'harness', 'cli', 'harness.mjs'), timeoutMs = 15000 } = {}) {
  try {
    const r = run(process.execPath, ['--no-warnings', cli, 'projects', 'tasks', '--all', '--limit', String(TASK_LIMIT), '--json'], { encoding: 'utf8', timeout: Math.min(timeoutMs, 30000), windowsHide: true, cwd: hubDir || undefined, maxBuffer: 4 * 1024 * 1024 });
    const j = r.status === 0 ? JSON.parse(r.stdout) : null;
    return Array.isArray(j) ? { tasks: j, truncated: j.length >= TASK_LIMIT ? 'tasks_limit' : null } : undefined;
  } catch { return undefined; }
}
const safeRoot = () => { try { return workspaceRoot(); } catch { return ''; } };

/** Dung bao cao. opts: {days, nowMs, events, ledger, inventory, baseline, sections, projectDir, timeoutMs, dataOpts, defaultsDir}. */
export async function buildReport(opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const loaded = opts.sections ? { sections: opts.sections, errors: [], truncated: null }
    : loadSections({ projectDir: opts.projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? null, ...(opts.defaultsDir ? { defaultsDir: opts.defaultsDir } : {}) });
  const cfg = resolveReport({ avgOf: opts.avgOf, compare: opts.compare }, { env: opts.env, root: opts.hubDir });
  const sections = loaded.sections.map((d) => (opts.days && d.window_days > 0 ? { ...d, window_days: opts.days } : d));
  const span = Math.max(1, ...sections.filter((d) => d.window_days > 0 && d.source !== 'ledger').map((d) => d.window_days * (d.compare === 'prev_window' ? (cfg.compare === 'baseline' ? 1 : cfg.compare === 'prev' ? 2 : cfg.avgOf + 1) : 1)));
  const ev = opts.events ? { events: opts.events, truncated: null } : await readEvents({ days: span, nowMs, timeoutMs: opts.timeoutMs || REPORT.timeoutS * 1000 });
  const baseline = opts.baseline !== undefined ? opts.baseline : readJ(baselineFile(opts.dataOpts));
  const hubDir = opts.hubDir || safeRoot();
  const inventory = opts.inventory !== undefined ? opts.inventory : await loadInventory(hubDir);
  const has = opts.has || ((kind, name) => (kind === 'ext' ? hasExt(hubDir, name) : true));
  // chi spawn khi co muc can task_done_rate
  const needTasks = sections.some((d) => JSON.stringify(d.metric).includes('task_done_rate'));
  const tl = opts.tasks !== undefined ? { tasks: opts.tasks, truncated: opts.tasksTruncated || null } : needTasks && has('ext', 'projects') ? loadTasks(hubDir, { run: opts.runTasks || spawnSync, timeoutMs: opts.timeoutMs }) : undefined;
  const tasks = tl ? tl.tasks : undefined;
  const all = { tasks, events: ev.events, ledger: opts.ledger || readLedger(ledgerFile(opts.dataOpts)), inventory, baseline,
    // KPI2 = loi lap (error) + quy trinh lap (pattern): detectPatterns la phan thuan cua findPatterns (cung nguong, cung su kien da loc cua so)
    candidatesFn: (events, nowIso) => [...failureCandidates(events, nowIso), ...detectPatterns(events).items] };
  const ctx = { hubDir };
  const results = markNoSource(sections.map((d) => evaluateSection(d, all, { nowMs, ctx, avgOf: cfg.avgOf, compare: cfg.compare })), has);
  const truncated = ev.truncated || loaded.truncated || (tl && tl.truncated) || null;
  const markdown = renderReport(results, { days: opts.days || 7, nowMs, truncated, baseline, errors: loaded.errors });
  return { markdown, results, truncated, errors: loaded.errors, nowMs };
}

/** Chot baseline tu ket qua (ghi state, tru dry-run). */
export function saveBaseline(res, opts = {}) {
  const b = { date: new Date(res.nowMs).toISOString().slice(0, 10), ts: res.nowMs, kpis: Object.fromEntries(res.results.map((r) => [r.def.id, kpiSnapshot(r)])) };
  return opts.dryRun ? { ok: false, baseline: b } : { ok: writeJ(baselineFile(opts.dataOpts), b), baseline: b };
}

/** Xuat vao Obsidian qua cong CLI (`harness obsidian put --section "Noi dung=..."`). Khong co duong an toan -> {ok:false, reason}. */
export function putObsidian(markdown, { run = spawnSync, cli = path.join(REPO_DIR, 'harness', 'cli', 'harness.mjs'), date = new Date().toISOString().slice(0, 10), days = 7 } = {}) {
  if (markdown.length > REPORT.obsidianMaxChars) return { ok: false, reason: `qua dai (${markdown.length} > ${REPORT.obsidianMaxChars})` };
  try {
    const r = run(process.execPath, ['--no-warnings', cli, 'obsidian', 'put', '--folder', REPORT.obsidianFolder, '--title', days === 7 ? `harness-weekly-${date}` : reportName(days).name, '--section', `Noi dung=${markdown}`], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    return r.status === 0 ? { ok: true } : { ok: false, reason: `obsidian put exit ${r.status}: ${String(r.stderr || r.stdout || r.error || '').trim().slice(0, 200)}` };
  } catch (e) { return { ok: false, reason: e.message }; }
}

export const isoWeek = (ms) => { const d = new Date(ms); const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const dn = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dn); const y = t.getUTCFullYear(); return y + '-W' + String(Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400e3 + 1) / 7)).padStart(2, '0'); };
const localDate = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
/** Ten file/tieu de theo cua so: 1 -> harness-daily-<ngay local>, 7 -> harness-weekly-<ISO tuan>, khac -> harness-<N>d-<ngay local>. */
export const reportName = (days, nowMs = Date.now()) => { const pre = days === 1 ? 'harness-daily-' : days === 7 || !days ? 'harness-weekly-' : `harness-${days}d-`; return { pre, name: pre + (pre === 'harness-weekly-' ? isoWeek(nowMs) : localDate(nowMs)) }; };
export const reportsDir =(o) => path.join(ledgerDir(o), 'reports');
/** Luon ghi bao cao .md theo tuan vao thu muc du lieu harness (ghi de cung tuan); giu toi da keepFiles file moi nhat. Tra duong dan hoac null. */
export function writeReportFile(markdown, { dataOpts, nowMs = Date.now(), keep = REPORT.keepFiles, days = 7 } = {}) {
  try {
    const { pre, name } = reportName(days, nowMs); // moi cua so mot ho ten file, khong de len file tuan
    const dir = reportsDir(dataOpts); const f = path.join(dir, name + '.md');
    if (!guardWrite(f).ok) return null;
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, markdown, 'utf8');
    const all = fs.readdirSync(dir).filter((n) => n.startsWith(pre) && n.endsWith('.md')).sort();
    for (const n of all.slice(0, Math.max(0, all.length - keep))) { try { fs.unlinkSync(path.join(dir, n)); } catch {} }
    return f;
  } catch { return null; }
}

export const markRun = (dataOpts, nowMs = Date.now(), error = null) => writeJ(stateFile(dataOpts), error ? { lastRun: nowMs, error: String(error).slice(0, 200) } : { lastRun: nowMs });

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
