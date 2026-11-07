// classifyHarnessCommand: allowlist CHAT lenh doc cua harness trong agy (ham thuan). Dau ra module/dispatcher: xem agy.test.mjs.
import { test, expect } from 'bun:test';
import { classifyHarnessCommand as c, SAFE_RULE, UNSAFE_RULE } from './agy-harness.mjs';

const kind = (s) => c(s).kind;

test('safe: chi lenh doc trong allowlist da duyet', () => {
  for (const s of [
    'harness doctor', 'harness doctor --json', 'harness data ls', 'harness data stat x.json', 'harness data scan',
    'harness observe usage', 'harness knowledge search audit', 'harness knowledge get architecture',
    'harness knowledge fact foo', 'harness knowledge role builder', 'harness projects list', 'harness projects get hub', 'harness projects tasks hub',
    '  harness   doctor  ',
  ]) expect([s, kind(s)]).toEqual([s, 'safe']);
  expect(c('harness knowledge get architecture').argv).toEqual(['knowledge', 'get', 'architecture']);
});

test('none: khong phai harness -> khong can thiep', () => {
  for (const s of ['git status', 'node --version', 'echo harness doctor', '', undefined, null, 42, 'cd x && harness doctor']) expect([s, kind(s)]).toEqual([s, 'none']);
});

test('unsafe: ky tu shell (ke ca sau lenh doc)', () => {
  for (const s of ['harness doctor | head', 'harness doctor & calc', 'harness doctor; rm x', 'harness doctor && ls', 'harness doctor > f', 'harness doctor < f',
    'harness doctor `id`', 'harness doctor $(id)', 'harness doctor $env:X', 'harness doctor (x)', 'harness doctor\nrm x', 'harness doctor\r\nls', 'harness knowledge search "a b"', "harness knowledge get 'x'", 'harness doctor %PATH%', 'harness data stat ..\\x'])
    expect([s, kind(s)]).toEqual([s, 'unsafe']);
});

test('unsafe: lenh ghi / ext / cai / co hieu pha', () => {
  for (const s of ['harness ext approve x', 'harness ext register p', 'harness ext remove x', 'harness ext list', 'harness install', 'harness install --shim', 'harness data adopt', 'harness data clean',
    'harness doctor --apply', 'harness knowledge get x --yes', 'harness projects list --force', 'harness knowledge search x --apply=1', 'harness doctor -y', 'harness doctor --fix',
    'harness observe query', 'harness observe report', 'harness observe report --weekly', 'harness observe report --out=x', 'harness knowledge fact set k v', 'harness knowledge add x',
    'harness doctor x,--apply', 'harness doctor @a', 'harness knowledge get a,b', 'harness projects add-task x', 'harness projects set-task x'])
    expect([s, kind(s)]).toEqual([s, 'unsafe']);
});

test('unsafe: tran / domain la / khong doi so / gia mao', () => {
  for (const s of ['harness', 'harness nope', 'harness data', 'harness knowledge', 'harness knowledge nope', 'harness projects', 'harness observe',
    'harness.cmd doctor', './harness doctor', 'bin/harness doctor', 'harness.exe doctor', 'Harness doctor', 'harness.ps1 doctor'])
    expect([s, kind(s)]).toEqual([s, 'unsafe']);
});

test('unsafe/safe mang ly do cho audit gate; allow tiem duoc', () => {
  expect(c('harness doctor').reason).toBeTruthy();
  expect(c('harness ext approve x').reason).toMatch(/allowlist|ext/);
  expect(c('harness doctor | head').reason).toMatch(/shell/);
  expect(c('git status').reason).toBeUndefined();
  expect(c('harness foo bar', { allow: { foo: ['bar'] } }).kind).toBe('safe');
  expect(c('harness doctor', { allow: { foo: ['bar'] } }).kind).toBe('unsafe');
  expect(SAFE_RULE).not.toBe(UNSAFE_RULE);
});
