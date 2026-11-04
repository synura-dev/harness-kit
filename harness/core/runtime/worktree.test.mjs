import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sanitize, createWorktree, removeWorktree, removeWorktreeAt, getWorktreePath, getBranchName } from './worktree.mjs';
import { resolveHub } from '../io/paths.mjs';

const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', timeout: 30000 });
function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  git(d, 'init', '-b', 'main');
  git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.txt'), 'a');
  git(d, 'add', '.'); git(d, 'commit', '-m', 'i');
  return d;
}

test('bay: worktree Claude (.claude/worktrees) khong bi bao removed bang removeWorktree(sessionId)', () => {
  const r = repo();
  const p = path.join(r, '.claude', 'worktrees', 'agent-x');
  git(r, 'worktree', 'add', '-b', 'wt-s9', p, 'main');
  const res = removeWorktree('s9', { root: r, baseBranch: 'main' });
  expect(res.removed).toBe(false);
  expect(res.kept).toContain('worktree');
  expect(fs.existsSync(p)).toBe(true);
});

test('removeWorktreeAt: don worktree Claude theo duong dan that + xoa branch', () => {
  const r = repo();
  const p = path.join(r, '.claude', 'worktrees', 'agent-y');
  git(r, 'worktree', 'add', '-b', 'worktree-agent-y', p, 'main');
  const res = removeWorktreeAt(p, { root: r, baseBranch: 'main' });
  expect(res.removed).toBe(true);
  expect(res.kept).toEqual([]);
  expect(fs.existsSync(p)).toBe(false);
  expect(git(r, 'branch', '--list', 'worktree-agent-y').stdout.trim()).toBe('');
});

test('removeWorktreeAt: duong dan sai => error, khong removed; dirty/unmerged giu', () => {
  const r = repo();
  const bad = removeWorktreeAt(path.join(r, 'khong-co'), { root: r, baseBranch: 'main' });
  expect(bad.removed).toBe(false);
  expect(bad.error).toBe(true);
  expect(removeWorktreeAt(r, { root: r, baseBranch: 'main' }).error).toBe(true);
  const p = path.join(r, '.claude', 'worktrees', 'agent-z');
  git(r, 'worktree', 'add', '-b', 'worktree-agent-z', p, 'main');
  fs.writeFileSync(path.join(p, 'n.txt'), '1');
  expect(removeWorktreeAt(p, { root: r, baseBranch: 'main' }).kept).toContain('worktree');
  git(p, 'config', 'user.email', 't@t'); git(p, 'config', 'user.name', 't');
  git(p, 'add', '.'); git(p, 'commit', '-m', 'c');
  const res = removeWorktreeAt(p, { root: r, baseBranch: 'main' });
  expect(res.kept).toEqual(['branch']);
  expect(res.reason).toContain('chua merge');
  expect(git(r, 'branch', '--list', 'worktree-agent-z').stdout.trim()).not.toBe('');
});

test('sanitize + unique naming', () => {
  expect(sanitize('../x y/z')).toBe('x-y-z');
  const r = repo();
  expect(getWorktreePath('a b', r)).toBe(getWorktreePath('a-b', r));
  const a = createWorktree('claude-t-1', { root: r });
  const b = createWorktree('claude-t-2', { root: r });
  expect(a.worktreePath).not.toBe(b.worktreePath);
  expect(a.branch).toBe(getBranchName('claude-t-1'));
  expect(() => createWorktree('claude-t-1', { root: r })).toThrow();
});

test('clean worktree removed with branch', () => {
  const r = repo();
  const w = createWorktree('s1', { root: r });
  const res = removeWorktree('s1', { root: r });
  expect(res.removed).toBe(true);
  expect(res.kept).toEqual([]);
  expect(fs.existsSync(w.worktreePath)).toBe(false);
  expect(git(r, 'branch', '--list', w.branch).stdout.trim()).toBe('');
});

test('unmerged branch kept; dirty worktree kept', () => {
  const r = repo();
  const w = createWorktree('s2', { root: r });
  fs.writeFileSync(path.join(w.worktreePath, 'b.txt'), 'b');
  git(w.worktreePath, 'add', '.'); git(w.worktreePath, 'commit', '-m', 'x');
  const res = removeWorktree('s2', { root: r });
  expect(res.removed).toBe(true);
  expect(res.kept).toContain('branch');
  expect(git(r, 'branch', '--list', w.branch).stdout).toContain(w.branch);

  const w3 = createWorktree('s3', { root: r });
  fs.writeFileSync(path.join(w3.worktreePath, 'dirty.txt'), 'd');
  const r3 = removeWorktree('s3', { root: r });
  expect(r3.removed).toBe(false);
  expect(r3.kept).toContain('worktree');
  expect(fs.existsSync(path.join(w3.worktreePath, 'dirty.txt'))).toBe(true);
});

test('HUB_DIR env precedence', () => {
  const abs = path.join(os.tmpdir(), 'hubx');
  const h = resolveHub({ env: { HUB_DIR: abs }, repoDir: os.tmpdir() });
  expect(h.source).toBe('env');
  expect(h.hubDir).toBe(path.resolve(abs));
});

test('ignored files khong-rac (keepme/) keep the worktree; node_modules does not', () => {
  const r = repo();
  fs.writeFileSync(path.join(r, '.gitignore'), 'keepme/\nnode_modules/\n');
  git(r, 'add', '.'); git(r, 'commit', '-m', 'ig');
  const w = createWorktree('ig1', { root: r });
  fs.mkdirSync(path.join(w.worktreePath, 'node_modules'));
  fs.writeFileSync(path.join(w.worktreePath, 'node_modules', 'x'), 'x');
  const ok = removeWorktree('ig1', { root: r });
  expect(ok.removed).toBe(true);

  const w2 = createWorktree('ig2', { root: r });
  fs.mkdirSync(path.join(w2.worktreePath, 'keepme', 'runs'), { recursive: true });
  const f = path.join(w2.worktreePath, 'keepme', 'runs', 't.md');
  fs.writeFileSync(f, 'keep');
  const res = removeWorktree('ig2', { root: r });
  expect(res.removed).toBe(false);
  expect(res.kept).toContain('worktree');
  expect(res.reason).toContain('ignored files present');
  expect(fs.existsSync(f)).toBe(true);
});

test('rac ignored cua worker (data/, settings.local.json, .claude/skills) khong chan don; tracked sua do thi giu', () => {
  const r = repo();
  fs.writeFileSync(path.join(r, '.gitignore'), 'data/\nsettings.local.json\n.claude/skills/\n');
  git(r, 'add', '.'); git(r, 'commit', '-m', 'ig');
  const w = createWorktree('rac1', { root: r });
  fs.mkdirSync(path.join(w.worktreePath, 'data'), { recursive: true });
  fs.writeFileSync(path.join(w.worktreePath, 'data', 'x'), 'x');
  fs.writeFileSync(path.join(w.worktreePath, 'settings.local.json'), '{}');
  fs.mkdirSync(path.join(w.worktreePath, '.claude', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(w.worktreePath, '.claude', 'skills', 's'), 's');
  const rr = removeWorktree('rac1', { root: r }); expect(rr.reason).toBe('ok'); expect(rr.removed).toBe(true);

  const w2 = createWorktree('rac2', { root: r });
  fs.mkdirSync(path.join(w2.worktreePath, 'data'), { recursive: true });
  fs.writeFileSync(path.join(w2.worktreePath, 'data', 'x'), 'x');
  fs.writeFileSync(path.join(w2.worktreePath, 'a.txt'), 'sua do');
  const res = removeWorktree('rac2', { root: r });
  expect(res.removed).toBe(false);
  expect(res.reason).toContain('dirty');
});

test('baseBranch defaults to current branch', () => {
  const r = repo();
  git(r, 'checkout', '-b', 'dev');
  const w = createWorktree('b1', { root: r });
  expect(fs.existsSync(w.worktreePath)).toBe(true);
  expect(removeWorktree('b1', { root: r }).removed).toBe(true);
});

// --- stub: retry/rmdir nhanh cleanup (khong can git that) ---
import { removeWorktree as rmWt, getWorktreePath as wtp } from './worktree.mjs';
function stubRun(rmResults, { listed = '' } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'status') return { status: 0, stdout: '' };
    if (args[0] === 'worktree' && args[1] === 'remove') return rmResults.shift() || { status: 0 };
    if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: listed };
    if (args[0] === 'rev-list') return { status: 0, stdout: '0\n' };
    return { status: 0, stdout: '' };
  };
  return { run, calls };
}
const denied = { status: 1, stderr: "error: failed to delete 'x': Permission denied" };
function tmpRoot() { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'wtstub-')); fs.mkdirSync(wtp('s1', r), { recursive: true }); return r; }

test('cleanup stub: Permission denied roi OK => retry thanh cong', () => {
  const root = tmpRoot(); const sleeps = [];
  const { run, calls } = stubRun([denied, denied, { status: 0 }]);
  const r = rmWt('s1', { root, baseBranch: 'main', run, sleep: (ms) => sleeps.push(ms) });
  expect(r.removed).toBe(true);
  expect(calls.filter((c) => c.startsWith('worktree remove')).length).toBe(3);
  expect(sleeps).toEqual([500, 1000]);
});

test('cleanup stub: loi khac Permission denied => khong retry', () => {
  const root = tmpRoot(); const sleeps = []; fs.writeFileSync(path.join(wtp('s1', root), 'x'), '1');
  const { run } = stubRun([{ status: 1, stderr: 'fatal: other' }]);
  const r = rmWt('s1', { root, baseBranch: 'main', run, sleep: (ms) => sleeps.push(ms) });
  expect(sleeps.length).toBe(0);
  expect(r.kept).toContain('worktree');
});

test('cleanup stub: retry het, thu muc rong va het dang ky => rmdir', () => {
  const root = tmpRoot();
  const { run } = stubRun([denied, denied, denied, denied, denied]);
  const r = rmWt('s1', { root, baseBranch: 'main', run, sleep: () => {} });
  expect(r.removed).toBe(true);
  expect(fs.existsSync(wtp('s1', root))).toBe(false);
});

test('cleanup stub: thu muc khong rong => khong rmdir, giu worktree', () => {
  const root = tmpRoot(); fs.writeFileSync(path.join(wtp('s1', root), 'x'), '1');
  const { run } = stubRun([denied, denied, denied, denied, denied]);
  const r = rmWt('s1', { root, baseBranch: 'main', run, sleep: () => {} });
  expect(r.removed).toBe(false);
  expect(fs.existsSync(wtp('s1', root))).toBe(true);
});

test('cleanup stub: con dang ky trong git worktree list => khong rmdir', () => {
  const root = tmpRoot();
  const { run } = stubRun([denied, denied, denied, denied, denied], { listed: 'worktree ' + wtp('s1', root) + '\n\n' });
  const r = rmWt('s1', { root, baseBranch: 'main', run, sleep: () => {} });
  expect(r.removed).toBe(false);
  expect(fs.existsSync(wtp('s1', root))).toBe(true);
});
