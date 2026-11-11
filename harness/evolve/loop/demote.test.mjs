import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { demoteRules, demoteRun, DEMOTE } from './demote.mjs';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const DAY = 86400000;
const iso = (d) => new Date(NOW - d * DAY).toISOString();
const entry = (fp, over = {}) => ({ id: `evolve-${fp}|${fp}`, rule: `evolve-${fp}`, fp, status: 'ignored', warn_count: 6, warn_ts: [1, 2, 3, 4, 5, 6].map((d) => iso(d)), ignored_count: 4, ignored: iso(1), ...over });
const rule = (fp, over = {}) => ({ applied_at: iso(30), pid: `p_${fp}`, ver: `v_${fp}`, fp, target: `evolve/rules/evolve-${fp}.json`, source: 'evolve', autopilot: true, ...over });

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

test('2 entry cung fp: entry nguon khong tinh, entry cua rule chua canh bao -> khong rollback', () => {
  const src = entry('a', { id: 'src|a', rule: 'src' });
  const mine = entry('a', { warn_ts: [], warn_count: 0, ignored_count: 0, ignored: undefined });
  assert.deepEqual(demoteRules({ ledgerEntries: [src, mine], rules: [rule('a')], nowMs: NOW }), []);
});
test('chi dem su kien SAU applied_at; ignored bi chan <= warned', () => {
  const e = entry('a', { warn_ts: [1, 2, 3, 4, 5, 6].map(iso), ignored_count: 99 });
  assert.equal(demoteRules({ ledgerEntries: [e], rules: [rule('a', { applied_at: iso(3.5) })], nowMs: NOW }).length, 0);
  assert.equal(demoteRules({ ledgerEntries: [e], rules: [rule('a')], nowMs: NOW })[0].ignored, 6);
});
test('demoteRun: rule kept van xet; rollback xong cap nhat state.applied, lan sau khong rollback lai', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demote-'));
  try {
    const sf = path.join(tmp, 'evo', 'autopilot', 'state.json');
    fs.mkdirSync(path.dirname(sf), { recursive: true });
    fs.writeFileSync(sf, JSON.stringify({ applied: [{ pid: 'p_a', ver: 'v_a', fp: 'a', status: 'kept', target: 'evolve/rules/evolve-a.json', ts: iso(30) }] }));
    const calls = [];
    const o = { dataRoot: path.join(tmp, 'evo'), hubRoot: tmp, stateFile: path.join(tmp, 'd.json'), nowMs: NOW, ledgerEntries: [entry('a')], rollbackFn: (v) => { calls.push(v); return { ok: true }; }, logFn: () => {} };
    assert.equal(demoteRun(o).rolledBack.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(sf, 'utf8')).applied[0].status, 'rolled_back');
    assert.equal(demoteRun({ ...o, nowMs: NOW + 25 * 3600e3 }).rolledBack.length, 0);
    assert.deepEqual(calls, ['v_a']);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
