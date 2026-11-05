import { test, expect } from 'bun:test';
import { runCheckpoint } from './engine.mjs';

test('checkpoint: HookRun khong tinh la tool call loi', () => {
  const base = { session_id: 's', ts: '2026-11-05T00:00:00Z', actor: 'main' };
  const rows = [
    { ...base, type: 'hook', event: 'HookRun', ok: false, tool: 'Bash', target: 'x' },
    { ...base, type: 'tool', event: 'PostToolUse', ok: true, tool: 'Read', target: 'a' },
  ];
  const r = runCheckpoint(rows, [], {}, { truncated: null }, 'node');
  const errs = r.sections.find((s) => s.title === 'errors_and_unresolved').rows;
  expect(errs.length).toBe(0);
});
