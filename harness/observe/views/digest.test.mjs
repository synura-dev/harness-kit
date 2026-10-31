import { test, expect } from 'bun:test';
import { byAgentModel, renderDigest } from './digest.mjs';

const ag = (agent, id, model) => ({ session: 's', agent, agent_id: id, tools: 1, errors: 0, tin: 10, tout: 5, model, t0: null, t1: null });

test('byAgentModel + canh bao general-purpose >50%', () => {
  const aggs = [ag('main', 'main', 'opus'), ag('general-purpose', 'a', 'sonnet'), ag('general-purpose', 'b', 'sonnet'), ag('scout', 'c', 'haiku')];
  const r = byAgentModel(aggs);
  expect(r.total).toBe(3);
  expect(r.gp).toBe(2);
  expect(r.warn).toBe(true);
  const txt = renderDigest('2026-01-01', aggs);
  expect(txt).toContain('| general-purpose | sonnet | 2 | 20/10 |');
  expect(txt).toContain('CANH BAO: general-purpose');
});
test('khong canh bao khi <=50%', () => {
  const r = byAgentModel([ag('general-purpose', 'a', 'm'), ag('scout', 'b', 'm')]);
  expect(r.warn).toBe(false);
});
test('agyBash: ratio, replaceable, repeat', async () => {
  const { agyBash } = await import('./digest.mjs');
  const e = (tool, target, s = 's') => ({ cli: 'agy', event: 'PostToolUse', tool, target, session_id: s });
  const r = agyBash([e('Bash', 'git status'), e('Bash', 'git status'), e('Bash', 'Get-Content a.txt'), e('Read', 'x'), { ...e('Bash', 'git status'), cli: 'claude' }], 2);
  expect(r).toEqual({ tools: 4, bash: 3, replaceable: 1, repeat: 1, denied: 2, ratio: 75 });
  expect(renderDigest('2026-01-01', [], { agy: r })).toContain('agy bash ratio: 75% (3/4), replaceable: 1, repeat: 1, denied: 2');
});
