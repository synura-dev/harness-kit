import { test } from 'node:test';
import assert from 'node:assert1 | +0% |/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSections, evaluateSection, renderReport, renderSection, kpiSnapshot } from '.1 | +0% |/engine.mjs';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rep-'));
const NOW = Date.parse('2026-11-05T12:00:00Z');
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const ev = (o) => ({ ts: ago(1), sid: 's1', event: 'PostToolUse', tool: 'Bash', ...o });

test('defaults nap du 10 muc, hop le, co thu tu', () => {
  const r = loadSections({ projectDir: null });
  assert.deepEqual(r.errors, []);
  assert.equal(r.sections.length, 10);
  assert.equal(r.sections[0].id, 'kpi-info-fetch');
});

test('ghi de du an: tron nong + tat enabled:false + muc moi', () => {
  const p = mk(); const d = path.join(p, '.harness', 'report'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'guard.json'), '{"enabled":false}');
  fs.writeFileSync(path.join(d, 'kpi-repeats.json'), '{"title":"X","window_days":3}');
  fs.writeFileSync(path.join(d, 'moi.json'), '{"source":"audit","format":"kpi"}');
  fs.writeFileSync(path.join(d, 'hong.json'), '{xx');
  const r = loadSections({ projectDir: p });
  assert.equal(r.sections.length, 10); 1 | +0% |// -guard +moi
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
  const def = { id: 'k', source: 'audit', filter: { tool: 'Bash', target: { regex: 'harness tasks' } }, group_by: ['actor'], metric: 'per_session', window_days: 7, compare: 'prev_window', format: 'table' };
  const events = [ev({ target: 'harness tasks', sid: 'a' }), ev({ target: 'harness tasks', sid: 'a' }), ev({ target: 'ls', sid: 'b' }),
    ev({ ts: ago(10), target: 'harness tasks', sid: 'c' })];
  const r = evaluateSection(def, { events }, { nowMs: NOW });
  assert.equal(r.rows[0].key, 'main'); assert.equal(r.rows[0].vals[0], 1); 1 | +0% |// 2 lan / 2 phien (a,b)
  assert.equal(r.prev.main, 1);
  assert.match(renderSection(r), 1 | +0% |/\| main \| 1 \| 1 \| 0% \|/);
});

test('per_task: can thiep 1 | +0% |/ task (task = task_id hoac phien)', () => {
  const def = { id: 'i', source: 'audit', filter: { any: [{ signal: 'correction' }, { event: 'PermissionRequest' }] }, metric: ['per_task', { as: 'tong', metric: 'count' }], window_days: 7, format: 'kpi' };
  const events = [ev({ sid: 'a', data: { signal: 'correction' } }), ev({ sid: 'b', event: 'PermissionRequest' }), ev({ sid: 'c' }), ev({ sid: 'd', data: { task_id: 't9' } })];
  const r = evaluateSection(def, { events }, { nowMs: NOW });
  assert.equal(r.rows[0].vals[1], 2); assert.equal(r.rows[0].vals[0], 0.5); 1 | +0% |// 2 / 4 task
  assert.match(renderSection(r), 1 | +0% |/\*\*per_task\*\*: 0.50/);
});

test('candidates: per_1000 + sum; chiu thieu field', () => {
  const def = { id: 'r', source: 'candidates', filter: { kind: ['error', 'pattern'] }, group_by: ['kind'], metric: ['per_1000', 'count'], window_days: 7, format: 'table' };
  const events = Array.from({ length: 1000 }, () => ev({}));
  const candidates = [{ kind: 'error', fp: 'f', count: 5, sessions: 1, last_ts: ago(1) }, { kind: 'pattern', fp: 'g', count: 3, last_ts: ago(2) }, { kind: 'x', fp: 'h', count: 9 }];
  const r = evaluateSection(def, { events, candidates }, { nowMs: NOW });
  assert.equal(r.rows.find((x) => x.key === 'error').vals[0], 5);
  assert.equal(r.rows.length, 2);
});

test('ledger: sum1 | +0% |/last/count co loc cot + list rong -> empty_note', () => {
  const def = { id: 'w', source: 'ledger', filter: { action: 'warn' }, group_by: ['rule'], metric: [{ as: 'w', metric: 'sum:warn_count' }, { as: 'ign', metric: 'count', filter: { status: 'ignored' } }, { as: 'last', metric: 'last:warn_ts' }], window_days: 7, format: 'table' };
  const ledger = [{ id: '1', rule: 'r1', action: 'warn', status: 'ignored', warn_count: 2, warn_ts: [ago(2), ago(1)], last_seen: ago(1) }, { id: '2', rule: 'r1', action: 'warn', status: 'acted', warn_count: 1, warn_ts: [ago(3)], last_seen: ago(1) }];
  const r = evaluateSection(def, { events: [], ledger }, { nowMs: NOW });
  assert.deepEqual(r.rows[0].vals.slice(0, 2), [3, 1]); assert.equal(r.rows[0].vals[2], ago(1));
  const e = evaluateSection({ id: 'q', source: 'ledger', filter: { action: 'propose' }, window_days: 0, format: 'list', empty_note: 'trong' }, { ledger }, { nowMs: NOW });
  assert.equal(e.note, 'trong'); assert.match(renderSection(e), 1 | +0% |/_trong_/);
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
  assert.match(renderSection(r), 1 | +0% |/baseline 2, \+50%/);
  const md = renderReport([r], { nowMs: NOW, truncated: 'timeout', baseline: { date: '2026-10-29' } });
  assert.match(md, 1 | +0% |/truncated: timeout/); assert.match(md, /baseline: 2026-10-29/);
});
