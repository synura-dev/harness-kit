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

// --- T2: tu cho phep lenh harness chi-doc (A1: allow + permissionOverrides); guard deny luon thang ---
import { renderAgy } from './agy.mjs';
import { SAFE_RULE } from './agy-harness.mjs';
const pre = (cmd) => JSON.parse(spawn(NEW, ['PreToolUse'], pay('run_command', { CommandLine: cmd }), env()).stdout);

test('Pre harness doctor -> allow + permissionOverrides command(harness), khong overwrite', () => {
  expect(pre('harness doctor')).toEqual({ decision: 'allow', permissionOverrides: ['command(harness)'] });
  expect(pre('harness knowledge get architecture')).toEqual({ decision: 'allow', permissionOverrides: ['command(harness)'] });
}, 60000);

test('Pre harness khong an toan / khong phai harness -> allow tran (khong overrides)', () => {
  for (const c of ['harness doctor | head', 'harness ext list', 'harness doctor --apply', 'harness', 'git status']) expect([c, pre(c)]).toEqual([c, { decision: 'allow' }]);
}, 120000);

test('guard deny van thang (lenh qua dai); unsafe ghi ly do vao audit gate', () => {
  const o = pre('echo ' + 'a'.repeat(100001));
  expect(o.decision).toBe('deny'); expect(o.permissionOverrides).toBeUndefined();
  const e = env(); spawn(NEW, ['PreToolUse'], pay('run_command', { CommandLine: 'harness doctor --apply' }), e);
  const txt = fs.readdirSync(e.CLAUDE_AUDIT_DIR, { recursive: true }).filter((f) => String(f).endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(e.CLAUDE_AUDIT_DIR, String(f)), 'utf8')).join('');
  expect(txt).toContain('harness-unsafe');
}, 60000);

test('renderAgy: allow giu permissionOverrides (marker safe trong records); ask van deny; deny khong overrides', () => {
  const safe = { decision: 'allow', records: [{ sink: 'gate', data: { rule: SAFE_RULE } }] };
  expect(JSON.parse(renderAgy('PreToolUse', safe).stdout)).toEqual({ decision: 'allow', permissionOverrides: ['command(harness)'] });
  expect(JSON.parse(renderAgy('PreToolUse', { ...safe, decision: 'deny', reason: 'x' }).stdout)).toEqual({ decision: 'deny', reason: 'x' });
  expect(JSON.parse(renderAgy('PreToolUse', { ...safe, decision: 'ask', reason: 'x' }).stdout).decision).toBe('deny');
  expect(JSON.parse(renderAgy('PreToolUse', { decision: 'allow' }).stdout)).toEqual({ decision: 'allow' });
  expect(JSON.parse(renderAgy('PostToolUse', safe).stdout)).toEqual({});
});

test('SessionStart agy ghi stamp khoa agy vao data root (fail-open)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-stamp-')); const data = path.join(d, 'data');
  const e = { ...process.env, HUB_DATA_DIR: data, CLAUDE_AUDIT_DIR: path.join(d, 'audit'), HOOK_USER_SHIM_ENABLED: '0' };
  const r = spawn(NEW, ['SessionStart', 'session-agy'], JSON.stringify({ conversationId: 'c-stamp' }), e);
  expect(JSON.parse(r.stdout)).toEqual({});
  const st = JSON.parse(fs.readFileSync(path.join(data, '.harness-writers.json'), 'utf8'));
  expect(Object.keys(st)).toEqual(['agy']); expect(st.agy.version).toMatch(/^\d+\.\d+\.\d+/); expect(Object.keys(st.agy).sort()).toEqual(['at', 'schema', 'version']);
}, 60000);
