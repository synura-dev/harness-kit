// agy dispatcher: output == gop output adapter agy cu (stub audit pre + bash-guard agy) cho cung stdin; fail-open dung dinh dang agy.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HARNESS = path.resolve(import.meta.dir, '..', '..');
const NEW = path.join(HARNESS, 'hooks', 'dispatch', 'agy.mjs');
const OLD_AUDIT = path.join(HARNESS, 'observe', 'audit', 'adapters', 'agy.mjs');
const OLD_BG = path.join(HARNESS, 'constrain', 'bash-guard', 'adapters', 'agy.mjs');
const env = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-agy-')); return { ...process.env, HUB_DATA_DIR: path.join(d, 'data'), CLAUDE_AUDIT_DIR: path.join(d, 'audit') }; };
const spawn = (s, a, input, e) => spawnSync(process.execPath, [s, ...a], { input, env: e, encoding: 'utf8', timeout: 30000 });
const pay = (name, args) => JSON.stringify({ conversationId: 'conv-eq', stepIdx: 1, workspacePaths: [HARNESS], toolCall: { name, args } });

test('PreToolUse run_command ls -> allow (nhu audit pre cu + bash-guard cu)', () => {
  const e1 = env(); const e2 = env(); const p = pay('run_command', { CommandLine: 'ls' });
  const o1 = spawn(OLD_AUDIT, ['pre'], p, e1); const o2 = spawn(OLD_BG, [], p, e1);
  const n = spawn(NEW, ['PreToolUse'], p, e2);
  expect(JSON.parse(o1.stdout)).toEqual({ decision: 'allow' }); expect(JSON.parse(o2.stdout)).toEqual({ decision: 'allow' });
  expect(JSON.parse(n.stdout)).toEqual({ decision: 'allow' }); expect(n.status).toBe(0);
}, 60000);

test('PreToolUse python - -> deny giong bash-guard agy cu', () => {
  const e1 = env(); const e2 = env(); const p = pay('run_command', { CommandLine: 'python -' });
  const o = JSON.parse(spawn(OLD_BG, [], p, e1).stdout);
  const n = JSON.parse(spawn(NEW, ['PreToolUse'], p, e2).stdout);
  expect(o.decision).toBe('deny'); expect(n).toEqual(o);
}, 60000);

test('PostToolUse / Stop -> {} va ghi 1 ban audit; chi audit-agy khi loc', () => {
  const e = env(); const p = pay('run_command', { CommandLine: 'echo hi' });
  expect(JSON.parse(spawn(NEW, ['PostToolUse'], p, e).stdout)).toEqual({});
  const files = fs.readdirSync(e.CLAUDE_AUDIT_DIR, { recursive: true }).filter((f) => String(f).endsWith('.jsonl'));
  expect(files.length).toBeGreaterThan(0);
  expect(JSON.parse(spawn(NEW, ['SessionStart', 'audit-agy'], JSON.stringify({ conversationId: 'c' }), e).stdout)).toEqual({});
}, 60000);

test('loi: JSON hong / rong -> Pre allow, khac {}; su kien la -> {}', () => {
  const e = env();
  expect(JSON.parse(spawn(NEW, ['PreToolUse'], '{bad', e).stdout)).toEqual({ decision: 'allow' });
  expect(JSON.parse(spawn(NEW, ['PreToolUse'], '', e).stdout)).toEqual({ decision: 'allow' });
  expect(JSON.parse(spawn(NEW, ['PostToolUse'], '{bad', e).stdout)).toEqual({});
  expect(JSON.parse(spawn(NEW, ['Nope'], '{}', e).stdout)).toEqual({});
}, 60000);
