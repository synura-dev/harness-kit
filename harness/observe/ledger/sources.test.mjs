import { test, expect } from 'bun:test';
import { loadDefinitions, evaluateAll } from './engine.mjs';
import { patternSource, registeredExtRoots } from './sources.mjs';

const ev = (sid, i, cmd) => ({ event: 'PostToolUse', ts: new Date(Date.now() - i * 1000).toISOString(), sid, tool: 'Bash', target: cmd, ok: true });

test('patternSource: dung ignore tu luat; thieu luat -> []', () => {
  const events = [];
  for (let s = 0; s < 4; s++) for (let i = 0; i < 4; i++) { events.push(ev('s' + s, i, 'bun test x.test.mjs')); events.push(ev('s' + s, i, 'git diff')); events.push(ev('s' + s, i, 'node a.mjs')); events.push(ev('s' + s, i, 'git add .')); }
  const { defs } = loadDefinitions();
  const items = patternSource(events, '', { defs });
  const sigs = items.map((x) => x.sample + x.fp).join(' ');
  expect(items.some((x) => /bun test.*git add/.test(x.sample))).toBe(true);
  expect(/git diff|node a/.test(sigs)).toBe(false);
  expect(patternSource(events, '', { defs: [] })).toEqual([]);
});

test('luat cap/deprecate/repeated-pattern: kind khop, action dung', () => {
  const { defs } = loadDefinitions();
  const by = Object.fromEntries(defs.map((d) => [d.id, d]));
  expect(by['repeated-pattern'].action).toBe('report');
  expect(by.deprecate.action).toBe('report');
  expect(by.cap.action).toBe('warn');
  expect(by.cap.cooldown_hours).toBe(168);
  const cands = [{ kind: 'cap', fp: 'cap:hook', count: 20, sample: 'hook: 20 > tran 15' }, { kind: 'deprecate', fp: 'command:x.y', count: 0, status: 'pending', sample: 'a' }, { kind: 'deprecate', fp: 'command:x.z', count: 0, status: 'propose_remove', sample: 'b' }];
  const f = evaluateAll(defs, { candidates: cands }, { hubDir: '/h', nowMs: Date.now() }, ['candidates']);
  expect(f.filter((x) => x.rule === 'cap').length).toBe(1);
  expect(f.filter((x) => x.rule === 'deprecate').map((x) => x.fp)).toEqual(['command:x.z']);
});

test('registeredExtRoots: loi/khong co -> mang', () => {
  expect(Array.isArray(registeredExtRoots('/khong/ton/tai'))).toBe(true);
});
