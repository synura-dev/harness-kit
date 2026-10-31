import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectAll, planPrune, applyPlan, sourceOf } from './worktree.mjs';

const g = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', timeout: 30000 }); expect(r.status).toBe(0); return r.stdout; };

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtcli-')));
  g(root, 'init', '-b', 'main');
  g(root, 'config', 'user.email', 't@t'); g(root, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'a.txt'), '1');
  g(root, 'add', '.'); g(root, 'commit', '-m', 'init');
  const p = (dir, n) => path.join(root, dir, n);
  g(root, 'worktree', 'add', '-b', 'worktree-agent-safe', p('.claude/worktrees', 'agent-safe'), 'main');
  g(root, 'worktree', 'add', '-b', 'worktree-agent-dirty', p('.claude/worktrees', 'agent-dirty'), 'main');
  g(root, 'worktree', 'add', '-b', 'wt-ahead', p('.worktrees', 'ahead'), 'main');
  g(root, 'worktree', 'add', '-b', 'wt-lock', p('.worktrees', 'lock'), 'main');
  g(root, 'worktree', 'lock', p('.worktrees', 'lock'));
  fs.writeFileSync(p('.claude/worktrees', 'agent-dirty') + '/x.txt', 'x');
  const a = p('.worktrees', 'ahead');
  g(a, 'config', 'user.email', 't@t'); g(a, 'config', 'user.name', 't');
  fs.writeFileSync(a + '/y.txt', 'y'); g(a, 'add', '.'); g(a, 'commit', '-m', 'ahead');
  return { root, p };
}
const by = (rows, name) => rows.find((r) => r.path.replace(/\\/g, '/').endsWith(name));

test('list: gan nguon + trang thai + unmerged', () => {
  const { root } = setup();
  const { rows, truncated } = inspectAll(root);
  expect(truncated).toBe(null);
  expect(rows[0].source).toBe('main');
  expect(by(rows, 'worktrees/agent-safe').source).toBe('claude');
  expect(by(rows, 'worktrees/agent-dirty').state).toBe('dirty');
  expect(by(rows, '.worktrees/ahead').source).toBe('harness');
  expect(by(rows, '.worktrees/ahead').unmerged).toBe(1);
  expect(by(rows, '.worktrees/lock').state).toBe('locked');
  expect(sourceOf(path.join(root, 'zzz'), root, false)).toBe('other');
});

test('prune plan: chi safe duoc remove, con lai skip co ly do', () => {
  const { root } = setup();
  const plan = planPrune(inspectAll(root).rows);
  const act = (n) => by(plan, n);
  expect(act('agent-safe').action).toBe('remove');
  expect(act('agent-dirty').action).toBe('skip');
  expect(act('agent-dirty').why).toContain('dirty');
  expect(act('.worktrees/ahead').why).toContain('chua merge');
  expect(act('.worktrees/lock').why).toBe('locked');
  expect(plan[0].action).toBe('skip');
});

test('dry-run khong doi gi; apply chi go safe (khong dung kho that)', () => {
  const { root, p } = setup();
  const before = g(root, 'worktree', 'list');
  planPrune(inspectAll(root).rows);
  expect(g(root, 'worktree', 'list')).toBe(before);
  const out = applyPlan(planPrune(inspectAll(root).rows), root, 'main');
  expect(by(out, 'agent-safe').result).toBe('removed');
  expect(fs.existsSync(p('.claude/worktrees', 'agent-safe'))).toBe(false);
  expect(g(root, 'branch', '--list', 'worktree-agent-safe').trim()).toBe('');
  for (const [d, n] of [['.claude/worktrees', 'agent-dirty'], ['.worktrees', 'ahead'], ['.worktrees', 'lock']]) expect(fs.existsSync(p(d, n))).toBe(true);
});

test('worktree mat thu muc => prunable => don duoc', () => {
  const { root, p } = setup();
  fs.rmSync(p('.claude/worktrees', 'agent-safe'), { recursive: true, force: true });
  const rows = inspectAll(root).rows;
  expect(by(rows, 'agent-safe').state).toBe('prunable');
  const out = applyPlan(planPrune(rows), root, 'main');
  expect(by(out, 'agent-safe').result).toBe('removed');
});

test('timeout => truncated', () => {
  const { root } = setup();
  expect(inspectAll(root, { timeoutMs: -1 }).truncated).toBe('timeout');
  expect(inspectAll(root, { max: 1 }).truncated).toBe('max');
});
