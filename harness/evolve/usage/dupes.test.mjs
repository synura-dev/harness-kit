import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDupes } from './dupes.mjs';

const it = (kind, id, description) => ({ kind, id, description });

test('near-identical pair is warned, unrelated is not', () => {
  const r = findDupes([
    it('skill', 'a', 'Use when reviewing code changes for bugs'),
    it('skill', 'b', 'Dùng khi reviewing code changes for bugs!'),
    it('skill', 'c', 'Deploy server with pm2 restart'),
  ]);
  assert.equal(r.pairs.length, 1);
  assert.deepEqual([r.pairs[0].a, r.pairs[0].b], ['a', 'b']);
  assert.ok(r.pairs[0].score >= 0.7);
  assert.equal(r.truncated, null);
});

test('cross-kind never paired', () => {
  const r = findDupes([it('skill', 'a', 'review code changes'), it('agent', 'a', 'review code changes')]);
  assert.equal(r.pairs.length, 0);
});

test('top cap and max_items truncation', () => {
  const many = Array.from({ length: 5 }, (_, i) => it('skill', 's' + i, 'same words here'));
  assert.equal(findDupes(many, { top: 3 }).pairs.length, 3);
  const t = findDupes(many, { maxItems: 2 });
  assert.equal(t.truncated, 'max_items');
  assert.equal(t.pairs.length, 1);
});
