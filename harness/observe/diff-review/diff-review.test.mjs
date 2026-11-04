import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPack, parseNumstat, parseNameStatus, parseAddedLines, LIMITS } from './pack.mjs';
import hook from './hook.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.mjs');
const RUN = path.join(HERE, '..', '..', 'hooks', 'dispatch', 'run.mjs');
const SECRET = 'sk-' + 'ABCDEFGHIJKLMNOPQRSTUV123456';
let tmp; let repo; let plain; let env;

const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout; };
const wr = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const runCli = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env, timeout: 30000 });
const nums = (list) => list.map(([p, add, del = 0]) => ({ path: p, add, del }));

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-review-'));
  env = { ...process.env, HUB_DATA_DIR: path.join(tmp, 'data'), CLAUDE_AUDIT_DIR: path.join(tmp, 'audit') };
  repo = path.join(tmp, 'repo'); plain = path.join(tmp, 'plain');
  fs.mkdirSync(repo); fs.mkdirSync(plain);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com'); git(repo, 'config', 'user.name', 't'); git(repo, 'config', 'core.autocrlf', 'false');
  wr(path.join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'checkout', '-q', '-b', 'feat');
  wr(path.join(repo, 'src', 'auth', 'login.mjs'), `export const k = 1;\nconst apiKey = "${SECRET}";\n`);
  wr(path.join(repo, 'src', 'util.mjs'), 'export const u = 2;\n');
  wr(path.join(repo, 'docs', 'a.md'), 'doc\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'feat');
  wr(path.join(repo, 'src', 'util.mjs'), 'export const u = 3;\n'); // chua commit
});
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

test('LIMITS dong bang dung gia tri', () => {
  expect(Object.isFrozen(LIMITS)).toBe(true);
  expect(LIMITS).toMatchObject({ timeoutMs: 8000, maxFiles: 300, maxBundleLines: 400, maxBundles: 8, readMaxBytes: 4 * 1048576, maxLines: 40 });
});

test('pack: parse numstat/name-status/added lines', () => {
  expect(parseNumstat('3\t1\ta/b.mjs\n-\t-\timg.png\n')).toEqual([{ path: 'a/b.mjs', add: 3, del: 1 }, { path: 'img.png', add: 0, del: 0 }]);
  expect(parseNameStatus('M\ta.mjs\nA\tb c.mjs\n')).toEqual({ 'a.mjs': 'M', 'b c.mjs': 'A' });
  const d = 'diff --git a/x.mjs b/x.mjs\n--- a/x.mjs\n+++ b/x.mjs\n@@ -1,0 +5,2 @@\n+one\n+two\n';
  expect(parseAddedLines(d)).toEqual([{ path: 'x.mjs', line: 5, text: 'one' }, { path: 'x.mjs', line: 6, text: 'two' }]);
});

test('pack: chia bundle theo thu muc, file lon rieng, co large', () => {
  const p = buildPack({ numstat: nums([['a/x.mjs', 10], ['a/y.mjs', 20], ['b/z.mjs', 5], ['b/big.mjs', 500]]), base: 'abc', head: 'def' });
  const ids = p.bundles.map((b) => b.id);
  expect(ids).toContain('b1:a');
  const big = p.bundles.find((b) => b.files.some((f) => f.path === 'b/big.mjs'));
  expect(big.files.length).toBe(1);
  expect(big.files[0].flags).toContain('large');
  expect(p.bundles.find((b) => b.files.some((f) => f.path === 'a/x.mjs')).files.map((f) => f.path)).toEqual(['a/x.mjs', 'a/y.mjs']);
  expect(p.flags.large).toBe(1);
  expect(p.bundles[0].cmd).toBe('git diff abc -- a/x.mjs a/y.mjs');
});

test('pack: tran dong/bundle tach bundle cung thu muc', () => {
  const p = buildPack({ numstat: nums([['a/1.mjs', 200], ['a/2.mjs', 150], ['a/3.mjs', 100]]), limits: { maxBundleLines: 400 } });
  expect(p.bundles.length).toBe(2);
  expect(p.bundles.every((b) => b.lines <= 400)).toBe(true);
});

test('pack: no-test-change co/khong co test di kem', () => {
  const no = buildPack({ numstat: nums([['src/a.mjs', 3], ['README.md', 1]]) });
  expect(no.bundles.flatMap((b) => b.files).find((f) => f.path === 'src/a.mjs').flags).toContain('no-test-change');
  expect(no.bundles.flatMap((b) => b.files).find((f) => f.path === 'README.md').flags).not.toContain('no-test-change');
  const yes = buildPack({ numstat: nums([['src/a.mjs', 3], ['src/a.test.mjs', 3]]) });
  expect(yes.flags['no-test-change']).toBeUndefined();
});

test('pack: sensitive-path va unverified (evidence)', () => {
  const p = buildPack({ numstat: nums([['src/auth/login.mjs', 3], ['src/util.mjs', 1]]), evidence: { kinds: {} } });
  const f = p.bundles.flatMap((b) => b.files);
  expect(f.find((x) => x.path === 'src/auth/login.mjs').flags).toContain('sensitive-path');
  expect(f.find((x) => x.path === 'src/util.mjs').flags).toContain('unverified');
  const ok = buildPack({ numstat: nums([['src/util.mjs', 1]]), evidence: { kinds: { test: { fresh_pass: true } } } });
  expect(ok.flags.unverified).toBeUndefined();
  expect(buildPack({ numstat: nums([['src/util.mjs', 1]]), evidence: null }).flags.unverified).toBeUndefined();
});

test('pack: secret-like chi xuat path:dong, khong xuat noi dung', () => {
  const p = buildPack({ numstat: nums([['src/k.mjs', 2]]), addedLines: [{ path: 'src/k.mjs', line: 7, text: `const apiKey = "${SECRET}";` }, { path: 'src/k.mjs', line: 8, text: 'const x = 1;' }] });
  const f = p.bundles[0].files[0];
  expect(f.flags).toContain('secret-like');
  expect(f.at).toEqual(['src/k.mjs:7']);
  expect(JSON.stringify(p)).not.toContain(SECRET);
});

test('pack: truncated max_files', () => {
  const many = Array.from({ length: 12 }, (_, i) => [`d/f${String(i).padStart(2, '0')}.mjs`, 1]);
  const p = buildPack({ numstat: nums(many), limits: { maxFiles: 5 } });
  expect(p.truncated).toBe('max_files');
  expect(p.bundles.flatMap((b) => b.files).length).toBe(5);
});

test('pack: vuot maxBundles -> gop thu muc cha', () => {
  const list = Array.from({ length: 12 }, (_, i) => [`top/d${i}/f.mjs`, 1]);
  const p = buildPack({ numstat: nums(list), limits: { maxBundles: 8 } });
  expect(p.bundles.length).toBeLessThanOrEqual(8);
  expect(p.bundles.flatMap((b) => b.files).length).toBe(12);
});

test('cli: nhanh 3 file, base main, gom thay doi chua commit, khong lo secret', () => {
  const r = runCli(repo, 'pack');
  expect(r.status).toBe(0);
  const lines = r.stdout.trim().split('\n');
  expect(lines.length).toBeLessThanOrEqual(40);
  expect(lines[0]).toContain('base=main@');
  expect(r.stdout).toContain('3 file');
  expect(r.stdout).toContain('git diff ');
  expect(r.stdout).toContain('secret-like');
  expect(r.stdout).toContain('src/auth/login.mjs:2');
  expect(r.stdout).toContain('sensitive-path');
  expect(r.stdout).not.toContain(SECRET);
});

test('cli: --json dung schema, --base tuong minh', () => {
  const r = runCli(repo, 'pack', '--json', '--base', 'main');
  expect(r.status).toBe(0);
  expect(r.stdout).not.toContain(SECRET);
  const j = JSON.parse(r.stdout);
  expect(j).toMatchObject({ status: 'ok', ref: 'main' });
  expect(typeof j.base).toBe('string'); expect(typeof j.head).toBe('string');
  expect(Array.isArray(j.bundles)).toBe(true);
  for (const b of j.bundles) {
    expect(typeof b.id).toBe('string'); expect(typeof b.lines).toBe('number'); expect(b.cmd.startsWith('git diff ')).toBe(true);
    for (const f of b.files) expect(Object.keys(f)).toEqual(expect.arrayContaining(['path', 'add', 'del', 'status', 'flags']));
  }
  expect(j.flags).toMatchObject({ 'secret-like': 1, unverified: 2 }); // audit tam rong -> chua co test pass
  expect(j.bundles.flatMap((b) => b.files).map((f) => f.path).sort()).toEqual(['docs/a.md', 'src/auth/login.mjs', 'src/util.mjs']);
});

test('cli: base khong ton tai -> bao ro, exit 0', () => {
  const r = runCli(repo, 'pack', '--base', 'no-such-ref');
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('khong tim thay base');
});

test('cli: khong phai git -> thong bao, exit 0', () => {
  const r = runCli(plain, 'pack');
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('khong phai git');
  const j = runCli(plain, 'pack', '--json');
  expect(j.status).toBe(0);
  expect(JSON.parse(j.stdout).status).toBe('not-git');
});

test('hook: ten khop /review/i -> additionalContext <= 20 dong, khong lo secret', async () => {
  expect(hook).toMatchObject({ id: 'diff-review', events: ['SubagentStart'], timeoutMs: 2000, onError: 'open' });
  const r = await hook.handle('SubagentStart', { agent_type: 'reviewer', cwd: repo });
  expect(r.additionalContext.split('\n').length).toBeLessThanOrEqual(20);
  expect(r.additionalContext).toContain('base=main@');
  expect(r.additionalContext).not.toContain(SECRET);
});

test('hook: ten khong khop / khong git / khong diff -> rong', async () => {
  expect(await hook.handle('SubagentStart', { agent_type: 'builder', cwd: repo })).toBeNull();
  expect(await hook.handle('SubagentStart', { agent_type: 'reviewer', cwd: plain })).toBeNull();
  expect(await hook.handle('SubagentStart', { agent_type: 'reviewer', cwd: path.join(tmp, 'khong-ton-tai') })).toBeNull();
  expect(await hook.handle('PreToolUse', { agent_type: 'reviewer', cwd: repo })).toBeNull();
  const clean = path.join(tmp, 'clean'); fs.mkdirSync(clean);
  git(clean, 'init', '-q', '-b', 'main'); git(clean, 'config', 'user.email', 't@example.com'); git(clean, 'config', 'user.name', 't');
  wr(path.join(clean, 'a.txt'), 'x\n'); git(clean, 'add', '.'); git(clean, 'commit', '-q', '-m', 'i');
  expect(await hook.handle('SubagentStart', { agent_type: 'reviewer', cwd: clean })).toBeNull();
});

test('dispatcher: SubagentStart chuyen additionalContext (A1), ten khac -> khong co', () => {
  const run = (agent) => spawnSync(process.execPath, [RUN, 'SubagentStart'], {
    input: JSON.stringify({ hook_event_name: 'SubagentStart', session_id: 's-test', agent_id: 'a1', agent_type: agent, cwd: repo }), encoding: 'utf8', env, timeout: 30000,
  });
  const a = run('code-reviewer');
  expect(a.status).toBe(0);
  const ctx = JSON.parse(a.stdout).hookSpecificOutput;
  expect(ctx.hookEventName).toBe('SubagentStart');
  expect(ctx.additionalContext).toContain('git diff ');
  expect(ctx.additionalContext).not.toContain(SECRET);
  expect(JSON.parse(run('builder').stdout).hookSpecificOutput?.additionalContext).toBeUndefined();
});
