import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, componentCost, costPerUse, rankByCost } from './cost.mjs';

test('estimateTokens = ceil(chars/4)', () => {
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens(''), 0);
});
test('skill/agent: desc from frontmatter, body separate', () => {
  const c = componentCost({ kind: 'skill', body: '---\nname: x\ndescription: "abcdefgh"\n---\n12345678' });
  assert.deepEqual(c, { desc_tokens: 2, body_tokens: 2 });
});
test('command uses given description; hook is 0/0; rule whole text as desc', () => {
  assert.deepEqual(componentCost({ kind: 'command', description: 'abcd', body: '12345678' }), { desc_tokens: 1, body_tokens: 2 });
  assert.deepEqual(componentCost({ kind: 'hook', description: 'zzzz', body: 'zzzz' }), { desc_tokens: 0, body_tokens: 0 });
  assert.deepEqual(componentCost({ kind: 'rule', body: 'abcdefgh' }), { desc_tokens: 2, body_tokens: 0 });
});
test('costPerUse formula, 0 uses safe', () => {
  assert.equal(costPerUse({ desc_tokens: 10, body_tokens: 100 }, { count: 4, sessions: 8 }), (10 * 8 + 100 * 4) / 4);
  assert.equal(costPerUse({ desc_tokens: 10, body_tokens: 100 }, { count: 0, sessions: 5 }), 50);
});
test('rankByCost desc; 0-use ranked by desc_tokens', () => {
  const items = [
    { id: 'a', desc_tokens: 5, body_tokens: 0, count: 0, sessions: 3 },
    { id: 'b', desc_tokens: 9, body_tokens: 0, count: 0, sessions: 3 },
    { id: 'c', desc_tokens: 1, body_tokens: 100, count: 2, sessions: 3 },
  ];
  assert.deepEqual(rankByCost(items).map((i) => i.id), ['c', 'b', 'a']);
});
