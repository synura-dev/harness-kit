// Don vi: merge/render (thuan) + dispatch() voi module gia (module nem, timeout, closed, chuoi updatedInput, deny cat gate, ket qua sai).
import { test, expect } from 'bun:test';
import { mergeResults, render, applyUpdate } from './merge.mjs';
import { dispatch, CLAUDE } from './run.mjs';
import { ORDER, applies } from './modules.mjs';
import { validateHookModule } from '../../core/config/shape.mjs';
import { renderAgy, AGY_ORDER } from './agy.mjs';

const mod = (id, over = {}) => ({ id, events: ['PreToolUse'], timeoutMs: 100, onError: 'open', handle: async () => ({}), ...over });
const entry = (m, gate = false) => ({ id: m.id, gate, load: async () => ({ default: m }) });
const profile = (...entries) => ({ ...CLAUDE, order: { PreToolUse: entries } });
const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } });
const cfg = { maxInputBytes: 1000000, budgetsMs: { PreToolUse: 1500 } };
const run = (p, stdin = input) => dispatch({ event: 'PreToolUse', stdin, cfg, profile: p });

test('merge: deny > ask > allow, updatedInput bo khi deny, context noi, block', () => {
  const m = mergeResults([{ id: 'a', result: { decision: 'allow', reason: 'ra', updatedInput: { x: 1 } } }, { id: 'b', result: { decision: 'ask', reason: 'rb' } }, { id: 'c', result: { additionalContext: 'c1' } }, { id: 'd', result: { additionalContext: 'c2' } }]);
  expect(m.decision).toBe('ask'); expect(m.reason).toBe('rb'); expect(m.updatedInput).toEqual({ x: 1 }); expect(m.additionalContext).toBe('c1\n\nc2');
  const d = mergeResults([{ id: 'a', result: { updatedInput: { x: 1 } } }, { id: 'b', result: { decision: 'deny', reason: 'no' } }, { id: 'c', result: { decision: 'deny', reason: 'no2' } }]);
  expect(d.decision).toBe('deny'); expect(d.updatedInput).toBeUndefined(); expect(d.reason).toBe('no | no2');
  expect(mergeResults([]).decision).toBeUndefined();
  expect(applyUpdate({ tool_input: { a: 1 }, k: 2 }, { b: 2 })).toEqual({ tool_input: { b: 2 }, k: 2 });
});

test('render: dung dinh dang tung su kien', () => {
  const j = (ev, m) => JSON.parse(render(ev, mergeResults(m)).stdout);
  expect(j('PreToolUse', [{ id: 'a', result: { updatedInput: { t: 1 } } }])).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { t: 1 } } });
  expect(j('PreToolUse', [{ id: 'a', result: { decision: 'deny', reason: 'r' } }]).hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'r' });
  expect(j('PreToolUse', [])).toEqual({});
  expect(j('UserPromptSubmit', [{ id: 'a', result: { additionalContext: 'ctx' } }])).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'ctx' } });
  expect(j('Stop', [{ id: 'v', result: { decision: 'deny', block: true, reason: 'chua test' } }])).toEqual({ decision: 'block', reason: 'chua test' });
  expect(j('Stop', [{ id: 'v', result: { decision: 'allow', block: false } }])).toEqual({});
  expect(render('WorktreeCreate', mergeResults([{ id: 'w', result: { record: { path: '/p' } } }]))).toEqual({ stdout: '/p', stderr: '', code: 0 });
  expect(render('WorktreeCreate', mergeResults([])).code).toBe(1);
  expect(render('WorktreeCreate', mergeResults([{ id: 'w', result: { decision: 'deny', block: true, reason: 'worktree create loi: x' } }])).stderr).toBe('worktree create loi: x\n');
  expect(render('WorktreeRemove', mergeResults([]))).toEqual({ stdout: '', stderr: '', code: 0 });
});

test('bang module: moi event co module hop le, tools loc dung', async () => {
  for (const [ev, list] of Object.entries(ORDER)) {
    for (const e of list) {
      const m = (await e.load()).default;
      expect(validateHookModule(m), `${ev}/${e.id}`).toEqual([]);
      expect(m.events, `${ev}/${e.id}`).toContain(ev);
    }
  }
  const guard = (await ORDER.PreToolUse[0].load()).default;
  expect(applies(guard, 'PreToolUse', { tool_name: 'Bash' })).toBe(true);
  expect(applies(guard, 'PreToolUse', { tool_name: 'Read' })).toBe(false);
  expect(applies(guard, 'Stop', { tool_name: 'Bash' })).toBe(false);
});

test('module nem / timeout (open) -> bo qua, module sau van chay, vet chi co id + loai loi', async () => {
  const boom = mod('boom', { handle: async () => { throw new Error('SECRET-CMD-xyz'); } });
  const slow = mod('slow', { timeoutMs: 30, handle: () => new Promise((r) => setTimeout(() => r({ decision: 'deny', reason: 'late' }), 300)) });
  const ok = mod('ok', { handle: async () => ({ decision: 'ask', reason: 'hoi' }) });
  const r = await run(profile(entry(boom, true), entry(slow, true), entry(ok, true)));
  expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
  const t = JSON.stringify(r.records);
  expect(t).toContain('boom: error:Error'); expect(t).toContain('slow: timeout'); expect(t).not.toContain('SECRET-CMD-xyz');
});

test('module onError closed nem/timeout -> deny', async () => {
  const closed = mod('strict', { onError: 'closed', handle: async () => { throw new Error('x'); } });
  const r = await run(profile(entry(closed, true)));
  const h = JSON.parse(r.stdout).hookSpecificOutput;
  expect(h.permissionDecision).toBe('deny'); expect(h.permissionDecisionReason).toContain('strict');
});

test('updatedInput ap tuan tu (module sau thay input da sua); deny sau do bo updatedInput', async () => {
  const seen = [];
  const a = mod('a', { handle: async (e, inp) => ({ updatedInput: { ...inp.tool_input, timeout: 5 } }) });
  const b = mod('b', { handle: async (e, inp) => { seen.push(inp.tool_input.timeout); return { updatedInput: { ...inp.tool_input, model: 'm' } }; } });
  const r = await run(profile(entry(a, true), entry(b, true)));
  expect(seen).toEqual([5]);
  expect(JSON.parse(r.stdout).hookSpecificOutput.updatedInput).toEqual({ command: 'ls', timeout: 5, model: 'm' });
  const d = mod('d', { handle: async () => ({ decision: 'deny', reason: 'no' }) });
  const r2 = await run(profile(entry(a, true), entry(d, true)));
  expect(JSON.parse(r2.stdout).hookSpecificOutput.updatedInput).toBeUndefined();
});

test('deny cat module gate sau no nhung module khong-gate (audit) van chay', async () => {
  const ran = [];
  const d = mod('d', { handle: async () => ({ decision: 'deny', reason: 'no' }) });
  const g2 = mod('g2', { handle: async () => { ran.push('g2'); return {}; } });
  const au = mod('au', { handle: async () => { ran.push('au'); return { records: [{ sink: 'audit', data: { x: 1 } }] }; } });
  const r = await run(profile(entry(d, true), entry(g2, true), entry(au, false)));
  expect(ran).toEqual(['au']); expect(r.records.length).toBe(1);
});

test('ket qua sai dinh dang -> bo qua + vet; stdin hong -> {}', async () => {
  const bad = mod('bad', { handle: async () => ({ decision: 'maybe' }) });
  const r = await run(profile(entry(bad, true)));
  expect(JSON.parse(r.stdout)).toEqual({}); expect(JSON.stringify(r.records)).toContain('bad: bad-result');
  const r2 = await run(profile(entry(bad, true)), '{broken');
  expect(r2.stdout).toBe('{}'); expect(r2.code).toBe(0);
  const r3 = await run(profile(entry(bad, true)), 'x'.repeat(10));
  expect(r3.records[0].data.reason).toBe('badjson');
  const r4 = await dispatch({ event: 'PreToolUse', stdin: input, cfg: { ...cfg, maxInputBytes: 5 }, profile: profile(entry(bad, true)) });
  expect(r4.records[0].data.reason).toBe('oversize');
});

test('tran thoi gian tong: module treo -> tra phan da co, khong cho', async () => {
  const hang = mod('hang', { timeoutMs: 60000, handle: () => new Promise(() => {}) });
  const t0 = Date.now();
  const r = await dispatch({ event: 'PreToolUse', stdin: input, cfg: { ...cfg, budgetsMs: { PreToolUse: 200 } }, profile: profile(entry(hang, true)) });
  expect(Date.now() - t0).toBeLessThan(1500);
  expect(JSON.parse(r.stdout)).toEqual({});
});

test('agy: render Pre luon co decision (allow mac dinh), con lai {}; order chi su kien agy', () => {
  expect(renderAgy('PreToolUse', mergeResults([])).stdout).toBe('{"decision":"allow"}\n');
  expect(JSON.parse(renderAgy('PreToolUse', mergeResults([{ id: 'x', result: { decision: 'deny', reason: 'r' } }])).stdout)).toEqual({ decision: 'deny', reason: 'r' });
  expect(renderAgy('PostToolUse', mergeResults([])).stdout).toBe('{}\n');
  expect(Object.keys(AGY_ORDER).sort()).toEqual(['PostInvocation', 'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
});
