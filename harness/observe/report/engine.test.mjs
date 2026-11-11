import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSections, evaluateSection, renderReport, renderSection, kpiSnapshot } from './engine.mjs';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rep-'));
const NOW = Date.parse('2026-11-05T12:00:00Z');
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const ev = (o) => ({ ts: ago(1), sid: 's1', event: 'PostToolUse', tool: 'Bash', ...o });

test('defaults nap du 13 muc, hop le, co thu tu', () => {
  const r = loadSections({ projectDir: null });
  assert.deepEqual(r.errors, []);
  assert.equal(r.sections.length, 13);
  assert.equal(r.sections[0].id, 'kpi-info-fetch');
});

test('ghi de du an: tron nong + tat enabled:false + muc moi', () => {
  const p = mk(); const d = path.join(p, '.harness', 'report'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'guard.json'), '{"enabled":false}');
  fs.writeFileSync(path.join(d, 'kpi-repeats.json'), '{"title":"X","window_days":3}');
  fs.writeFileSync(path.join(d, 'moi.json'), '{"source":"audit","format":"kpi"}');
  fs.writeFileSync(path.join(d, 'hong.json'), '{xx');
  const r = loadSections({ projectDir: p });
  assert.equal(r.sections.length, 13); // -guard +moi
  assert.ok(!r.sections.find((s) => s.id === 'guard'));
  const k = r.sections.find((s) => s.id === 'kpi-repeats');
  assert.equal(k.title, 'X'); assert.equal(k.source, 'candidates'); assert.equal(k.window_days, 3);
  assert.ok(r.sections.find((s) => s.id === 'moi'));
  assert.ok(r.errors.some((e) => e.startsWith('hong.json')));
  fs.rmSync(p, { recursive: true, force: true });
});

test('muc sai source -> loi, khong nap', () => {
  const d = mk(); fs.writeFileSync(path.join(d, 'a.json'), '{"source":"zzz"}');
  const r = loadSections({ defaultsDir: d });
  assert.equal(r.sections.length, 0); assert.equal(r.errors.length, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('per_session theo actor + so voi tuan truoc', () => {
  const def = { id: 'k', source: 'audit', filter: { tool: 'Bash', target: ['harness tasks'] }, group_by: ['actor'], metric: 'per_session', window_days: 7, compare: 'prev_window', format: 'table' };
  const events = [ev({ target: 'harness tasks', sid: 'a' }), ev({ target: 'harness tasks', sid: 'a' }), ev({ target: 'ls', sid: 'b' }),
    ev({ ts: ago(10), target: 'harness tasks', sid: 'c' })];
  const r = evaluateSection(def, { events }, { nowMs: NOW });
  assert.equal(r.rows[0].key, 'main'); assert.equal(r.rows[0].vals[0], 1); // 2 lan / 2 phien (a,b)
  assert.equal(r.prev.main, 1);
  assert.match(renderSection(r), /\| main \| 1 \| 1 \| \+0% \|/);
});

test('per_task: chi tinh nhom co task_id; phien khong co task_id bao rieng (per_session_notask)', () => {
  const def = { id: 'i', source: 'audit', filter: { signal: 'correction' }, metric: ['per_task', { as: 'tong', metric: 'count' }], window_days: 7, format: 'kpi' };
  const events = [ev({ sid: 'a', data: { signal: 'correction' } }), ev({ sid: 'b', data: { signal: 'correction' } }), ev({ sid: 'c' }),
    ev({ sid: 'd', data: { task_id: 't9', signal: 'correction' } }), ev({ sid: 'd', data: { task_id: 't9' } }), ev({ sid: 'e', data: { task_id: 't8' } })];
  const r = evaluateSection({ ...def, metric: ['per_task', { as: 'ns', metric: 'per_session_notask' }, { as: 'tong', metric: 'count' }] }, { events }, { nowMs: NOW });
  assert.equal(r.rows[0].vals[0], 0.5); // 1 can thiep co task_id / 2 task (t9,t8)
  assert.equal(r.rows[0].vals[1], 2 / 3); // 2 can thiep / 3 phien khong co task_id (a,b,c)
  assert.equal(r.rows[0].vals[2], 3);
  assert.match(renderSection(r), /\*\*per_task\*\*: 0.50/);
});

test('candidates: per_1000 + sum; chiu thieu field', () => {
  const def = { id: 'r', source: 'candidates', filter: { kind: ['error', 'pattern'] }, group_by: ['kind'], metric: ['per_1000', 'count'], window_days: 7, format: 'table' };
  const events = Array.from({ length: 1000 }, () => ev({}));
  const candidates = [{ kind: 'error', fp: 'f', count: 5, sessions: 1, last_ts: ago(1) }, { kind: 'pattern', fp: 'g', count: 3, last_ts: ago(2) }, { kind: 'x', fp: 'h', count: 9 }];
  const r = evaluateSection(def, { events, candidates }, { nowMs: NOW });
  assert.equal(r.rows.find((x) => x.key === 'error').vals[0], 5);
  assert.equal(r.rows.length, 2);
});

test('ledger: sum/last/count co loc cot + list rong -> empty_note', () => {
  const def = { id: 'w', source: 'ledger', filter: { action: 'warn' }, group_by: ['rule'], metric: [{ as: 'w', metric: 'sum:warn_count' }, { as: 'ign', metric: 'count', filter: { status: 'ignored' } }, { as: 'last', metric: 'last:warn_ts' }], window_days: 7, format: 'table' };
  const ledger = [{ id: '1', rule: 'r1', action: 'warn', status: 'ignored', warn_count: 2, warn_ts: [ago(2), ago(1)], last_seen: ago(1) }, { id: '2', rule: 'r1', action: 'warn', status: 'acted', warn_count: 1, warn_ts: [ago(3)], last_seen: ago(1) }];
  const r = evaluateSection(def, { events: [], ledger }, { nowMs: NOW });
  assert.deepEqual(r.rows[0].vals.slice(0, 2), [3, 1]); assert.equal(r.rows[0].vals[2], ago(1));
  const e = evaluateSection({ id: 'q', source: 'ledger', filter: { action: 'propose' }, window_days: 0, format: 'list', empty_note: 'trong' }, { ledger }, { nowMs: NOW });
  assert.equal(e.note, 'trong'); assert.match(renderSection(e), /_trong_| +0% |/);
});

test('thieu field (khong usage): ghi chu, khong nem loi; rate task_status', () => {
  const def = { id: 'g', source: 'audit', metric: [{ as: 'tok', metric: 'per_session:tokens|data.usage.total_tokens' }, { as: 'done', metric: 'rate', filter: { signal: 'task_status' }, rate_filter: { status: 'done' } }], window_days: 7, format: 'kpi' };
  const events = [ev({ data: { signal: 'task_status', status: 'done' } }), ev({ data: { signal: 'task_status', status: 'failed' } })];
  const r = evaluateSection(def, { events }, { nowMs: NOW });
  assert.equal(r.rows[0].vals[0], 0); assert.equal(r.rows[0].vals[1], 0.5);
  const r2 = evaluateSection(def, { events: [ev({ data: { usage: { total_tokens: 100 } } })] }, { nowMs: NOW });
  assert.equal(r2.rows[0].vals[0], 100);
  const empty = evaluateSection(def, {}, { nowMs: NOW });
  assert.equal(empty.rows.length, 0); assert.ok(empty.note);
});

test('baseline: so sanh + snapshot; renderReport co truncated', () => {
  const def = { id: 'b', source: 'audit', metric: 'count', window_days: 7, compare: 'baseline', format: 'kpi' };
  const events = [ev({}), ev({}), ev({})];
  const r = evaluateSection(def, { events, baseline: { date: '2026-10-29', kpis: { b: { all: 2 } } } }, { nowMs: NOW });
  assert.deepEqual(kpiSnapshot(r), { all: 3 });
  assert.match(renderSection(r), /baseline 2, \+50%| +0% |/);
  const md = renderReport([r], { nowMs: NOW, truncated: 'timeout', baseline: { date: '2026-10-29' } });
  assert.match(md, /truncated: timeout| +0% |/); assert.match(md, /baseline: 2026-10-29/);
});

test('HookRun bi bo khoi report: khong tinh loi/actor/mau so per_1000', () => {
  const hook = { ts: ago(1), sid: 's1', type: 'hook', event: 'HookRun', ok: null, tool: null, actor: null };
  const def = { id: 'h', source: 'audit', metric: [{ as: 'su kien', metric: 'count' }, { as: 'pm', metric: 'per_1000' }], window_days: 7, format: 'kpi' };
  const r = evaluateSection(def, { events: [ev({}), ev({}), hook, hook, hook, hook, hook, hook, hook, hook] }, { nowMs: NOW });
  assert.equal(r.rows[0].vals[0], 2); assert.equal(r.rows[0].vals[1], 1000);
});

test('subagent-vs-main: ms = dur_ms, token = data.usage input+output (khong cong cumulative)', () => {
  const def = loadSections({ projectDir: null }).sections.find((s) => s.id === 'subagent-vs-main');
  const events = [
    ev({ event: 'Stop', actor: 'main', dur_ms: 100, tokens_in: 9999, data: { usage: { input: 10, output: 5, msgs: 1 }, usage_mode: 'cumulative' } }),
    ev({ event: 'Stop', actor: 'main', dur_ms: 50, tokens_in: 99999, data: { usage: { input: 7, output: 3, msgs: 1 }, usage_mode: 'cumulative' } }),
    ev({ event: 'Stop', actor: 'main', data: { usage: 'unavailable' } }),
  ];
  const r = evaluateSection(def, { events }, { nowMs: NOW });
  const main = r.rows.find((x) => x.key === 'main'); const col = (n) => main.vals[r.cols.indexOf(n)];
  assert.equal(col('ms'), 150); assert.equal(col('token'), 25);
});

test('guard: token/phien doc data.usage (ban ghi cu khong co total_tokens)', () => {
  const g = JSON.parse(fs.readFileSync(new URL('./defaults/guard.json', import.meta.url), 'utf8'));
  const events = [ev({ sid: 'a', data: { usage: { input: 10, output: 5, cache_creation: 5, total_tokens: 20 } } }), ev({ sid: 'b', data: { usage: { input: 10, output: 10, cache_creation: 0 } } })];
  const r = evaluateSection(g, { events }, { nowMs: NOW });
  assert.equal(r.rows[0].vals[0], 20);
});

test('days=1: cot theo ten cua so + trung binh 7 cua so truoc', () => {
  const def = { id: 'd', source: 'audit', metric: 'count', window_days: 1, compare: 'prev_window', format: 'kpi' };
  const events = [ev({ ts: ago(0.1) })];
  for (let d = 1; d <= 7; d++) events.push(ev({ ts: ago(d + 0.5) }), ev({ ts: ago(d + 0.5) }));
  const r = evaluateSection(def, { events }, { nowMs: NOW });
  assert.equal(r.avg.all, 2);
  const md = renderSection(r);
  assert.match(md, /hom qua/); assert.match(md, /tb 7 ngay truoc 2, -50%/); assert.doesNotMatch(md, /tuan truoc/);
  assert.match(renderReport([r], { days: 1, nowMs: NOW }), /# Bao cao harness ngay 2026-11-05/);
  assert.match(renderReport([r], { days: 7, nowMs: NOW }), /# Bao cao harness tuan/);
});

test('task_done_rate: doc task ext projects (completed / khong tinh cancelled), thieu nguon -> null', () => {
  const def = { id: 't', source: 'audit', metric: [{ as: 'n', metric: 'count' }, { as: 'task done', metric: 'task_done_rate' }], window_days: 7, format: 'kpi' };
  const tasks = [{ status: 'completed', modified: ago(1) }, { status: 'in-process', modified: ago(1) }, { status: 'cancelled', modified: ago(1) }, { status: 'completed', modified: ago(30) }];
  assert.equal(evaluateSection(def, { events: [ev({})], tasks }, { nowMs: NOW }).rows[0].vals[1], 0.5);
  assert.equal(evaluateSection(def, { events: [ev({})] }, { nowMs: NOW }).rows[0].vals[1], null);
});

test('avg: bo ky rong/ngoai dai du lieu khoi mau so, ghi n/K', () => {
  const def = { id: 'm', source: 'audit', metric: 'count', window_days: 1, compare: 'prev_window', format: 'kpi' };
  // du lieu chi co hom nay + 3 ngay truoc (moi ngay 2 su kien); avgOf 7 -> chi 3 ky dung
  const events = [ev({ ts: ago(0.1) })];
  for (let d = 1; d <= 3; d++) events.push(ev({ ts: ago(d + 0.5) }), ev({ ts: ago(d + 0.5) }));
  const r = evaluateSection(def, { events }, { nowMs: NOW });
  assert.equal(r.n, 3); assert.equal(r.avg.all, 2);
  assert.match(renderSection(r), /tb 3\/7 ngay truoc 2/);
});

test('avg: ky giua rong (khong su kien) khong keo trung binh ve 0', () => {
  const def = { id: 'm', source: 'audit', metric: 'count', window_days: 1, compare: 'prev_window', format: 'kpi' };
  const events = [ev({ ts: ago(0.1) }), ev({ ts: ago(1.5) }), ev({ ts: ago(1.5) }), ev({ ts: ago(5.5) }), ev({ ts: ago(5.5) })];
  const r = evaluateSection(def, { events }, { nowMs: NOW, avgOf: 5 });
  assert.equal(r.n, 2); assert.equal(r.avg.all, 2);
});
