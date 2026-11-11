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
  const z = selfdevMetrics({ signals: { sessions: 0, corrections: 0, interrupts: 0 }, weekStartMs: W0, weekEndMs: W1 });
  assert.equal(z.repeat_correction_rate.value, null);
});

test('cong thuc spec 4.5', () => {
  const m = selfdevMetrics({
    appliedLog: [
      { id: 'a', ts: at(10), status: 'applied' },
      { id: 'b', ts: at(20), status: 'rolled_back' },
      { id: 'old', ts: new Date(W0 - 5 * H).toISOString(), status: 'applied' },
    ],
    proposals: [
      { id: 'a', candidate: 'c1', effect: { verdict: 'better', measured_at: at(30) } },
      { id: 'b', candidate: 'c2', effect: { verdict: 'worse', measured_at: at(40) } },
    ],
    ledgerEntries: [
      { id: 'c1', first_ts: at(4), status: 'resolved' },
      { id: 'c2', first_ts: at(10), status: 'open' },
      { id: 'c3', first_ts: at(0), status: 'warned' },
    ],
    effects: [{ id: 'a', effect: { verdict: 'better' } }, { id: 'b', effect: { verdict: 'worse' } }, { id: 'x', effect: { verdict: 'insufficient' } }],
    processChanges: [{ ts: at(1), file: 'r.md' }, { ts: at(2), file: 'r.md' }, { ts: at(3), file: 's.md' }],
    signals: { sessions: 10, corrections: 3, interrupts: 2 },
    weekStartMs: W0, weekEndMs: W1,
  });
  assert.equal(m.self_initiated_rate.value, 2 / 5);
  assert.equal(m.time_to_fix_h.value, 8); // [6, 10]
  assert.equal(m.time_to_verify_h.value, 28); // [26, 30]
  assert.equal(m.effective_rate.value, 1 / 2); // insufficient khong tinh
  assert.equal(m.rollback_rate.value, 1 / 2);
  assert.equal(m.repeat_correction_rate.value, 5 / 10);
  assert.equal(m.repeat_errors_resolved.value, 1 / 3);
  assert.equal(m.self_initiated_rate.better, 'up');
  assert.equal(m.time_to_fix_h.better, 'down');
  assert.equal(m.rollback_rate.better, 'down');
});

test('compositeDirection: >= 2 chi so xau/ngang', () => {
  const t = (over) => ({ a: 'up', b: 'up', c: 'up', ...over });
  assert.equal(compositeDirection(t({})), 'improving');
  assert.equal(compositeDirection(t({ a: 'flat', b: 'worse' })), 'worse');
  assert.equal(compositeDirection(t({ a: 'flat', b: 'flat' })), 'flat');
  assert.equal(compositeDirection(t({ a: 'worse' })), 'improving');
  assert.equal(compositeDirection({}), 'flat');
});
