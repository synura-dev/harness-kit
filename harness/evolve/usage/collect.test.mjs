import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countEvents, filterMaintenance } from './collect.mjs';

const ev = (o) => ({ kind: 'skill', id: 'a', ts: 1000, session: 's1', project: 'p', channel: 'tool', origin: 'audit', ...o });

test('sessions distinct and count', () => {
  const r = countEvents([ev({ session: 's1' }), ev({ session: 's1' }), ev({ session: 's2' })]);
  const it = r.items.get('skill:a');
  assert.equal(it.count, 3);
  assert.equal(it.sessions, 2);
});

test('last_ts is max, first_ts min, unordered', () => {
  const it = countEvents([ev({ ts: 300 }), ev({ ts: 900 }), ev({ ts: 100 })]).items.get('skill:a');
  assert.equal(it.last_ts, 900);
  assert.equal(it.first_ts, 100);
});

test('window per origin', () => {
  const r = countEvents([ev({ ts: 500 }), ev({ ts: 200 }), ev({ ts: 700, origin: 'transcript' })]);
  assert.deepEqual(r.window.audit, { earliest: 200, latest: 500, n: 2 });
  assert.deepEqual(r.window.transcript, { earliest: 700, latest: 700, n: 1 });
});

test('missing session not counted', () => {
  const it = countEvents([ev({ session: undefined }), ev({ session: '' }), ev({ session: 's9' })]).items.get('skill:a');
  assert.equal(it.count, 3);
  assert.equal(it.sessions, 1);
});

test('channels and projects maps', () => {
  const it = countEvents([ev({ project: 'x' }), ev({ project: 'x', channel: 'slash' }), ev({ project: 'y' })]).items.get('skill:a');
  assert.deepEqual(it.channels, { tool: 2, slash: 1 });
  assert.deepEqual(it.projects, { x: 2, y: 1 });
});

test('dedupe by callId across origins', () => {
  const r = countEvents([
    ev({ callId: 'c1' }), ev({ callId: 'c1', origin: 'transcript' }),
    ev({}), ev({}),
  ]);
  assert.equal(r.items.get('skill:a').count, 3);
  assert.equal(r.duplicates_dropped, 1);
});

const rd = (file, o = {}) => ev({ channel: 'read', file, turn: 1, ...o });
const reads = (n, o) => Array.from({ length: n }, (_, i) => rd('f' + i + '.md', o));

test('maintenance: 5 distinct reads dropped', () => {
  const r = filterMaintenance(reads(5));
  assert.equal(r.kept.length, 0);
  assert.equal(r.maintenance_dropped, 5);
});

test('maintenance: 4 reads kept', () => {
  const r = filterMaintenance(reads(4));
  assert.equal(r.kept.length, 4);
  assert.equal(r.maintenance_dropped, 0);
});

test('maintenance: tool/slash/preload in same turn never dropped', () => {
  const r = filterMaintenance([...reads(5), ev({ turn: 1 }), ev({ turn: 1, channel: 'slash' }), ev({ turn: 1, channel: 'preload' })]);
  assert.equal(r.kept.length, 3);
  assert.equal(r.maintenance_dropped, 5);
});

test('maintenance: threshold configurable, groups by session+turn, distinct files', () => {
  assert.equal(filterMaintenance(reads(3), { threshold: 3 }).maintenance_dropped, 3);
  assert.equal(filterMaintenance([...reads(3), ...reads(2, { session: 's2' })]).maintenance_dropped, 0);
  const same = Array.from({ length: 6 }, () => rd('same.md'));
  assert.equal(filterMaintenance(same).maintenance_dropped, 0);
});
