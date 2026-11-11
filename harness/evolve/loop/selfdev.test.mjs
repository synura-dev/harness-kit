import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { selfdevMetrics, compositeDirection } from './selfdev.mjs';

const H = 3600e3, W0 = Date.parse('2026-11-02T00:00:00Z'), W1 = W0 + 7 * 24 * H;
const at = (h) => new Date(W0 + h * H).toISOString();
const KEYS = ['self_initiated_rate', 'time_to_fix_h', 'time_to_verify_h', 'effective_rate', 'rollback_rate', 'repeat_correction_rate', 'repeat_errors_resolved'];

test('mau 0 -> null, khong chia 0, kem better', () => {
  const m = selfdevMetrics({ weekStartMs: W0, weekEndMs: W1 });
  for (const k of KEYS) {
    assert.equal(m[k].value, null, k);
    assert.ok(['up', 'down'].includes(m[k].better), k);
  }
  assert.equal(m.repeat_files.value, 0);
  const z = selfdevMetrics({ signals: { sessions: 0, corrections: 0, interrupts: 0 }, weekStartMs: W0, weekEndMs: W1 });
  assert.equal(z.repeat_correction_rate.value, null);
});

test('cong thuc spec 4.5 voi dong applied.jsonl that', () => {
  const m = selfdevMetrics({
    appliedLog: [
      { ts: at(10), op: 'apply', id: 'a', ok: true, ver: 1, target: 'r' },
      { ts: at(20), op: 'apply', id: 'b', ok: true, ver: 2, target: 'r' },
      { ts: at(21), op: 'apply', id: 'z', ok: false, ver: 3 }, // apply loi: khong tinh
      { ts: at(22), op: 'rollback', ver: 2, ok: true, id: 'b', target: 'r' },
      { ts: at(23), op: 'rollback', ver: 9, ok: false }, // rollback loi: khong tinh
      { ts: new Date(W0 - 5 * H).toISOString(), op: 'apply', id: 'old', ok: true },
    ],
    proposals: [
      { id: 'a', candidate: 'c1', effect: { verdict: 'better', measured_at: at(30) } },
      { id: 'b', candidate: 'c2', effect: { verdict: 'worse', measured_at: at(40) } },
    ],
    ledgerEntries: [
      { id: 'c1', first_ts: at(4), last_ts: at(50), status: 'resolved' },
      { id: 'c2', first_ts: at(10), last_ts: at(60), status: 'open' },
      { id: 'c3', first_ts: at(0), last_ts: at(70), status: 'warned' },
      { id: 'cold', first_ts: at(-900), last_ts: at(-800), status: 'resolved' }, // ngoai tuan
    ],
    effects: [
      { id: 'a', effect: { verdict: 'better', measured_at: at(30) } },
      { id: 'b', effect: { verdict: 'worse', measured_at: at(40) } },
      { id: 'x', effect: { verdict: 'insufficient', measured_at: at(41) } },
      { id: 'o', effect: { verdict: 'better', measured_at: at(-100) } }, // ngoai tuan
    ],
    processChanges: [{ ts: at(1), file: 'r.md' }, { ts: at(2), file: 'r.md' }, { ts: at(3), file: 's.md' }],
    signals: { sessions: 10, corrections: 3, interrupts: 2 },
    weekStartMs: W0, weekEndMs: W1,
  });
  assert.equal(m.self_initiated_rate.value, 2 / 5); // 2 apply ok / (2 + 3 commit)
  assert.equal(m.time_to_fix_h.value, 8); // [6, 10]
  assert.equal(m.time_to_verify_h.value, 28); // [26, 30]
  assert.equal(m.effective_rate.value, 1 / 2);
  assert.equal(m.rollback_rate.value, 1 / 2);
  assert.equal(m.repeat_correction_rate.value, 5 / 10);
  assert.equal(m.repeat_errors_resolved.value, 1 / 3);
  assert.equal(m.repeat_files.value, 1); // r.md sua 2 lan
  assert.equal(m.self_initiated_rate.better, 'up');
  assert.equal(m.time_to_fix_h.better, 'down');
  assert.equal(m.rollback_rate.better, 'down');
});

test('time_to_* bo gia tri am', () => {
  const m = selfdevMetrics({
    appliedLog: [{ ts: at(10), op: 'apply', id: 'a', ok: true }],
    proposals: [{ id: 'a', candidate: 'c1', effect: { measured_at: at(5) } }],
    ledgerEntries: [{ id: 'c1', first_ts: at(20), last_ts: at(20), status: 'open' }],
    weekStartMs: W0, weekEndMs: W1,
  });
  assert.equal(m.time_to_fix_h.value, null);
  assert.equal(m.time_to_verify_h.value, null);
});

test('repeat_files chi tinh sua >= 2 lan trong 14 ngay', () => {
  const old = new Date(W1 - 20 * 24 * H).toISOString();
  const m = selfdevMetrics({
    processChanges: [{ ts: old, file: 'a' }, { ts: at(1), file: 'a' }, { ts: at(2), file: 'b' }, { ts: at(3), file: 'b' }],
    weekStartMs: W0, weekEndMs: W1,
  });
  assert.equal(m.repeat_files.value, 1);
});

test('compositeDirection: map direction x better -> tot/xau; F3 >= 2 flat/xau', () => {
  const up = { direction: 'up', better: 'up' }, flat = { direction: 'flat', better: 'up' };
  const bad = { direction: 'down', better: 'up' }; // giam trong khi tot = tang
  const goodDown = { direction: 'down', better: 'down' };
  assert.equal(compositeDirection({ a: up, b: goodDown, c: up }), 'improving');
  assert.equal(compositeDirection({ a: up, b: up, c: bad }), 'worse'); // mot chi so xau
  assert.equal(compositeDirection({ a: up, b: up, c: flat }), 'improving'); // mot chi so ngang
  assert.equal(compositeDirection({ a: up, b: flat, c: flat }), 'flat');
  assert.equal(compositeDirection({ a: up, b: flat, c: bad }), 'worse');
  assert.equal(compositeDirection({ a: { direction: 'up', better: 'down' }, b: up }), 'worse');
  assert.equal(compositeDirection({}), 'flat');
});
