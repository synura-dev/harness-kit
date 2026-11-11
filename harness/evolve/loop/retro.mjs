// Retro hang tuan (spec 4.6): KPI + chuoi thoi gian + chi so tu phat trien + bang hieu qua + top-3 van de + nguong tu kiem (F3).
// Du lieu: <dataDir>/retro/<week>.json|md, series.jsonl, emitted.json (dedupe). Fail-open; het timeoutS -> truncated: 'timeout'.
// dataDir = thu muc du lieu evolve (mac dinh ctx().evo). Moi dau vao co the tiem vao (test): kpi, baseline, ledgerEntries, proposals, appliedLog, processChanges, signals.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ctx } from './loop.mjs';
import { isoWeek, appendSnapshot, readSeries, trend } from './series.mjs';
import { selfdevMetrics, compositeDirection } from './selfdev.mjs';
import { readLedger, ledgerFile } from '../../observe/ledger/ledger.mjs';
import { loadConfig } from '../../core/config/config.mjs';

export const RETRO = Object.freeze({ timeoutS: 30, maxIssues: 3, maxTasksPerWeek: 4, seriesWeeks: 8 });
const DAY = 86400000;
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'harness.mjs');
const retroDir = (dataDir) => path.join(dataDir, 'retro');
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, j) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(j, null, 2) + '\n'); fs.renameSync(t, f); };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Tuan UTC [start, end) chua nowMs, dung cho cua so selfdev (tuan ISO bat dau thu hai). */
function weekWindow(nowMs) {
  const d = new Date(nowMs); d.setUTCHours(0, 0, 0, 0);
  const start = d.getTime() - (((d.getUTCDay() || 7) - 1) * DAY);
  return { start, end: start + 7 * DAY };
}

/** buildReport -> {'<muc>.<hang>': so}; baseline cung dang tu report-baseline.json (observe report doc nhu the). */
async function defaultKpi({ nowMs, timeoutMs }) {
  const run = await import('../../observe/report/run.mjs');
  const eng = await import('../../observe/report/engine.mjs');
  const res = await run.buildReport({ nowMs, timeoutMs, process: undefined });
  const kpi = {};
  for (const r of res.results) for (const [k, v] of Object.entries(eng.kpiSnapshot(r))) kpi[`${r.def.id}.${k}`] = v;
  const b = (() => { try { return JSON.parse(fs.readFileSync(run.baselineFile(), 'utf8')); } catch { return null; } })();
  const baseline = {};
  for (const [id, rows] of Object.entries((b && b.kpis) || {})) for (const [k, v] of Object.entries(rows || {})) baseline[`${id}.${k}`] = v;
  return { kpi, baseline, truncated: res.truncated || null };
}

async function defaultProcess(nowMs) {
  try {
    const { processChanges } = await import('../../observe/report/process-changes.mjs');
    return processChanges({ projectDir: ctx().hub, nowMs });
  } catch { return null; }
}

// shortcut: process-changes chi tra so lan sua / file (khong tung commit) -> xap xi moi lan sua = 1 dong {ts: lan sua cuoi}.
const pcRows = (pc) => ((pc && pc.files) || []).flatMap((f) => Array.from({ length: Math.min(f.edits || 1, 20) }, () => ({ ts: f.last_ts, file: f.path })));

function defaultRunner(cmd, args) {
  const r = spawnSync(process.execPath, [CLI, cmd, ...args], { timeout: 10000, encoding: 'utf8' });
  return { ok: !r.error && r.status === 0, out: String(r.stdout || '').slice(0, 300), err: String((r.error && r.error.message) || r.stderr || '').slice(0, 300) };
}

function fmtPct(v) { return v === null || v === undefined ? '-' : `${v > 0 ? '+' : ''}${v}%`; }
function fmtVal(v) { return v === null || v === undefined ? '-' : String(Math.round(v * 100) / 100); }

export function renderRetro(r) {
  const L = [`# Retro ${r.week}${r.truncated ? ` (truncated: ${r.truncated})` : ''}`, '', '## KPI (chuoi tuan)', '| KPI | now | spark | slope | vs prev | vs baseline |', '|---|---|---|---|---|---|'];
  for (const [k, t] of Object.entries(r.trend)) L.push(`| ${k} | ${fmtVal(r.kpi[k])} | ${t.spark} | ${fmtVal(t.slope)} | ${fmtPct(t.vs_prev_pct)} | ${fmtPct(t.vs_baseline_pct)} |`);
  L.push('', `## Kha nang tu phat trien (tong hop: ${r.direction})`, '| chi so | now | tot hon | spark | vs prev | huong |', '|---|---|---|---|---|---|');
  for (const [k, t] of Object.entries(r.selfdevTrend)) L.push(`| ${k} | ${fmtVal(r.selfdev[k])} | ${t.better} | ${t.spark} | ${fmtPct(t.vs_prev_pct)} | ${t.direction} |`);
  L.push('', '## Hieu qua thay doi da ap', '| de xuat | dich | ket qua | goi y |', '|---|---|---|---|');
  for (const e of r.effects) L.push(`| ${e.id} | ${e.target || '-'} | ${e.verdict} | ${e.suggest} |`);
  if (!r.effects.length) L.push('| (chua co) | | | |');
  L.push('', `## Top ${r.issues.length} van de`, ...r.issues.map((i) => `- \`${i.key}\` ${i.summary}`));
  L.push('', '## Tu kiem', r.stalled ? `- DUNG YEN: chi so tu phat trien ${r.direction} 2 tuan lien -> task P0 "self-improvement stalled"` : '- binh thuong (khong dung yen 2 tuan lien)');
  L.push('', '_Quy uoc: moi thay doi file quy tac qua git = do nguoi chi dao; qua evolve = tu khoi xuong._');
  return L.join('\n') + '\n';
}

/**
 * retro({apply, nowMs, dataDir, runner, timeoutS, ...input}) -> {week, kpi, trend, selfdev, selfdevTrend, direction, stalled, issues, effects, plan, emitted, errors, truncated, file}
 * runner(cmd, args) -> {ok}; chi goi khi apply. Loi/timeout runner -> bao cao van ghi (fail-open), key khong vao emitted (lan sau thu lai).
 */
export async function retro(o = {}) {
  const nowMs = o.nowMs || Date.now();
  const t0 = Date.now();
  const timeoutS = o.timeoutS || RETRO.timeoutS;
  const timeUp = () => Date.now() - t0 > timeoutS * 1000;
  const dataDir = o.dataDir || ctx(o).evo;
  const dir = retroDir(dataDir);
  const week = isoWeek(nowMs);
  const errors = [];
  let truncated = null;

  let kpi = o.kpi, baseline = o.baseline || {};
  if (!kpi) {
    try { const k = await defaultKpi({ nowMs, timeoutMs: timeoutS * 500 }); kpi = k.kpi; baseline = k.baseline; truncated = k.truncated; } catch (e) { kpi = {}; errors.push(`kpi: ${e.message}`); }
  }
  const ledgerEntries = o.ledgerEntries || readLedger(o.ledgerFile || ledgerFile());
  const proposals = o.proposals || (await import('./loop.mjs')).listProposals(o, 1000);
  const appliedLog = o.appliedLog || (() => { try { return fs.readFileSync(path.join(dataDir, 'applied.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } })();
  const pc = o.processChanges !== undefined ? o.processChanges : await defaultProcess(nowMs);
  const { start, end } = weekWindow(nowMs);
  const effects = proposals.filter((p) => p.effect && p.effect.verdict);
  const sdm = selfdevMetrics({ appliedLog, proposals, ledgerEntries, effects, processChanges: Array.isArray(pc) ? pc : pcRows(pc), signals: o.signals || {}, weekStartMs: start, weekEndMs: end });
  const selfdev = Object.fromEntries(Object.entries(sdm).map(([k, m]) => [k, m.value]));

  // chuoi: append (moi lan chay cung tuan -> rev+1, readSeries lay dong cuoi) roi trend
  const sfile = path.join(dir, 'series.jsonl');
  appendSnapshot(sfile, { week, kpi, selfdev, nowMs });
  const series = readSeries(sfile).series;
  const n = RETRO.seriesWeeks;
  const trendOf = (ser, src, key, base) => trend(ser.map((s) => ({ kpi: s[src] })), key, n, base);
  const ktrend = Object.fromEntries(Object.keys(kpi).map((k) => [k, trendOf(series, 'kpi', k, num(baseline[k]))]));
  const sdTrend = (ser) => Object.fromEntries(Object.entries(sdm).filter(([k]) => ser.some((s) => num(s.selfdev && s.selfdev[k]) !== null)).map(([k, m]) => [k, { ...trendOf(ser, 'selfdev', k, null), better: m.better }]));
  const selfdevTrend = sdTrend(series);
  const direction = compositeDirection(selfdevTrend);
  // F3: tuan nay VA tuan truoc (can >= 2 diem de tuan truoc co nghia) deu flat|worse
  const prevSeries = series.slice(0, -1);
  const prevDir = prevSeries.length >= 2 ? compositeDirection(sdTrend(prevSeries)) : null;
  const stalled = ['flat', 'worse'].includes(direction) && ['flat', 'worse'].includes(prevDir);

  const effectRows = effects.map((p) => ({ id: p.id, target: p.change && p.change.target, verdict: p.effect.verdict, suggest: p.effect.verdict === 'worse' ? 'rollback' : p.effect.verdict === 'better' ? 'keep' : 'xem lai' }));
  // top van de: ledger open/warned (count) + file quy tac sua lap (A1); key on dinh = nguon + fp/path
  const cand = [
    ...ledgerEntries.filter((e) => ['open', 'warned'].includes(e.status) && (e.fp || e.id)).map((e) => ({ key: `ledger:${e.fp || e.id}`, score: Number(e.count) || 1, summary: `${String(e.message || e.rule || e.id).slice(0, 100)} (x${e.count || 1})` })),
    ...((pc && pc.repeat) || []).map((r) => ({ key: `file:${r.path}`, score: r.edits, summary: `sua lap ${r.path} (${r.edits} lan/14 ngay)` })),
  ].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, RETRO.maxIssues);
  const issues = cand.map(({ key, summary }) => ({ key, summary }));

  const sd = (k) => fmtVal(selfdev[k]);
  const plan = { tasks: issues.map((i) => ({ key: `${week}:${i.key}`, summary: `retro ${week}: ${i.summary}`.slice(0, 200), priority: 2 })), knowledge: `retro ${week}: huong ${direction}; self_initiated_rate=${sd('self_initiated_rate')} effective_rate=${sd('effective_rate')} rollback_rate=${sd('rollback_rate')}` };
  if (stalled) plan.tasks.unshift({ key: `${week}:stalled`, summary: `self-improvement stalled: chi so tu phat trien ${direction} 2 tuan lien (${week}); xem retro ${week}`, priority: 0 });

  const emittedFile = path.join(dir, 'emitted.json');
  const emittedAll = readJ(emittedFile, {});
  const emitted = [];
  if (o.apply) {
    const runner = o.runner || defaultRunner;
    let issueN = 0, p0N = 0;
    for (const t of plan.tasks) {
      if (timeUp()) { truncated = 'timeout'; break; }
      if (emittedAll[t.key]) continue;
      const isP0 = t.priority === 0;
      if (isP0 ? p0N >= 1 : issueN >= RETRO.maxIssues) continue; // tran/tuan: 3 task van de + 1 P0
      try {
        const r = runner('projects', ['add-task', '--project', o.project || 'harness-kit', '--summary', t.summary, '--priority', String(t.priority)]);
        if (r && r.ok === false) { errors.push(`add-task ${t.key}: ${r.err || 'that bai'}`); continue; }
        emittedAll[t.key] = new Date(nowMs).toISOString(); emitted.push(t.key); isP0 ? p0N++ : issueN++;
      } catch (e) { errors.push(`add-task ${t.key}: ${e.message}`); }
    }
    // shortcut: 'harness knowledge' la ext cua hub (khong co trong repo nay) -> khong goi, chi in plan.knowledge cho main ghi.
    if (emitted.length) writeJ(emittedFile, emittedAll);
  }
  if (timeUp() && !truncated) truncated = 'timeout';

  const res = { week, kpi, trend: ktrend, selfdev, selfdevTrend, direction, stalled, issues, effects: effectRows, plan, emitted, errors, truncated };
  try {
    writeJ(path.join(dir, `${week}.json`), { ...res, ts: new Date(nowMs).toISOString() });
    fs.writeFileSync(path.join(dir, `${week}.md`), renderRetro(res));
    res.file = path.join(dir, `${week}.md`);
  } catch (e) { errors.push(`ghi bao cao: ${e.message}`); }
  return res;
}

/** Kich tu dong 1 lan/isoWeek: da co <week>.json -> bo qua. autoApply mac dinh TRUE, tat bang config evolve `retro.autoApply: false`. */
export async function retroAuto(o = {}) {
  const nowMs = o.nowMs || Date.now();
  const dataDir = o.dataDir || ctx(o).evo;
  if (fs.existsSync(path.join(retroDir(dataDir), `${isoWeek(nowMs)}.json`))) return { skipped: 'da chay tuan nay' };
  let autoApply = o.autoApply;
  if (autoApply === undefined) { try { autoApply = loadConfig('evolve', { defaults: { retro: { autoApply: true } } }).config.retro?.autoApply !== false; } catch { autoApply = true; } }
  return retro({ ...o, nowMs, dataDir, apply: autoApply });
}
