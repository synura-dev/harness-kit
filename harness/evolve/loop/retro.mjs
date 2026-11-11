// Retro hang tuan (spec 4.6): KPI + chuoi thoi gian + chi so tu phat trien + bang hieu qua + top-3 van de + nguong tu kiem (F3).
// Du lieu: <dataDir>/retro/<week>.json|md, series.jsonl, emitted.json (dedupe). Fail-open; het timeoutS -> truncated: 'timeout'.
// dataDir = thu muc du lieu evolve (mac dinh ctx().evo). Moi dau vao co the tiem vao (test): kpi, baseline, ledgerEntries, proposals, appliedLog, processChanges, signals.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ctx, redact } from './loop.mjs';
import { isHookRun } from '../../core/audit/signals.mjs';
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
/** Tuan can retro: mac dinh tuan truoc (vua xong; chay dau tuan thi tuan nay gan rong -> stalled gia); current -> tuan dang chay. */
function target(o, nowMs) {
  const at = o.current ? nowMs : nowMs - 7 * DAY;
  return { week: isoWeek(at), ...weekWindow(at) };
}
const redactText = (s) => String(s).split('\n').map(redact).join('\n'); // redact() cat 200 ky tu/dong: ap tung dong cho body dai

/** buildReport -> {'<muc>.<hang>': so}; baseline cung dang tu report-baseline.json (observe report doc nhu the). */
async function defaultKpi({ nowMs, timeoutMs }) {
  const run = await import('../../observe/report/run.mjs');
  const eng = await import('../../observe/report/engine.mjs');
  const ev = await (await import('../../observe/ledger/job.mjs')).readEvents({ days: 7, nowMs, timeoutMs }); // doc audit MOT lan, dung chung cho buildReport + signals
  const res = await run.buildReport({ nowMs, timeoutMs, process: undefined, events: ev.events });
  const kpi = pickKpi(res.results, eng.kpiSnapshot);
  const b = (() => { try { return JSON.parse(fs.readFileSync(run.baselineFile(), 'utf8')); } catch { return null; } })();
  const baseline = {};
  for (const [id, rows] of Object.entries((b && b.kpis) || {})) for (const [k, v] of Object.entries(rows || {})) baseline[`${id}.${k}`] = v;
  return { kpi, baseline, truncated: res.truncated || ev.truncated || null, events: ev.events };
}

/** Chi section `kpi-*` vao series (bo cost-session theo sid, subagent-vs-main theo actor: khoa dong, khong lam chuoi). */
export function pickKpi(results, snapshot) {
  const kpi = {};
  for (const r of results || []) if (/^kpi-/.test(String(r.def && r.def.id))) for (const [k, v] of Object.entries(snapshot(r))) kpi[`${r.def.id}.${k}`] = v;
  return kpi;
}

/** {sessions, corrections, interrupts} tu su kien audit (rec.signal ?? rec.data.signal; phien = sid|session_id; bo HookRun nhu engine report). */
export function signalsFrom(events) {
  const sids = new Set(); let corrections = 0, interrupts = 0;
  for (const r of events || []) {
    if (!r || isHookRun(r)) continue;
    const s = r.sid || r.session_id; if (s) sids.add(s);
    const sig = r.signal ?? (r.data && r.data.signal);
    if (sig === 'correction') corrections++; else if (sig === 'interrupt') interrupts++;
  }
  return { sessions: sids.size, corrections, interrupts };
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
  const { week, start, end } = target(o, nowMs); // mac dinh tuan VUA XONG; o.current -> tuan dang chay
  const asOf = o.current ? nowMs : end; // KPI/audit tinh den het tuan can xem
  const errors = [];
  let truncated = null;

  let kpi = o.kpi, baseline = o.baseline || {}, events = o.events;
  if (!kpi) {
    try { const k = await defaultKpi({ nowMs: asOf, timeoutMs: timeoutS * 500 }); kpi = k.kpi; baseline = k.baseline; truncated = k.truncated; events = events || k.events; } catch (e) { kpi = {}; errors.push(`kpi: ${e.message}`); }
  }
  // signals: cung nguon audit voi KPI3 (rec.signal ?? data.signal; phien theo sid) - dem tu su kien da doc (buildReport) hoac o.events
  const signals = o.signals || (events ? signalsFrom(events) : {});
  if (signals.sessions > 0 && num(signals.corrections) !== null) kpi = { ...kpi, 'signals.corrections_per_session': signals.corrections / signals.sessions };
  const ledgerEntries = o.ledgerEntries || readLedger(o.ledgerFile || ledgerFile());
  const proposals = o.proposals || (await import('./loop.mjs')).listProposals(o, 1000);
  const appliedLog = o.appliedLog || (() => { try { return fs.readFileSync(path.join(dataDir, 'applied.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } })();
  const pc = o.processChanges !== undefined ? o.processChanges : await defaultProcess(nowMs);
  const effects = proposals.filter((p) => p.effect && p.effect.verdict);
  const sdm = selfdevMetrics({ appliedLog, proposals, ledgerEntries, effects, processChanges: Array.isArray(pc) ? pc : pcRows(pc), signals, weekStartMs: start, weekEndMs: end });
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
  const emittedFile = path.join(dir, 'emitted.json');
  const emittedAll = readJ(emittedFile, {});
  const emitted = [];
  // chi van de MOI (chua tao task; key khong gan tuan) -> van de da co task ma van open khong tao lai
  const cand = [
    ...ledgerEntries.filter((e) => ['open', 'warned'].includes(e.status) && (e.fp || e.id)).map((e) => ({ key: `ledger:${e.fp || e.id}`, score: Number(e.count) || 1, summary: redact(`${String(e.message || e.rule || e.id).slice(0, 100)} (x${e.count || 1})`) })),
    ...((pc && pc.repeat) || []).map((r) => ({ key: `file:${r.path}`, score: r.edits, summary: redact(`sua lap ${r.path} (${r.edits} lan/14 ngay)`) })),
  ].filter((c) => !emittedAll[c.key]).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, RETRO.maxIssues);
  const issues = cand.map(({ key, summary }) => ({ key, summary }));

  const sd = (k) => fmtVal(selfdev[k]);
  const plan = { tasks: issues.map((i) => ({ key: i.key, summary: redact(`retro ${week}: ${i.summary}`), priority: 2 })), knowledge: `retro ${week}: huong ${direction}; self_initiated_rate=${sd('self_initiated_rate')} effective_rate=${sd('effective_rate')} rollback_rate=${sd('rollback_rate')}` };
  if (stalled) plan.tasks.unshift({ key: `${week}:stalled`, summary: `[P0] self-improvement stalled: chi so tu phat trien ${direction} 2 tuan lien (${week}); xem retro ${week}`, priority: 0 });
  const res = { week, kpi, trend: ktrend, selfdev, selfdevTrend, direction, stalled, issues, effects: effectRows, plan, emitted, errors, truncated };
  const save = () => { // ghi bao cao (lan 1 truoc apply de co file .md cho knowledge, lan 2 sau apply de co emitted/errors)
    try {
      res.truncated = truncated;
      writeJ(path.join(dir, `${week}.json`), { ...res, ts: new Date(nowMs).toISOString() });
      fs.writeFileSync(path.join(dir, `${week}.md`), redactText(renderRetro(res)));
      res.file = path.join(dir, `${week}.md`);
    } catch (e) { errors.push(`ghi bao cao: ${e.message}`); }
  };
  save();
  if (o.apply) {
    const runner = o.runner || defaultRunner;
    // tran/tuan tinh theo thoi diem tao (tuan thuc te) de chay lai cung tuan khong vuot 3 + 1
    const thisWeek = isoWeek(nowMs);
    const mine = Object.entries(emittedAll).filter(([k, v]) => !k.endsWith(':knowledge') && isoWeek(Date.parse(v)) === thisWeek);
    let issueN = mine.filter(([k]) => !k.endsWith(':stalled')).length, p0N = mine.length - issueN;
    for (const t of plan.tasks) {
      if (timeUp()) { truncated = 'timeout'; break; }
      if (emittedAll[t.key]) continue;
      const isP0 = t.priority === 0;
      if (isP0 ? p0N >= 1 : issueN >= RETRO.maxIssues) continue; // tran/tuan: 3 task van de + 1 P0
      try {
        const r = runner('projects', ['add-task', '--project', o.project || 'harness-kit', '--summary', t.summary, '--priority', String(t.priority)]);
        if (r && r.ok === false) { errors.push(`add-task ${t.key}: ${r.err || 'that bai'}`); continue; }
        emittedAll[t.key] = new Date(nowMs).toISOString(); emitted.push(t.key); isP0 ? p0N++ : issueN++; writeJ(emittedFile, emittedAll); // ghi ngay sau moi spawn thanh cong (atomic)
      } catch (e) { errors.push(`add-task ${t.key}: ${e.message}`); }
    }
    // kho tri thuc: 1 lan/tuan (khong tinh vao tran task); cung co che subprocess + fail-open
    const kkey = `${week}:knowledge`;
    if (res.file && !emittedAll[kkey] && !timeUp()) {
      try {
        const r = runner('knowledge', ['add', '--title', `Retro ${week}`, '--domain', 'hub', '--type', 'reference', '--id', `retro-${week}`, '--body-file', res.file]);
        if (r && r.ok === false) errors.push(`knowledge add: ${r.err || 'that bai'}`);
        else { emittedAll[kkey] = new Date(nowMs).toISOString(); emitted.push(kkey); writeJ(emittedFile, emittedAll); }
      } catch (e) { errors.push(`knowledge add: ${e.message}`); }
    }
  }
  if (timeUp() && !truncated) truncated = 'timeout';
  save();
  return res;
}

/** Kich tu dong cho tuan VUA XONG, 1 lan/tuan: marker <week>.auto.json chi ghi khi chay xong khong loi/timeout (loi -> job sau thu lai; emitted.json giu muc da xong). autoApply mac dinh TRUE, tat bang config evolve `retro.autoApply: false`. */
export async function retroAuto(o = {}) {
  const nowMs = o.nowMs || Date.now();
  const dataDir = o.dataDir || ctx(o).evo;
  const marker = path.join(retroDir(dataDir), `${target(o, nowMs).week}.auto.json`);
  if (fs.existsSync(marker)) return { skipped: 'da chay tuan nay' };
  let autoApply = o.autoApply;
  if (autoApply === undefined) { try { autoApply = loadConfig('evolve', { defaults: { retro: { autoApply: true } } }).config.retro?.autoApply !== false; } catch { autoApply = true; } }
  const r = await retro({ ...o, nowMs, dataDir, apply: autoApply });
  if (!r.errors.length && !r.truncated) { try { writeJ(marker, { ts: new Date(nowMs).toISOString(), week: r.week, apply: !!autoApply }); } catch { /* fail-open */ } }
  return r;
}
