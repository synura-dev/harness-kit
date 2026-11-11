import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendSnapshot, readSeries, trend, isoWeek, SERIES_LIMITS } from './series.mjs';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'series-')), 'sub', 'kpi-series.jsonl');

test('isoWeek: dinh dang YYYY-Www, bien nam', () => {
  assert.equal(isoWeek(new Date('2026-11-11T00:00:00Z')), '2026-W46');
  assert.equal(isoWeek(new Date('2026-01-01T00:00:00Z')), '2026-W01');
  assert.equal(isoWeek(new Date('2027-01-01T00:00:00Z')), '2026-W53');
});

test('appendSnapshot chi append, cung tuan -> rev+1', () => {
  const f = tmpFile();
  const a = appendSnapshot(f, { week: '2026-W45', kpi: { x: 1 }, selfdev: {} });
  const b = appendSnapshot(f, { week: '2026-W45', kpi: { x: 2 }, selfdev: {} });
  const c = appendSnapshot(f, { week: '2026-W46', kpi: { x: 3 }, selfdev: {} });
  assert.deepEqual([a.rev, b.rev, c.rev], [1, 2, 1]);
  assert.equal(fs.readFileSync(f, 'utf8').trim().split('\n').length, 3);
});

test('readSeries: dong cuoi moi tuan, bo dong hong', () => {
  const f = tmpFile();
  appendSnapshot(f, { week: '2026-W45', kpi: { x: 1 } });
  fs.appendFileSync(f, 'khong phai json\n');
  appendSnapshot(f, { week: '2026-W45', kpi: { x: 2 } });
  appendSnapshot(f, { week: '2026-W46', kpi: { x: 3 } });
  const r = readSeries(f);
  assert.deepEqual(r.series.map((s) => [s.week, s.kpi.x]), [['2026-W45', 2], ['2026-W46', 3]]);
  assert.equal(r.truncated, undefined);
  assert.deepEqual(readSeries(path.join(os.tmpdir(), 'khong-co-file.jsonl')).series, []);
});

test('readSeries: tran 200 dong -> truncated', () => {
  const f = tmpFile();
  for (let i = 0; i < 205; i++) appendSnapshot(f, { week: `2020-W${String(i).padStart(3, '0')}`, kpi: { x: i } });
  const r = readSeries(f);
  assert.equal(r.truncated, 'max_lines');
  assert.ok(r.series.length <= SERIES_LIMITS.maxLines);
  assert.equal(r.series.at(-1).kpi.x, 204);
});

test('readSeries: tran 2 MB -> truncated', () => {
  const f = tmpFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const line = JSON.stringify({ week: 'W', kpi: { pad: 'x'.repeat(5000) } }) + '\n';
  fs.writeFileSync(f, line.repeat(500)); // ~2.5 MB
  const r = readSeries(f);
  assert.equal(r.truncated, 'max_bytes');
});

test('isoWeek: nhan ca so ms', () => {
  assert.equal(isoWeek(Date.parse('2026-11-11T00:00:00Z')), '2026-W46');
  assert.match(isoWeek(Date.now()), /^\d{4}-W\d{2}$/);
});

test('appendSnapshot: file khong ket thuc bang newline -> them newline, dong moi khong dinh dong hong', () => {
  const f = tmpFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{"week":"2026-W44","kpi":{"x":1}'); // dong hong, thieu newline
  appendSnapshot(f, { week: '2026-W45', kpi: { x: 2 } });
  assert.deepEqual(readSeries(f).series.map((s) => s.week), ['2026-W45']);
});

const mk = (vals) => vals.map((v, i) => ({ week: `w${i}`, kpi: { k: v } }));

test('trend: spark dung do dai, slope OLS, vs_prev, vs_baseline, direction', () => {
  const t = trend(mk([1, 2, 3, 4]), 'k', 8, 2);
  assert.deepEqual(t.values, [1, 2, 3, 4]);
  assert.equal(t.spark.length, 4);
  assert.equal(t.spark[0], '▁');
  assert.equal(t.spark[3], '█');
  assert.ok(Math.abs(t.slope - 1) < 1e-9);
  assert.equal(t.vs_prev_pct, 33.3);
  assert.equal(t.vs_baseline_pct, 100);
  assert.equal(t.direction, 'up');
  assert.equal(trend(mk([4, 3, 2, 1]), 'k').direction, 'down');
});

test('trend: cat n cuoi, null -> khoang trang, flat khi |slope| < 5% trung binh', () => {
  const t = trend(mk([null, 10, 10.1, 9.9, 10]), 'k', 3);
  assert.equal(t.values.length, 3);
  assert.equal(t.direction, 'flat');
  const g = trend(mk([1, null, 3]), 'k', 8);
  assert.equal(g.spark[1], ' ');
  assert.equal(g.spark.length, 3);
});

test('trend: an toan voi rong/null/key thieu', () => {
  for (const s of [[], null, undefined, mk([null, null])]) {
    const t = trend(s, 'k');
    assert.equal(t.slope, null);
    assert.equal(t.vs_prev_pct, null);
    assert.equal(t.vs_baseline_pct, null);
    assert.equal(t.direction, 'flat');
  }
  assert.equal(trend(mk([0, 0]), 'k', 8, 0).vs_baseline_pct, null);
  assert.equal(trend(mk([5]), 'k').vs_prev_pct, null);
});
