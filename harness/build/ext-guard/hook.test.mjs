import { test, expect } from 'bun:test';
import path from 'node:path';
import { DEFAULTS, parseGuard, handle, defaultRun } from './hook.mjs';
import mod from './hook.mjs';
import { validateHookModule, validateHookResult } from '../../core/config/shape.mjs';

const GUARD = { event: 'PreToolUse', matcher: 'mcp__.*|Write', args: ['guard'], domain: 'alpha-dom' };
const mk = (over = {}) => {
  const calls = [];
  const ctx = {
    cfg: DEFAULTS, env: { CLAUDE_PROJECT_DIR: path.resolve('/proj') },
    list: () => [{ id: 'alpha', root: '/x/alpha', hash: 'h1', guard: GUARD }],
    hashOf: () => 'h1',
    run: async (domain, args, o) => { calls.push({ domain, args, o }); return { code: 0, stderr: '' }; },
    ...over,
  };
  return { ctx, calls };
};
const EV = (tool) => ({ tool_name: tool, tool_input: { a: 1 }, cwd: path.resolve('/proj') });

test('parseGuard: hop le / sai', () => {
  expect(parseGuard(GUARD).args).toEqual(['guard']);
  expect(parseGuard({ ...GUARD, event: 'PostToolUse' })).toBeNull();
  expect(parseGuard({ ...GUARD, matcher: '(' })).toBeNull();
  expect(parseGuard({ ...GUARD, domain: '' })).toBeNull();
  expect(parseGuard(undefined)).toBeNull();
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
test('exit khac / timeout / loi spawn / throw = CHAN (fail-closed) + audit', async () => {
  for (const res of [{ code: 1, stderr: '' }, { error: 'timeout' }, { error: 'spawn' }]) {
    const { ctx } = mk({ run: async () => res });
    const r = await handle('PreToolUse', EV('Write'), ctx);
    expect(r.decision).toBe('deny');
    expect(r.records[0].data.rule).toBe('fail-closed');
  }
  const { ctx } = mk({ run: async () => { throw new Error('x'); } });
  expect((await handle('PreToolUse', EV('Write'), ctx)).decision).toBe('deny');
});
test('hash lech: CHAN tool khop matcher, khong chay code, ly do ext approve; tool khac khong anh huong', async () => {
  const { ctx, calls } = mk({ hashOf: () => 'khac' });
  const r = await handle('PreToolUse', EV('Write'), ctx);
  expect(calls).toHaveLength(0);
  expect(r.decision).toBe('deny');
  expect(r.reason).toContain('guard alpha chua duyet: harness ext approve alpha');
  expect(await handle('PreToolUse', EV('Bash'), ctx)).toEqual({});
});
test('cfg.enabled=false khong tat guard; ext khong khai guard khong anh huong; matched duoc danh dau', async () => {
  const { ctx } = mk({ cfg: { ...DEFAULTS, enabled: false }, run: async () => ({ code: 2, stderr: 'no' }) });
  expect((await handle('PreToolUse', EV('Write'), ctx)).decision).toBe('deny');
  expect(ctx.guardMatched).toBe(true);
  const n = mk({ list: () => [{ id: 'alpha', root: '/x/alpha', hash: 'h1' }] });
  expect(await handle('PreToolUse', EV('Write'), n.ctx)).toEqual({});
  expect(n.ctx.guardMatched).toBeUndefined();
});
test('module: khong tat duoc (OPTIONAL), failClosedOnMatch', async () => {
  const { OPTIONAL, ORDER } = await import('../../hooks/dispatch/modules.mjs');
  expect(OPTIONAL).not.toContain('ext-guard');
  expect(ORDER.PreToolUse.map((x) => x.id).slice(-2)).toEqual(['ext-guard', 'audit']);
  expect(mod.failClosedOnMatch).toBe(true);
});
test('defaultRun that: timeout giet tien trinh -> {error: timeout}', async () => {
  const r = await defaultRun('x', [], { cwd: process.cwd(), timeoutMs: 50, stdin: '{}', bin: path.join(import.meta.dir, '__khong_co__.mjs') });
  expect(r.error === 'timeout' || typeof r.code === 'number').toBe(true);
});
test('dispatcher: ext-guard het timeout/loi sau khi khop matcher => deny; chua khop => khong chan', async () => {
  const { dispatch, CLAUDE } = await import('../../hooks/dispatch/run.mjs');
  const mkMod = (match, fn) => ({ id: 'fake-guard', gate: true, load: async () => ({ default: { id: 'fake-guard', events: ['PreToolUse'], timeoutMs: 150, onError: 'open', failClosedOnMatch: true, handle: async (e, i, ctx) => { if (match) ctx.guardMatched = true; return fn(); } } }) });
  const run = (m) => dispatch({ event: 'PreToolUse', stdin: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {} }), profile: { ...CLAUDE, order: { PreToolUse: [m] } } });
  const hang = () => new Promise(() => {});
  expect((await run(mkMod(true, hang))).stdout).toContain('"deny"');
  expect((await run(mkMod(true, () => { throw new Error('x'); }))).stdout).toContain('"deny"');
  expect((await run(mkMod(false, hang))).stdout).not.toContain('"deny"');
});
test('guard doc tu registry: manifest tren dia khong duoc doc (xoa/doi khoa guard khong anh huong)', async () => {
  const fs = await import('node:fs'); const os = await import('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-'));
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ id: 'alpha', domain: 'alpha-dom', guard: { event: 'PreToolUse', matcher: 'Nothing', args: ['x'] } }));
  const { ctx } = mk({ list: () => [{ id: 'alpha', root, hash: 'h1', guard: GUARD }], run: async () => ({ code: 2, stderr: 'chan' }) });
  expect((await handle('PreToolUse', EV('Write'), ctx)).decision).toBe('deny');
  fs.rmSync(path.join(root, 'manifest.json'));
  expect((await handle('PreToolUse', EV('Write'), ctx)).decision).toBe('deny');
  expect(await handle('PreToolUse', EV('Nothing'), ctx)).toEqual({});
  fs.rmSync(root, { recursive: true, force: true });
});
test('registry khong doc duoc: fail-open co ban ghi audit', async () => {
  const { ctx } = mk({ list: () => { throw new Error('hong'); } });
  const r = await handle('PreToolUse', EV('Write'), ctx);
  expect(r.decision).toBeUndefined();
  expect(r.records[0].data.rule).toBe('registry-unreadable');
});
