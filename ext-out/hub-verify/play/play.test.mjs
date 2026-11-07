import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validatePlaybook, loadPlaybook, resolveParams, buildArgv } from './playbook/schema.mjs';
import { denyRun, HARNESS_BIN, scriptOutsideHub } from './playbook/policy.mjs';
import { resolveSpawn, summarizeOutput } from './playbook/exec.mjs';
import { runPlaybook, formatResult } from './playbook/run.mjs';
import { dataPathFor } from '../../../harness/core/io/storage.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const playData = (d) => dataPathFor('play', { repoDir: d });
// Fixture hub tuong minh (khong phu thuoc hub/plugin mode): .agents/playbooks tao trong tmp. HUB_DIR tro vao do.
const REPO = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'play-hub-'));
  const dir = path.join(d, '.agents', 'playbooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(d, 'ok.mjs'), 'console.log("ok");\n');
  const read = (id) => ({ id, run: ['node', 'ok.mjs'], timeout_s: 30, on_fail: 'escalate' });
  const w = (n, j) => fs.writeFileSync(path.join(dir, n + '.json'), JSON.stringify(j, null, 2));
  w('verify-commit', {
    name: 'verify-commit', description: 'fixture: kiem tra roi git add (duong dan cu the) + git commit; buoc mutating chi chay voi --yes.',
    params: { message: { required: true, pattern: '[^\\r\\n"`$%&|<>^]{1,200}' }, paths: { required: true, list: true, pattern: '(?!.*\\.\\.)[A-Za-z0-9_][A-Za-z0-9_./-]*' } },
    limits: { timeout_s: 120, max_output_bytes: 300000 },
    steps: [read('check'), { id: 'git-add', run: ['git', 'add', '--', '${paths}'], mutating: true, timeout_s: 30, on_fail: 'escalate' },
      { id: 'git-commit', run: ['git', 'commit', '-m', '${message}', '--only', '--', '${paths}'], mutating: true, timeout_s: 60, on_fail: 'escalate', summarize: { head: 2, max_lines: 3 } }],
  });
  w('worker-lifecycle', { name: 'worker-lifecycle', description: 'fixture', steps: [read('a'), read('b')] });
  w('weekly-maintenance', { name: 'weekly-maintenance', description: 'fixture (khong mutating)', steps: [read('a'), read('b')] });
  return d;
})();
const mk = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'play-'));
  // stub: node stub.mjs <exit> <stdoutText> [sleepMs] [bigBytes]
  fs.writeFileSync(path.join(d, 'stub.mjs'), `
const [code, text = '', sleep = '0', big = '0'] = process.argv.slice(2);
if (text) console.log(text);
if (Number(big)) process.stdout.write('x'.repeat(Number(big)));
setTimeout(() => process.exit(Number(code)), Number(sleep));
`);
  return d;
};
const stub = (...a) => ['node', 'stub.mjs', ...a.map(String)];
const pb = (steps, extra = {}) => ({ name: 't', steps, ...extra });
const run = (p, hub, o = {}) => runPlaybook(p, { hub, ...o });

test('validate: unknown keys rejected at every level', () => {
  expect(validatePlaybook({ name: 't', steps: [{ id: 'a', run: ['node', 'x.mjs'] }], bogus: 1 }).join()).toContain("khoa la 'bogus'");
  expect(validatePlaybook(pb([{ id: 'a', run: ['node', 'x.mjs'], shell: true }])).join()).toContain("khoa la 'shell'");
  expect(validatePlaybook(pb([{ id: 'a', run: ['node', 'x.mjs'], expect: { foo: 1 } }])).join()).toContain("'foo'");
  expect(validatePlaybook(pb([{ id: 'a', run: ['node', 'x.mjs'] }], { params: { p: { nope: 1 } } })).join()).toContain("'nope'");
  expect(validatePlaybook(pb([{ id: 'a', run: ['node', 'x.mjs'] }], { limits: { zzz: 1 } })).join()).toContain("'zzz'");
  expect(validatePlaybook(pb([{ id: 'a', run: ['node', 'x.mjs'] }]))).toEqual([]);
});

test('validate: run must be an array (string rejected)', () => {
  expect(validatePlaybook(pb([{ id: 'a', run: 'node x' }])).join()).toContain('MANG');
});

test('validate: refs to undeclared param / later capture / bad when', () => {
  expect(validatePlaybook(pb([{ id: 'a', run: ['node', '${nope}'] }])).join()).toContain('khong phai param');
  expect(validatePlaybook(pb([{ id: 'a', run: ['node', '${capture.x}'] }])).join()).toContain('capture chua khai bao');
  expect(validatePlaybook(pb([{ id: 'a', run: ['node', 'x.mjs'], when: { step: 'zz', status: 'pass' } }])).join()).toContain('when.step');
  expect(validatePlaybook(pb([{ id: 'a', run: ['node', '$' + '{a b}'] }])).join()).toContain('khong phai param');
});

test('params: bad value / missing required / unknown / injection attempts rejected', async () => {
  const d = mk();
  const p = pb([{ id: 'a', run: [...stub(0), '${name}'] }], { params: { name: { required: true, pattern: '[a-z]{1,8}' }, opt: { default: 'ok', pattern: '[a-z]+' } } });
  expect(validatePlaybook(p)).toEqual([]);
  await expect(run(p, d, { params: {} })).rejects.toThrow('thieu param');
  await expect(run(p, d, { params: { name: 'a; rm -rf /' } })).rejects.toThrow('khong khop');
  await expect(run(p, d, { params: { name: 'abc\nx' } })).rejects.toThrow();
  await expect(run(p, d, { params: { name: 'abc', other: 'x' } })).rejects.toThrow('param la');
  // pattern cho phep '-' dau => van bi chan option-injection
  const p2 = pb([{ id: 'a', run: [...stub(0), '${v}'] }], { params: { v: { required: true, pattern: '[a-z-]+' } } });
  expect(validatePlaybook(p2)).toEqual([]);
  const r = await run(p2, d, { params: { v: '--force' } });
  expect(r.result.status).toBe('FAIL');
  expect(r.result.steps[0].summary.join()).toMatch(/option|bi cam/);
  // pattern mac dinh an toan khi khong khai bao
  expect(() => resolveParams(pb([{ id: 'a', run: ['node', '${z}'] }], { params: { z: { required: true } } }), { z: 'a b' })).toThrow('khong khop');
});

test('PASS path exit 0, log + runs.jsonl written with model_calls 0', async () => {
  const d = mk();
  const { result, exitCode } = await run(pb([{ id: 'a', run: stub(0, 'hello') }]), d);
  expect(exitCode).toBe(0);
  expect(result.status).toBe('PASS');
  expect(result.steps[0]).toMatchObject({ id: 'a', status: 'pass', exit: 0 });
  expect(result.log).toBe(path.relative(d, playData(d)).split(path.sep).join('/') + '/' + path.basename(result.log));
  expect(result.log).toMatch(/\.json$/);
  expect(fs.existsSync(path.join(d, result.log))).toBe(true);
  const line = JSON.parse(fs.readFileSync(path.join(playData(d), 'runs.jsonl'), 'utf8').trim().split('\n').pop());
  expect(line.model_calls).toBe(0);
  expect(line.duration_ms).toBeGreaterThanOrEqual(0);
  const txt = fs.readFileSync(path.join(playData(d), result.log.split('/').pop().replace('.json', ''), 'a.txt'), 'utf8');
  expect(txt).toContain('hello');
});

test('FAIL path: exit 1, remaining steps skipped; on_fail continue keeps going', async () => {
  const d = mk();
  let r = await run(pb([{ id: 'a', run: stub(5) }, { id: 'b', run: stub(0) }]), d);
  expect(r.exitCode).toBe(1);
  expect(r.result.status).toBe('FAIL');
  expect(r.result.steps.map((s) => s.status)).toEqual(['fail', 'skip']);
  r = await run(pb([{ id: 'a', run: stub(5), on_fail: 'continue' }, { id: 'b', run: stub(0) }]), d);
  expect(r.result.status).toBe('PASS_WITH_WARNINGS');
  expect(r.result.steps.map((s) => s.status)).toEqual(['fail', 'pass']);
});

test('expect: exit, stdout_includes, stdout_regex', async () => {
  const d = mk();
  const ok = await run(pb([{ id: 'a', run: stub(3, 'abc 42'), expect: { exit: 3, stdout_includes: 'abc', stdout_regex: '\\d+' } }]), d);
  expect(ok.result.status).toBe('PASS');
  const bad = await run(pb([{ id: 'a', run: stub(0, 'abc'), expect: { stdout_includes: 'zzz' } }]), d);
  expect(bad.result.status).toBe('FAIL');
  const bad2 = await run(pb([{ id: 'a', run: stub(0, 'abc'), expect: { stdout_regex: '^\\d+$' } }]), d);
  expect(bad2.result.status).toBe('FAIL');
});

test('ESCALATE path: exit 3 with escalate{step,reason,summary}', async () => {
  const d = mk();
  const { result, exitCode } = await run(pb([{ id: 'a', run: stub(0) }, { id: 'tests', run: stub(1, 'FAILED: foo'), on_fail: 'escalate' }, { id: 'c', run: stub(0) }]), d);
  expect(exitCode).toBe(3);
  expect(result.status).toBe('ESCALATE');
  expect(result.escalate.step).toBe('tests');
  expect(result.escalate.reason).toContain('exit 1');
  expect(result.escalate.summary).toContain('FAILED: foo');
  expect(result.steps[2].status).toBe('skip');
});

test('TIMEOUT path: exit 4, truncated timeout, child killed', async () => {
  const d = mk();
  const t0 = Date.now();
  const { result, exitCode } = await run(pb([{ id: 'slow', run: stub(0, '', 20000), timeout_s: 1 }]), d);
  expect(Date.now() - t0).toBeLessThan(10000);
  expect(exitCode).toBe(4);
  expect(result.status).toBe('TIMEOUT');
  expect(result.steps[0].status).toBe('timeout');
  expect(result.truncated).toBe('timeout');
}, 15000);

test('global timeout (--timeout-s) stops playbook', async () => {
  const d = mk();
  const { result, exitCode } = await run(pb([{ id: 'slow', run: stub(0, '', 20000) }, { id: 'b', run: stub(0) }]), d, { timeoutS: 1 });
  expect(exitCode).toBe(4);
  expect(result.steps[1].status).toBe('skip');
}, 15000);

test('mutating: dry-run by default (not executed), executed with --yes, --dry-run plans everything', async () => {
  const d = mk();
  const marker = path.join(d, 'marker.txt');
  fs.writeFileSync(path.join(d, 'touch.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'x');`);
  const p = pb([{ id: 'ro', run: stub(0, 'read') }, { id: 'mut', run: ['node', 'touch.mjs'], mutating: true }]);
  let r = await run(p, d);
  expect(r.result.status).toBe('DRYRUN');
  expect(r.exitCode).toBe(6);
  expect(r.result.steps.map((s) => s.status)).toEqual(['pass', 'skip']);
  expect(fs.existsSync(marker)).toBe(false);
  r = await run(p, d, { yes: true, dryRun: true });
  expect(r.result.status).toBe('DRYRUN');
  expect(r.result.steps.map((s) => s.status)).toEqual(['plan', 'plan']);
  expect(fs.existsSync(marker)).toBe(false);
  r = await run(p, d, { yes: true });
  expect(r.result.status).toBe('PASS');
  expect(fs.existsSync(marker)).toBe(true);
});

test('output truncation + summarize', async () => {
  const d = mk();
  const lines = Array.from({ length: 30 }, (_, i) => (i === 10 ? 'ERROR here' : `line${i}`)).join('\\n');
  fs.writeFileSync(path.join(d, 'many.mjs'), `console.log("${lines}");`);
  const { result } = await run(pb([{ id: 'a', run: ['node', 'many.mjs'], summarize: { head: 1, tail: 2, match_regex: 'ERROR', max_lines: 4 } }]), d);
  expect(result.steps[0].summary).toEqual(['line0', 'ERROR here', 'line28', 'line29']);
  const big = await run(pb([{ id: 'b', run: stub(0, '', 0, 50000) }]), d, { maxOutputBytes: 1000 });
  expect(big.result.truncated).toBe('output');
  const saved = fs.readFileSync(path.join(playData(d), big.result.log.split('/').pop().replace('.json', ''), 'b.txt'), 'utf8');
  expect(saved.length).toBeLessThan(1200 + 100);
  expect(summarizeOutput('a\nb\nc\nd\ne\nf\ng', { tail: 10, max_lines: 3 })).toEqual(['e', 'f', 'g']);
});

test('when + capture chaining (regex, json_path, lines)', async () => {
  const d = mk();
  fs.writeFileSync(path.join(d, 'j.mjs'), `console.log(JSON.stringify({a:{b:'v-7'}}));`);
  const p = pb([
    { id: 'cap1', run: stub(0, 'id=abc123 done'), capture: { name: 'id', regex: 'id=(\\w+)' } },
    { id: 'cap2', run: ['node', 'j.mjs'], capture: { name: 'jv', json_path: 'a.b' } },
    { id: 'use', run: [...stub(0, 'got'), '${capture.id}', '${capture.jv}'], expect: { stdout_includes: 'got' } },
    { id: 'fail', run: stub(2), on_fail: 'continue' },
    { id: 'only-if-fail', run: stub(0, 'recovered'), when: { step: 'fail', status: 'fail' } },
    { id: 'only-if-pass', run: stub(0, 'nope'), when: { step: 'fail', status: 'pass' } },
  ]);
  expect(validatePlaybook(p)).toEqual([]);
  const { result } = await run(p, d);
  expect(result.status).toBe('PASS_WITH_WARNINGS');
  expect(result.steps.map((s) => s.status)).toEqual(['pass', 'pass', 'pass', 'fail', 'pass', 'skip']);
  const out = fs.readFileSync(path.join(playData(d), result.log.split('/').pop().replace('.json', ''), 'use.txt'), 'utf8');
  expect(out).toContain('node stub.mjs 0 got abc123 v-7');
  // capture khong khop => fail
  const bad = await run(pb([{ id: 'c', run: stub(0, 'zzz'), capture: { name: 'x', regex: 'id=(\\d+)' } }]), d);
  expect(bad.result.status).toBe('FAIL');
  // capture chua ky tu nguy hiem => fail
  const evil = await run(pb([{ id: 'c', run: stub(0, 'a;rm -rf b'), capture: { name: 'x', regex: '(.+)' } }]), d);
  expect(evil.result.status).toBe('FAIL');
});

test('list param expands to separate argv items and validates each', async () => {
  const d = mk();
  const p = pb([{ id: 'a', run: [...stub(0, 'ok'), '${paths}'] }], { params: { paths: { required: true, list: true, pattern: '(?!.*\\.\\.)[A-Za-z0-9_][A-Za-z0-9_./-]*' } } });
  expect(validatePlaybook(p)).toEqual([]);
  const r = await run(p, d, { params: { paths: 'a.txt,b/c.txt' } });
  const out = fs.readFileSync(path.join(playData(d), r.result.log.split('/').pop().replace('.json', ''), 'a.txt'), 'utf8');
  expect(out).toContain('node stub.mjs 0 ok a.txt b/c.txt');
  await expect(run(p, d, { params: { paths: 'a.txt,../etc' } })).rejects.toThrow('khong khop');
  await expect(run(p, d, { params: { paths: 'a.txt,-A' } })).rejects.toThrow('khong khop');
  expect(validatePlaybook(pb([{ id: 'a', run: ['node', 'x${paths}'] }], { params: { paths: { list: true } } })).join()).toContain('param list');
});

test('cwd outside hub rejected; missing exe => fail', async () => {
  const d = mk();
  const r = await run(pb([{ id: 'a', run: stub(0), cwd: '..' }]), d);
  expect(r.result.status).toBe('FAIL');
  const r2 = await run(pb([{ id: 'a', run: ['definitely-not-a-real-exe-xyz'] }]), d);
  expect(r2.result.status).toBe('FAIL');
});

test('shipped playbooks validate; verify-commit refuses git add -A style via deny', () => {
  for (const n of ['verify-commit', 'worker-lifecycle', 'weekly-maintenance']) {
    const p = loadPlaybook(n, { hub: REPO });
    expect(p.name).toBe(n);
  }
  const wm = loadPlaybook('weekly-maintenance', { hub: REPO });
  expect(wm.steps.every((s) => !s.mutating)).toBe(true);
});

test('CLI: usage error exit 2, unknown playbook exit 2, dry-run exit 0, compact output <= 25 lines', () => {
  const play = (...a) => spawnSync(process.execPath, [path.join(SRC, 'ext-out', 'hub-verify', 'play', 'play.mjs'), ...a], { cwd: REPO, encoding: 'utf8', timeout: 60000, env: { ...process.env, HUB_DIR: REPO } });
  expect(play().status).toBe(2);
  expect(play('no-such-playbook').status).toBe(2);
  expect(play('verify-commit', '--param', 'message=x').status).toBe(2); // thieu paths
  const r = play('verify-commit', '--param', 'message=hello', '--param', 'paths=a.txt', '--dry-run');
  expect(r.status).toBe(6);
  const out = JSON.parse(r.stdout);
  expect(out.status).toBe('DRYRUN');
  expect(r.stdout.trim().split('\n').length).toBeLessThanOrEqual(25);
  expect(formatResult(out)).toBe(r.stdout.trim());
});

// ---------- review fixes ----------
test('allowlist: every reviewer bypass is rejected (validate + denyRun)', () => {
  const bad = [
    ['git', '-c', 'alias.p=push', 'p'], ['git', '-calias.p=push', 'p'], ['git', '--git-dir', 'x', 'push'], ['git', '--git-dir=x', 'status'], ['git', '--work-tree', 'x', 'status'], ['git', '--work-tree=x', 'status'],
    ['git', '--exec-path=x', 'status'], ['git', '--namespace', 'n', 'status'], ['git', '-C', '/abs', 'status'], ['git', '-C', '../x', 'status'],
    ['git', 'rm', '-r', 'x'], ['git', 'checkout', '-f'], ['git', 'checkout', 'main'], ['git', 'restore', '.'], ['git', 'stash', 'drop'], ['git', 'stash', 'clear'], ['git', 'stash', 'pop'], ['git', 'stash', 'apply'],
    ['git', 'branch', '-f', 'x'], ['git', 'branch', '-d', 'x'], ['git', 'branch', '-D', 'x'], ['git', 'branch', '-m', 'a', 'b'], ['git', 'branch', 'newbranch'], ['git', 'update-ref', '-d', 'refs/heads/x'],
    ['git', 'gc', '--prune=now'], ['git', 'clean', '-fd'], ['git', 'reset', 'HEAD~1'], ['git', 'reset', '--hard'], ['git', 'push'], ['git', 'commit', '--no-verify', '--', 'a'], ['git', 'commit', '-n', '--', 'a'],
    ['git', 'commit', '-m', 'x'], ['git', 'commit', '-a', '-m', 'x', '--', 'a'], ['git', 'commit', '-m', 'x', '--'], ['git', 'diff', '--output=x'], ['git', 'worktree', 'remove', 'p'], ['git', 'worktree', 'add', 'p'],
    ['git', 'symbolic-ref', 'HEAD', 'refs/heads/x'], ['git', 'add', '-A'], ['git', 'add', '.'], ['git', 'add', '*'], ['git', 'fetch'], ['git', 'config', 'x', 'y'], ['git', 'status', '-fd'],
    ['mv', 'a', 'b'], ['robocopy', 'a', 'b'], ['bun', '-e', 'x'], ['bun', 'x', 'y'], ['bun', 'test', '--preload', 'x.js'], ['bun', 'run', 'build'], ['bun', 'run', '../x.mjs'], ['npx', 'x'], ['python', '-c', 'x'], ['python3', 'x.py'],
    ['node', '--eval=1'], ['node', '--import', 'data:text/javascript,1'], ['node', '--input-type=module', 'x.mjs'], ['node', '-p', '1'], ['node', '-e', '1'], ['node'], ['node', '/abs/x.mjs'], ['node', '../x.mjs'], ['node', 'x.txt'],
    ['cmd', '/c', 'dir'], ['powershell', '-c', 'x'], ['bash', '-c', 'x'], ['sh', 'x'], ['git.exe', 'status'], ['rm', 'x'], ['npm', 'x'],
  ];
  for (const run of bad) {
    expect(denyRun(run), JSON.stringify(run)).not.toBeNull();
    expect(validatePlaybook(pb([{ id: 'a', run }])).length, JSON.stringify(run)).toBeGreaterThan(0);
  }
  for (const run of [
    ['git', 'status'], ['git', '-C', 'sub', 'status'], ['git', 'log', '-1', '--format=%H'], ['git', 'branch', '--merged', 'main'], ['git', 'branch', '--no-merged', 'main'], ['git', 'branch', '-l'], ['git', 'branch', '--list', 'x*'],
    ['git', 'stash', 'list'], ['git', 'worktree', 'list'], ['git', 'add', '--', 'a.txt'], ['git', 'commit', '-m', 'm', '-m', 't', '--only', '--', 'a.txt'], ['git', 'rev-parse', 'HEAD'], ['git', 'ls-files'],
    ['git', 'for-each-ref'], ['git', 'rev-list', 'HEAD'], ['git', 'symbolic-ref', 'HEAD'], ['git', 'show', 'HEAD'], ['git', 'diff', '--stat'],
    ['node', 'scripts/x.mjs', '--eval'], ['bun', 'test', './a/', '--timeout', '1000'], ['bun', 'run', 'scripts/x.mjs'],
  ]) expect(denyRun(run), JSON.stringify(run)).toBeNull();
});

test('re-validation after substitution + script must stay inside hub', async () => {
  const d = mk();
  // capture dua gia tri hop le theo regex nhung sau thay the thanh lenh bi cam
  const p = pb([
    { id: 'c', run: stub(0, 'sub=.'), capture: { name: 's', regex: 'sub=(.)' } },
    { id: 'g', run: ['git', 'add', '--', '${capture.s}'] },
  ]);
  expect(validatePlaybook(p)).toEqual([]);
  const r = await run(p, d);
  expect(r.result.status).toBe('FAIL');
  expect(r.result.steps[1].summary.join()).toMatch(/bi cam/);
  const p2 = pb([{ id: 'a', run: ['node', 'stub.mjs'], cwd: '..' }]);
  expect((await run(p2, d)).result.status).toBe('FAIL');
});

test('git commit only commits declared paths, not other staged files', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'play-git-'));
  const git = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8', timeout: 30000 });
  git('init', '-q');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(d, 'base.txt'), 'b');
  git('add', 'base.txt'); git('commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(d, 'other.txt'), 'o'); git('add', 'other.txt'); // staged, khong khai bao
  fs.writeFileSync(path.join(d, 'mine.txt'), 'm');
  const p = loadPlaybook('verify-commit', { hub: REPO });
  const steps = p.steps.filter((s) => s.id === 'git-add' || s.id === 'git-commit');
  expect(steps.length).toBe(2);
  const r = await run({ ...p, steps }, d, { yes: true, params: { message: 'only mine', paths: 'mine.txt' } });
  expect(r.result.status).toBe('PASS');
  expect(git('show', '--name-only', '--format=', 'HEAD').stdout.trim()).toBe('mine.txt');
  expect(git('status', '--porcelain').stdout).toContain('A  other.txt');
});

test('on_fail continue => PASS_WITH_WARNINGS (exit 0, warnings count)', async () => {
  const d = mk();
  const r = await run(pb([{ id: 'a', run: stub(5), on_fail: 'continue' }, { id: 'b', run: stub(0) }]), d);
  expect(r.result.status).toBe('PASS_WITH_WARNINGS');
  expect(r.exitCode).toBe(0);
  expect(r.result.warnings).toBe(1);
  expect(formatResult(r.result)).toContain('"warnings": 1');
});

test('DRYRUN exits 6 and reports skipped_mutating; read steps still run', async () => {
  const d = mk();
  const p = pb([{ id: 'ro', run: stub(0, 'read') }, { id: 'mut', run: stub(0), mutating: true }, { id: 'mut2', run: stub(0), mutating: true }]);
  let r = await run(p, d);
  expect(r.exitCode).toBe(6);
  expect(r.result.status).toBe('DRYRUN');
  expect(r.result.skipped_mutating).toBe(2);
  expect(r.result.steps[0].status).toBe('pass');
  r = await run(p, d, { dryRun: true });
  expect(r.exitCode).toBe(6);
  expect(r.result.skipped_mutating).toBe(2);
  expect(formatResult(r.result)).toContain('"skipped_mutating": 2');
});

test('dry-run shows conditional steps instead of skipping', async () => {
  const d = mk();
  const p = pb([{ id: 'a', run: stub(0), on_fail: 'continue' }, { id: 'b', run: stub(0), when: { step: 'a', status: 'fail' } }, { id: 'c', run: stub(0, 'x'), capture: { name: 'k', regex: '(x)' } }, { id: 'd', run: [...stub(0), '${capture.k}'] }]);
  const r = await run(p, d, { dryRun: true });
  expect(r.result.steps.map((s) => s.status)).toEqual(['plan', 'plan', 'plan', 'plan']);
  expect(r.result.steps[1].summary[0]).toContain('conditional');
  expect(r.result.steps[3].summary[0]).toContain('conditional');
});

test('play list: liet ke playbook co gioi han, parsePlayArgs nhan list', async () => {
  const { parsePlayArgs, listPlaybooks } = await import('./play.mjs');
  expect(parsePlayArgs(['list']).list).toBe(true);
  const r = listPlaybooks({ hub: REPO });
  expect(r.playbooks.map((p) => p.name)).toContain('verify-commit');
  expect(listPlaybooks({ hub: REPO, limits: { maxFiles: 1 } }).truncated).toBe('max_files');
  expect(listPlaybooks({ hub: REPO, limits: { timeoutMs: -1 } }).truncated).toBe('timeout');
  const cli = spawnSync(process.execPath, [path.join(SRC, 'ext-out', 'hub-verify', 'play', 'play.mjs'), 'list'], { cwd: REPO, encoding: 'utf8', timeout: 30000, env: { ...process.env, HUB_DIR: REPO } });
  expect(cli.status).toBe(0);
  expect(cli.stdout).toContain('verify-commit');
});

test('play.mjs caps --timeout-s and --max-output-bytes', async () => {
  const { parsePlayArgs } = await import('./play.mjs');
  expect(() => parsePlayArgs(['x', '--timeout-s', '1801'])).toThrow('toi da');
  expect(() => parsePlayArgs(['x', '--max-output-bytes', '5000001'])).toThrow('toi da');
  expect(parsePlayArgs(['x', '--timeout-s', '1800', '--max-output-bytes', '5000000']).timeoutS).toBe(1800);
  expect(parsePlayArgs(['--prune', '--days', '3']).prune).toBe(true);
  expect(() => parsePlayArgs(['--prune', 'x'])).toThrow();
});

test('prune: dry-run default, --yes deletes only old valid run logs', async () => {
  const { prunePlayRuns } = await import('./playbook/run.mjs');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'play-prune-'));
  const dir = playData(d);
  fs.mkdirSync(path.join(dir, '20200101000000-t-abcd'), { recursive: true });
  fs.writeFileSync(path.join(dir, '20200101000000-t-abcd.json'), '{}');
  fs.writeFileSync(path.join(dir, 'runs.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'keep.json'), '{}');
  fs.mkdirSync(path.join(dir, '20990101000000-t-wxyz'));
  const old = new Date('2020-01-02');
  for (const n of ['20200101000000-t-abcd', '20200101000000-t-abcd.json', 'runs.jsonl', 'keep.json']) fs.utimesSync(path.join(dir, n), old, old);
  fs.utimesSync(path.join(dir, '20200101000000-t-abcd'), old, old);
  let r = prunePlayRuns({ hub: d });
  expect(r).toMatchObject({ mode: 'dry-run', days: 14, candidates: 2, deleted: 0 });
  expect(fs.existsSync(path.join(dir, '20200101000000-t-abcd.json'))).toBe(true);
  r = prunePlayRuns({ hub: d, yes: true, days: 7 });
  expect(r.deleted).toBe(2);
  expect(fs.existsSync(path.join(dir, '20200101000000-t-abcd'))).toBe(false);
  expect(fs.existsSync(path.join(dir, 'runs.jsonl'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'keep.json'))).toBe(true);
  expect(fs.existsSync(path.join(dir, '20990101000000-t-wxyz'))).toBe(true);
});

test('loadPlaybook: path outside .agents/playbooks rejected unless HUB_PLAYBOOK_ANY=1', () => {
  const d = mk();
  const f = path.join(d, 'x.json');
  fs.writeFileSync(f, JSON.stringify(pb([{ id: 'a', run: ['node', 'x.mjs'] }])));
  expect(() => loadPlaybook(f, { hub: REPO })).toThrow('.agents/playbooks');
  expect(() => loadPlaybook('../x.json', { hub: REPO })).toThrow('.agents/playbooks');
  expect(loadPlaybook('.agents/playbooks/verify-commit.json', { hub: REPO }).name).toBe('verify-commit');
  process.env.HUB_PLAYBOOK_ANY = '1';
  try { expect(loadPlaybook(f, { hub: REPO }).name).toBe('t'); } finally { delete process.env.HUB_PLAYBOOK_ANY; }
});

test('resolveSpawn: cmd shim metacharacters / spaces in path rejected (windows shims), exe passes args', () => {
  const win = (p) => ({ lookup: () => [p] });
  const shim = path.join('C:', 'tools', 'tool.cmd');
  if (process.platform === 'win32') {
    expect(resolveSpawn(['tool', 'ok'], win(shim))).toMatchObject({ cmd: 'cmd.exe' });
    for (const bad of ['a&b', 'a|b', 'a>b', 'a<b', 'a^b', '%PATH%', 'a"b', 'a!b', 'a\nb']) {
      expect(resolveSpawn(['tool', bad], win(shim)).error, bad).toContain('cmd.exe');
    }
    const sp = resolveSpawn(['tool', 'ok'], win(path.join('C:', 'Program Files', 'tool.cmd')));
    expect(sp.error).toContain('khoang trang');
    expect(resolveSpawn(['tool', 'a&b'], win(path.join('C:', 'tools', 'tool.exe'))).cmd).toContain('tool.exe');
  } else {
    expect(resolveSpawn(['tool', 'a&b'], win('/usr/bin/tool')).cmd).toBe('/usr/bin/tool');
  }
});

test('${harnessBin}: validate -> buildArgv -> policy; node + bin/harness cua plugin chay duoc ngoai hub, duong dan khac van bi cam', () => {
  const step = (run) => ({ name: 't', steps: [{ id: 'a', run }] });
  expect(validatePlaybook(step(['node', '${harnessBin}', 'observe', 'digest']))).toEqual([]);
  const b = buildArgv({ run: ['node', '${harnessBin}', 'observe', 'digest'] }, {}, {});
  expect(b.argv).toEqual(['node', HARNESS_BIN, 'observe', 'digest']);
  expect(HARNESS_BIN).toBe(path.join(SRC, 'bin', 'harness'));
  expect(fs.existsSync(HARNESS_BIN)).toBe(true);
  expect(denyRun(b.argv)).toBeNull();
  expect(scriptOutsideHub(b.argv, REPO, REPO)).toBeNull();
  // khong mo rong: exe harness, script ngoai hub khac, ${harnessBin} khong o vi tri script van bi cam
  expect(validatePlaybook(step(['harness', 'observe'])).join()).toContain('allowlist');
  expect(denyRun(['node', path.join(SRC, 'bin', 'other'), 'x'])).toContain('bi cam');
  expect(scriptOutsideHub(['node', path.join(SRC, 'bin', 'other.mjs')], REPO, REPO)).toContain('ngoai hub');
  expect(denyRun(['node', '-e', '${harnessBin}'])).toContain('bi cam');
});
