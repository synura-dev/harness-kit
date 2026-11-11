import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { demoteRules, demoteRun, DEMOTE } from './demote.mjs';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const DAY = 86400000;
const iso = (d) => new Date(NOW - d * DAY).toISOString();
const entry = (fp, over = {}) => ({ id: `r|${fp}`, fp, status: 'ignored', warn_count: 6, warn_ts: [1, 2, 3, 4, 5, 6].map((d) => iso(d)), ignored_count: 4, ignored: iso(1), ...over });
const rule = (fp, over = {}) => ({ pid: `p_${fp}`, ver: `v_${fp}`, fp, target: `evolve/rules/evolve-${fp}.json`, source: 'evolve', autopilot: true, ...over });

test('autopilot-applied warned 6 acted 0 ignored 4 -> rollback', () => {
  const r = demoteRules({ ledgerEntries: [entry('a')], rules: [rule('a')], nowMs: NOW });
  assert.deepEqual(r.map((x) => [x.action, x.ver]), [['rollback', 'v_a']]);
});
test('rule khong do autopilot -> chi suggest', () => {
  const r = demoteRules({ ledgerEntries: [entry('a')], rules: [rule('a', { autopilot: false })], nowMs: NOW });
  assert.equal(r[0].action, 'suggest');
});
test('protected / mac dinh plugin / rule du an -> bo qua', () => {
  const rules = [rule('a', { protected: true }), rule('b', { source: 'plugin' }), rule('c', { source: 'project' }), rule('d', { target: '.harness/rules/x.json' }), rule('e', { target: 'harness/core/guard/x.json' })];
  const es = ['a', 'b', 'c', 'd', 'e'].map((f) => entry(f));
  assert.deepEqual(demoteRules({ ledgerEntries: es, rules, nowMs: NOW }), []);
});
test('warned 4 / acted > 0 / ignored thap / ngoai cua so -> khong lam gi', () => {
  const es = [entry('a', { warn_ts: [1, 2, 3, 4].map(iso) }), entry('b', { acted: iso(2) }), entry('c', { ignored_count: 1 }), entry('d', { warn_ts: [20, 21, 22, 23, 24, 25].map(iso) })];
  const rules = ['a', 'b', 'c', 'd'].map((f) => rule(f));
  assert.deepEqual(demoteRules({ ledgerEntries: es, rules, nowMs: NOW }), []);
});
test('tran 10 rule/lan', () => {
  const fps = Array.from({ length: 15 }, (_, i) => `f${i}`);
  const r = demoteRules({ ledgerEntries: fps.map((f) => entry(f)), rules: fps.map((f) => rule(f)), nowMs: NOW });
  assert.equal(r.length, DEMOTE.maxPerRun);
});

test('demoteRun: rollback stub, guard 24h, suggest ghi log', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demote-'));
  try {
    const calls = [];
    const logs = [];
    const o = { stateFile: path.join(tmp, 'demote-state.json'), nowMs: NOW, ledgerEntries: [entry('a'), entry('b')], rules: [rule('a'), rule('b', { autopilot: false })], rollbackFn: (ver) => { calls.push(ver); return { ok: true }; }, logFn: (rec) => logs.push(rec) };
    const r1 = demoteRun(o);
    assert.deepEqual(calls, ['v_a']);
    assert.equal(r1.rolledBack.length, 1);
    assert.equal(logs.find((l) => l.op === 'demote_suggested').id, 'p_b');
    const r2 = demoteRun({ ...o, nowMs: NOW + 3600e3 });
    assert.equal(r2.skipped, 'guard-24h');
    assert.deepEqual(calls, ['v_a']);
    const r3 = demoteRun({ ...o, nowMs: NOW + 25 * 3600e3 });
    assert.equal(r3.skipped, undefined);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
