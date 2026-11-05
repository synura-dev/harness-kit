import { test, expect } from 'bun:test';
import { evaluate } from './engine.mjs';

const ev = (extra) => ({ ts: new Date().toISOString(), sid: 's', actor: 'main', ...extra });

test('engine nguon audit bo HookRun (type=hook hoac event=HookRun)', () => {
  const def = { id: 'any', source: 'audit', days: 1, filter: { actor: 'main' }, metric: 'count', threshold: 1, action: 'log' };
  const events = [ev({ event: 'PostToolUse', tool: 'Bash' }), ev({ event: 'HookRun', type: 'hook' }), ev({ event: 'HookRun' }), ev({ type: 'hook', event: 'x' })];
  const f = evaluate(def, { events }, { hubDir: '/h', nowMs: Date.now() });
  expect(f.length).toBe(1);
  expect(f[0].count).toBe(1);
});
