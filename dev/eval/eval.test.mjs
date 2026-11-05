import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCases, runAll, compare, checkExpect, readBaseline, baseEnv, CASES_DIR, FN_RUNNER } from './eval.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(HERE, '..', '..');
// env sach: playbook/hub export HARNESS_*/HUB_DIR/CLAUDE_PROJECT_DIR cho tien trinh con; test khong duoc phu thuoc
const cleanEnv = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HARNESS_|HUB_DIR$|CLAUDE_PROJECT_DIR$)/.test(k))), ...extra });
const H = (...a) => spawnSync(process.execPath, [path.join(HUB, 'dev', 'eval', 'cli.mjs'), ...a], { cwd: HUB, encoding: 'utf8', timeout: 120000, env: cleanEnv() });
const all = () => JSON.parse(fs.readFileSync(path.join(CASES_DIR, 'approval.json'), 'utf8'));
let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heval-test-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const writeCases = (name, arr) => { const d = path.join(tmp, 'cases'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name), JSON.stringify(arr)); return d; };

test('bo ca: >=15 ca, id duy nhat, khong loi schema, du cac nhom', () => {
  const { cases, errors } = loadCases();
  expect(errors).toEqual([]);
  expect(cases.length).toBeGreaterThanOrEqual(15);
  expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  expect([...new Set(cases.map((c) => c.group))]).toEqual(expect.arrayContaining(['approval', 'fingerprint', 'guard', 'skills', 'verify-gate']));
});

test('cong harness: eval run --json toan pass tren code hien tai, dung hinh ket qua', () => {
  const r = H('run', '--json');
  expect(r.status).toBe(0);
  const j = JSON.parse(r.stdout);
  expect(j.fail).toBe(0);
  expect(j.pass).toBe(j.total);
  for (const c of j.cases) { expect(Object.keys(c)).toEqual(expect.arrayContaining(['id', 'ok', 'got', 'want', 'ms'])); expect(c.ok).toBe(true); }
}, 150000);

test('eval bat duoc loi: doi ky vong gia (push -> none) -> ca truot, exit 1', () => {
  const push = all().find((c) => c.id === 'approval-push-ask');
  const dir = writeCases('fake.json', [{ ...push, id: 'fake-push-none', expect: { exit: 0, decision: 'none' } }, push]);
  const r = H('run', '--cases-dir', dir, '--json');
  expect(r.status).toBe(1);
  const j = JSON.parse(r.stdout);
  expect([j.pass, j.fail]).toEqual([1, 1]);
  const bad = j.cases.find((c) => c.id === 'fake-push-none');
  expect(bad.ok).toBe(false);
  expect(bad.got.decision).toBe('ask');
  expect(bad.got.miss.join(' ')).toContain('decision ask != none');
}, 60000);

test('baseline -> compare: ca moi truot bao newFail + exit 1; khong doi -> exit 0; chua co baseline -> exit 2', () => {
  const push = all().find((c) => c.id === 'approval-push-ask');
  const file = path.join(tmp, 'base.json');
  const good = writeCases('a.json', [push]);
  expect(H('compare', '--cases-dir', good, '--baseline-file', file).status).toBe(2);
  expect(H('baseline', '--cases-dir', good, '--baseline-file', file).status).toBe(0);
  expect(readBaseline(file).cases).toEqual([{ id: 'approval-push-ask', group: 'a', ok: true }]);
  const same = H('compare', '--cases-dir', good, '--baseline-file', file, '--json');
  expect(same.status).toBe(0);
  expect(JSON.parse(same.stdout).newFail).toEqual([]);
  writeCases('a.json', [{ ...push, expect: { decision: 'deny' } }]);
  const reg = H('compare', '--cases-dir', good, '--baseline-file', file, '--json');
  expect(reg.status).toBe(1);
  const j = JSON.parse(reg.stdout);
  expect(j.regressed).toBe(true);
  expect(j.newFail).toEqual(['approval-push-ask']);
}, 60000);

test('compare thuan: newFail/newPass/added/removed', () => {
  const base = { at: 'x', pass: 2, fail: 1, cases: [{ id: 'a', ok: true }, { id: 'b', ok: false }, { id: 'gone', ok: true }] };
  const cur = { pass: 1, fail: 2, cases: [{ id: 'a', ok: false }, { id: 'b', ok: true }, { id: 'new', ok: false }] };
  const c = compare(cur, base);
  expect(c).toMatchObject({ regressed: true, newFail: ['a', 'new'], newPass: ['b'], added: ['new'], removed: ['gone'] });
  expect(compare({ pass: 1, fail: 0, cases: [{ id: 'a', ok: true }] }, { cases: [{ id: 'a', ok: true }] }).regressed).toBe(false);
});

test('checkExpect: moi loai ky vong', () => {
  fs.writeFileSync(path.join(tmp, 'f'), '');
  const obs = { got: { exit: 0, decision: 'deny', reason: 'guard[x]: y', value: null }, stdout: 'abc' };
  expect(checkExpect({ exit: 0, decision: 'deny', reason: '^guard\\[x\\]', value: null, contains: 'ab', notContains: 'zz', exists: 'f', missing: 'g' }, obs, tmp)).toEqual([]);
  expect(checkExpect({ exit: 1, decision: 'ask', value: 'test', contains: 'zz', notContains: 'a', exists: 'g', missing: 'f' }, obs, tmp).length).toBe(7);
  expect(() => checkExpect({ exists: '../x' }, obs, tmp)).toThrow();
  expect(() => checkExpect({ missing: '../x' }, obs, tmp)).toThrow();
  expect(() => checkExpect({ missing: path.resolve(tmp, '..', 'y') }, obs, tmp)).toThrow();
});

test('env toi thieu: chi bien he thong, loai HARNESS_/HOOK_/CLAUDE_/HOME; env cha khong lam lech oracle', () => {
  expect(baseEnv({ PATH: 'p', Path: 'q', SystemRoot: 's', TEMP: 't', ComSpec: 'c', CLAUDE_AUDIT_DIR: 'x', HARNESS_APPROVAL_MODE: 'audit', HOOK_X: '1', HOME: 'h', USERPROFILE: 'u', NODE_OPTIONS: '--x' }))
    .toEqual({ PATH: 'p', Path: 'q', SystemRoot: 's', TEMP: 't', ComSpec: 'c' });
  const r = spawnSync(process.execPath, [path.join(HUB, 'dev', 'eval', 'cli.mjs'), 'run', '--case', 'approval-push-ask', '--json'],
    { cwd: HUB, encoding: 'utf8', timeout: 60000, env: cleanEnv({ HARNESS_APPROVAL_MODE: 'audit', HARNESS_CONFIG_DIR: tmp, CLAUDE_AUDIT_DIR: tmp }) });
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ pass: 1, fail: 0, config: 'default' });
}, 60000);

test('--hub-config-dir: moi ca chep config de xuat vao thu muc tam rieng; goc khong doi; khong co co -> default', () => {
  const cfg = path.join(tmp, 'proposed'); fs.mkdirSync(path.join(cfg, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'sub', 'marker.json'), '{"v":1}');
  const hook = { run: { kind: 'hook', entry: 'harness/constrain/approval/hook.mjs' }, stdin: '{}' };
  const dir = writeCases('cfg.json', [{ ...hook, id: 'sees-config', expect: { exit: 0, exists: 'config/sub/marker.json' } },
    { ...hook, id: 'mutates-copy', setup: { files: { 'config/sub/marker.json': '{"v":2}' } }, expect: { exit: 0 } }]);
  const withCfg = H('run', '--cases-dir', dir, '--hub-config-dir', cfg, '--json');
  expect(withCfg.status).toBe(0);
  expect(JSON.parse(withCfg.stdout)).toMatchObject({ pass: 2, config: path.resolve(cfg) });
  expect(fs.readFileSync(path.join(cfg, 'sub', 'marker.json'), 'utf8')).toBe('{"v":1}');
  const plain = H('run', '--cases-dir', dir, '--json');
  expect(plain.status).toBe(1);
  expect(JSON.parse(plain.stdout)).toMatchObject({ config: 'default', pass: 1, fail: 1 });
  expect(H('run', '--cases-dir', dir, '--hub-config-dir', path.join(tmp, 'nope')).status).toBe(2);
}, 60000);

test('baseline: run co ca truot -> khong ghi de (exit 1) tru khi --force', () => {
  const push = all().find((c) => c.id === 'approval-push-ask');
  const file = path.join(tmp, 'base.json');
  const dir = writeCases('a.json', [push, { ...push, id: 'bad', expect: { decision: 'deny' } }]);
  const r = H('baseline', '--cases-dir', dir, '--baseline-file', file);
  expect(r.status).toBe(1);
  expect(r.stdout + r.stderr).toContain('KHONG ghi baseline');
  expect(fs.existsSync(file)).toBe(false);
  expect(H('baseline', '--cases-dir', dir, '--baseline-file', file, '--force').status).toBe(1);
  expect(readBaseline(file)).toMatchObject({ pass: 1, fail: 1, config: 'default' });
}, 60000);

test('ca hong bi bao loi, khong chay; tran tong -> truncated timeout', () => {
  const dir = writeCases('bad.json', [{ id: 'Bad Id', run: { kind: 'hook' }, expect: {} }, { id: 'no-exp', run: { kind: 'fn', module: 'm', export: 'e' } },
    { id: 'x1', run: { kind: 'hook', entry: 'harness/constrain/approval/hook.mjs' }, stdin: '{}', expect: { exit: 0 } }]);
  const r = runAll({ dir, totalTimeoutMs: 1 });
  expect(r.errors.length).toBe(2);
  expect(r.truncated).toBe('timeout');
  expect(r.cases[0]).toMatchObject({ id: 'x1', ok: false });
});

test('fn-runner: tu choi module ngoai harness/; entry hook ngoai harness/ bi tu choi', () => {
  const r = spawnSync(process.execPath, [FN_RUNNER, '../../harness/evolve/package.json', 'x'], { input: '[]', encoding: 'utf8', timeout: 10000 });
  expect(r.status).toBe(2);
  const dir = writeCases('esc.json', [{ id: 'esc', run: { kind: 'hook', entry: '../../harness/evolve/outside.mjs' }, expect: { exit: 0 } }]);
  const res = runAll({ dir });
  expect(res.cases[0].ok).toBe(false);
  expect(res.cases[0].got.error).toContain('ngoai harness');
});
