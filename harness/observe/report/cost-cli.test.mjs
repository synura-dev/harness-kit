import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSections, evaluateSection } from './engine.mjs';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const e = (o) => ({ ts: ago(1), event: 'PostToolUse', tool: 'Bash', ok: true, ...o });

test('cost-cli: hang theo cli (claude/agy) voi token, loi, ms, dung bat thuong', () => {
  const def = loadSections({ projectDir: null }).sections.find((s) => s.id === 'cost-cli');
  assert.ok(def, 'thieu muc cost-cli');
  assert.deepEqual(def.group_by, ['cli']);
  const events = [
    e({ cli: 'claude', sid: 'c1', dur_ms: 100 }),
    e({ cli: 'claude', sid: 'c1', event: 'Stop', tool: undefined, data: { usage: { input: 10, output: 5, cache_read: 7 } } }),
    e({ cli: 'agy', sid: 'a1', ok: false, dur_ms: 200 }),
    e({ cli: 'agy', sid: 'a1', dur_ms: 50 }),
    e({ cli: 'agy', sid: 'a1', event: 'Stop', tool: undefined, data: { usage: { input: 100, output: 20, cache_read: 40, tool_ms: 3000 }, stop_reason: 'MAX_INVOCATIONS' } }),
    e({ cli: 'agy', sid: 'a2', event: 'Stop', tool: undefined, data: { usage: { input: 1, output: 2, cache_read: 3 }, stop_reason: 'STOP' } }),
  ];
  const r = evaluateSection(def, { events }, { nowMs: NOW });
  const row = (k) => Object.fromEntries(r.cols.map((c, i) => [c, r.rows.find((x) => x.key === k).vals[i]]));
  assert.equal(r.rows.length, 2);
  const c = row('claude'), a = row('agy');
  assert.equal(c.phien, 1); assert.equal(c['su kien'], 2); assert.equal(c['token vao'], 10); assert.equal(c['token ra'], 5);
  assert.equal(c['cache doc'], 7); assert.equal(c.loi, 0); assert.equal(c.ms, 100); assert.equal(c['dung bat thuong'], 0);
  assert.equal(a.phien, 2); assert.equal(a['su kien'], 4); assert.equal(a['token vao'], 101); assert.equal(a['token ra'], 22);
  assert.equal(a['cache doc'], 43); assert.equal(a.loi, 1); assert.equal(a.ms, 250); assert.equal(a['ms tool (transcript)'], 3000); assert.equal(c['ms tool (transcript)'], 0); assert.equal(a['dung bat thuong'], 1);
});
