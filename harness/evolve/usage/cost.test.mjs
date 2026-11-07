import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { estimateTokens, componentCost, costPerUse, rankByCost, windowCost, projectFolder, scopeSessions } from './cost.mjs';

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
test('rankByCost by windowCost desc, costPerUse secondary', () => {
  const items = [
    { id: 'a', desc_tokens: 5, body_tokens: 0, count: 0 },
    { id: 'b', desc_tokens: 9, body_tokens: 0, count: 0 },
    { id: 'c', desc_tokens: 1, body_tokens: 100, count: 2 },
  ];
  const r = rankByCost(items, { totalSessions: 3 });
  assert.deepEqual(r.map((i) => i.id), ['c', 'b', 'a']);
  assert.equal(r[0].windowCost, 203); assert.equal(r[0].costPerUse, 203 / 2);
});

test('projectFolder encodes like Claude (non-alnum -> -)', () => {
  if (process.platform === 'win32') assert.equal(projectFolder('E:\\11. Agents'), 'E--11--Agents');
  assert.match(projectFolder('/a/b c.d'), /^[A-Za-z0-9-]+$/);
});
test('scopeSessions: project -> own folder; plugin -> installed projects (user scope = all); others = all', () => {
  const D = path.resolve('/zz/hub'), P2 = path.resolve('/zz/two');
  const base = { total: 10, byProject: { [projectFolder(D)]: 4, [projectFolder(P2)]: 3 }, projectDir: D };
  assert.equal(scopeSessions({ source: 'project' }, base), 4);
  assert.equal(scopeSessions({ source: 'project' }, { ...base, projectDir: path.resolve('/nope') }), 0);
  const inst = (e) => ({ plugins: { 'pl@m': e } });
  assert.equal(scopeSessions({ source: 'plugin', plugin: 'pl' }, { ...base, installed: inst([{ scope: 'project', projectPath: P2 }]) }), 3);
  assert.equal(scopeSessions({ source: 'plugin', plugin: 'pl' }, { ...base, installed: inst([{ scope: 'project', projectPath: P2 }, { scope: 'project', projectPath: D }]) }), 7);
  assert.equal(scopeSessions({ source: 'plugin', plugin: 'pl' }, { ...base, installed: inst([{ scope: 'user' }]) }), 10);
  for (const s of ['account', 'builtin', 'third_party', 'unknown']) assert.equal(scopeSessions({ source: s }, base), 10);
});

test('windowCost = desc*totalSessions + body*count', () => {
  assert.equal(windowCost({ desc_tokens: 10, body_tokens: 100 }, { count: 4, totalSessions: 50 }), 10 * 50 + 400);
});
test('componentCost handles BOM and multi-line description', () => {
  const c = componentCost({ kind: 'skill', body: '\uFEFF---\nname: x\ndescription: >-\n  abcd\n  efgh\n---\nbody' });
  assert.equal(c.desc_tokens, estimateTokens('abcd efgh'));
});

test('scopeSessions: project folder lookup is case-insensitive (sums keys)', () => {
  const D = path.resolve('/zz/hub');
  const f = projectFolder(D);
  assert.equal(scopeSessions({ source: 'project' }, { total: 9, byProject: { [f.toUpperCase()]: 2, [f.toLowerCase()]: 3 }, projectDir: D }), 5);
  assert.equal(scopeSessions({ source: 'plugin', plugin: 'pl' }, { total: 9, byProject: { [f.toUpperCase()]: 4 }, installed: { plugins: { 'pl@m': [{ scope: 'project', projectPath: D }] } } }), 4);
});
