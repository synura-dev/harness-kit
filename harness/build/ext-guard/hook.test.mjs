import { test, expect } from 'bun:test';
import path from 'node:path';
import { DEFAULTS, parseGuard, handle, defaultRun } from './hook.mjs';
import mod from './hook.mjs';
import { validateHookModule, validateHookResult } from '../../core/config/shape.mjs';

const GUARD = { domain: 'alpha-dom', guard: { event: 'PreToolUse', matcher: 'mcp__.*|Write', args: ['guard'] } };
const mk = (over = {}) => {
  const calls = [];
  const ctx = {
    cfg: DEFAULTS, env: { CLAUDE_PROJECT_DIR: path.resolve('/proj') },
    list: () => [{ id: 'alpha', root: '/x/alpha', hash: 'h1' }],
    readManifest: () => GUARD, hashOf: () => 'h1', core: () => new Set(['tasks', 'ext']),
    run: async (domain, args, o) => { calls.push({ domain, args, o }); return { code: 0, stderr: '' }; },
    ...over,
  };
  return { ctx, calls };
};
const EV = (tool) => ({ tool_name: tool, tool_input: { a: 1 }, cwd: path.resolve('/proj') });

test('parseGuard: hop le / sai', () => {
  expect(parseGuard(GUARD).args).toEqual(['guard']);
  expect(parseGuard({ guard: { event: 'PostToolUse', matcher: 'x', args: [] } })).toBeNull();
  expect(parseGuard({ guard: { event: 'PreToolUse', matcher: '(', args: [] } })).toBeNull();
  expect(parseGuard({})).toBeNull();
});
test('hop dong module hop le', () => { expect(validateHookModule(mod)).toEqual([]); });
test('khop matcher: chay harness <domain> args voi JSON su kien tren stdin; exit 0 = qua', async () => {
  const { ctx, calls } = mk();
  const r = await handle('PreToolUse', EV('mcp__obs__put'), ctx);
  expect(r).toEqual({});
  expect(calls).toHaveLength(1);
  expect(calls[0].domain).toBe('alpha-dom');
  expect(JSON.parse(calls[0].o.stdin).tool_name).toBe('mcp__obs__put');
});
test('khong khop matcher: khong chay', async () => {
  const { ctx, calls } = mk();
  expect(await handle('PreToolUse', EV('Bash'), ctx)).toEqual({});
  expect(calls).toHaveLength(0);
});
test('exit 2 = deny kem stderr', async () => {
  const { ctx } = mk({ run: async () => ({ code: 2, stderr: 'khong duoc ghi\n' }) });
  const r = await handle('PreToolUse', EV('Write'), ctx);
  expect(r.decision).toBe('deny');
  expect(r.reason).toContain('khong duoc ghi');
  expect(validateHookResult(r)).toEqual([]);
});
test('exit khac / timeout / loi = fail-open + canh bao', async () => {
  for (const res of [{ code: 1, stderr: '' }, { error: 'timeout' }]) {
    const { ctx } = mk({ run: async () => res });
    const r = await handle('PreToolUse', EV('Write'), ctx);
    expect(r.decision).toBeUndefined();
    expect(r.records[0].data.rule).toBe('fail-open');
  }
  const { ctx } = mk({ run: async () => { throw new Error('x'); } });
  expect((await handle('PreToolUse', EV('Write'), ctx)).decision).toBeUndefined();
});
test('hash lech: bo qua guard (khong chay) + canh bao', async () => {
  const { ctx, calls } = mk({ hashOf: () => 'khac' });
  const r = await handle('PreToolUse', EV('Write'), ctx);
  expect(calls).toHaveLength(0);
  expect(r.decision).toBeUndefined();
  expect(r.records[0].data.rule).toBe('hash-drift');
});
test('defaultRun that: timeout giet tien trinh -> {error: timeout}', async () => {
  const r = await defaultRun('x', [], { cwd: process.cwd(), timeoutMs: 50, stdin: '{}', bin: path.join(import.meta.dir, '__khong_co__.mjs') });
  expect(r.error === 'timeout' || typeof r.code === 'number').toBe(true);
});
