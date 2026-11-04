// bun test harness/constrain/bash-guard/agy-hints.test.mjs
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { replaceReason, isReadOnly, repeatReason, noteMutation } from '../../core/agy/hints.mjs';
import { agyDecide } from './adapters/agy.mjs';
import { DEFAULTS } from './hook.mjs';

test('replaceReason: lenh don gian -> goi y Read/Glob/Grep', () => {
  expect(replaceReason('Get-Content README.md')).toContain('Read');
  expect(replaceReason('cat "a b/c.txt"')).toContain('Read');
  expect(replaceReason('type foo.js')).toContain('Read');
  expect(replaceReason('Get-ChildItem -Recurse tools')).toContain('Glob');
  expect(replaceReason('dir /s src')).toContain('Glob');
  expect(replaceReason('Select-String -Pattern foo -Path x.js')).toContain('Grep');
  expect(replaceReason('grep -rn foo src')).toContain('Grep');
});

test('replaceReason: khong chan lenh phuc tap / ghi / khac', () => {
  for (const c of ['Get-Content a.txt | Select -First 5', 'cat a > b', 'cat a; ls', 'Get-ChildItem tools', 'ls -la', 'git status',
    'Get-Content -Tail 5 a', 'node x.mjs && cat a', 'echo $(cat a)', 'grep foo a | wc -l', 'Get-Content a\nGet-Content b', ''])
    expect(replaceReason(c)).toBeNull();
  expect(replaceReason(undefined)).toBeNull();
});

test('isReadOnly: allowlist', () => {
  for (const c of ['git status', 'git status -s', 'git log -n 5 --oneline', 'node harness/cli/commands/doctor.mjs', 'node harness/tools/sync.mjs --check', 'ls'])
    expect(isReadOnly(c)).toBe(true);
  for (const c of ['git commit -m x', 'git push', 'node harness/tools/sync.mjs', 'git status; rm x', 'git diff --output=x', 'rm a', 'git add .'])
    expect(isReadOnly(c)).toBe(false);
});

test('repeatReason: lap trong TTL bi chan 1 lan, lan sau cho qua; ghi xen giua -> khong lap', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyrep-'));
  const t = 1_000_000;
  expect(repeatReason(root, 's1', 'git status', 60000, t)).toBeNull();
  expect(repeatReason(root, 's1', 'git  STATUS', 60000, t + 5000)).toContain('vua chay');
  expect(repeatReason(root, 's1', 'git status', 60000, t + 6000)).toBeNull(); // da chan 1 lan -> cho qua
  expect(repeatReason(root, 's1', 'git status', 60000, t + 200000)).toBeNull(); // het TTL
  expect(repeatReason(root, 's1', 'git status', 60000, t + 200100)).toContain('vua chay');
  noteMutation(root, 's1', t + 200200);
  expect(repeatReason(root, 's1', 'git status', 60000, t + 200300)).toBeNull();
  expect(repeatReason(root, 's2', 'git status', 60000, t + 200400)).toBeNull(); // conversation khac
  expect(repeatReason(root, 's1', 'echo a > f', 60000, t + 200500)).toBeNull(); // lenh ghi -> khong chan
  expect(repeatReason(null, 's1', 'git status')).toBeNull(); // fail-open
  fs.rmSync(root, { recursive: true, force: true });
});

test('agyDecide: replace + repeat, tat bang cfg', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyrep-'));
  const call = (c) => ({ conversationId: 'c', toolCall: { name: 'run_command', args: { CommandLine: c } } });
  const r = agyDecide(call('Get-Content a.txt'), DEFAULTS, root);
  expect(r.decision).toBe('deny');
  expect(r.reason).toContain('Read');
  expect(agyDecide(call('Get-Content a.txt'), { ...DEFAULTS, agy_replace: false }, root)).toEqual({ decision: 'allow' });
  expect(agyDecide(call('git status'), DEFAULTS, root)).toEqual({ decision: 'allow' });
  expect(agyDecide(call('git status'), DEFAULTS, root).decision).toBe('deny');
  expect(agyDecide(call('git status'), { ...DEFAULTS, agy_repeat: false }, root)).toEqual({ decision: 'allow' });
  fs.rmSync(root, { recursive: true, force: true });
});
