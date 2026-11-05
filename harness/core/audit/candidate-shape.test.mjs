import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureCandidates, validateCandidate } from './candidate-shape.mjs';

const ev = (i, sid) => ({ ts: `2026-11-0${i}T00:00:00Z`, sid, tool: 'Bash', ok: false, data: { tool: 'Bash', error: 'boom at C:\\x\\y.txt line 12' }, target: 'x' });
test('failureCandidates tra dung hop dong', () => {
  const c = failureCandidates([ev(1, 'a'), ev(2, 'b'), ev(3, 'b')], '2026-11-05T00:00:00Z');
  assert.equal(c.length, 1);
  assert.deepEqual(validateCandidate(c[0]), []);
  assert.equal(c[0].kind, 'error'); assert.equal(c[0].count, 3); assert.equal(c[0].sessions, 2);
  assert.equal(c[0].first_ts, '2026-11-01T00:00:00Z');
});
test('validateCandidate bat loi', () => {
  assert.ok(validateCandidate({ id: 'x' }).length > 0);
  assert.deepEqual(validateCandidate({ id: 'a', kind: 'pattern', fp: 'f', count: 1, sessions: 1, first_ts: null, last_ts: null, sample: '' }), []);
});
