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

test('Pre harness doctor -> chi {decision:allow}, khong permissionOverrides', () => {
  expect(pre('harness doctor')).toEqual({ decision: 'allow' });
  expect(pre('harness knowledge get architecture')).toEqual({ decision: 'allow' });
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
  const unsafe = txt.split('\n').filter((l) => l.includes('harness-unsafe')).map((l) => JSON.parse(l));
  expect(unsafe.length).toBeGreaterThan(0);
  for (const u of unsafe) expect(u.data.gate.decision).toBe('warn'); // khong ghi allow cho lenh unsafe ('none' khong thuoc DECISIONS cua gate-event -> bi bo; 'warn' = khong can thiep + giu ly do)
  const e2 = env(); spawn(NEW, ['PreToolUse'], pay('run_command', { CommandLine: 'harness doctor' }), e2);
  const txt2 = fs.readdirSync(e2.CLAUDE_AUDIT_DIR, { recursive: true }).filter((f) => String(f).endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(e2.CLAUDE_AUDIT_DIR, String(f)), 'utf8')).join('');
  expect(txt2.split('\n').filter((l) => l.includes('harness-allow')).map((l) => JSON.parse(l).data.gate.decision)).toEqual(['allow']);
}, 60000);

test('renderAgy: safe -> chi allow (khong overrides); ask van deny; deny khong overrides', () => {
  const safe = { decision: 'allow', records: [{ sink: 'gate', data: { rule: SAFE_RULE } }] };
  expect(JSON.parse(renderAgy('PreToolUse', safe).stdout)).toEqual({ decision: 'allow' });
  expect(JSON.parse(renderAgy('PreToolUse', { ...safe, decision: 'deny', reason: 'x' }).stdout)).toEqual({ decision: 'deny', reason: 'x' });
  expect(JSON.parse(renderAgy('PreToolUse', { ...safe, decision: 'ask', reason: 'x' }).stdout).decision).toBe('deny');
  expect(JSON.parse(renderAgy('PreToolUse', { decision: 'allow' }).stdout)).toEqual({ decision: 'allow' });
  expect(JSON.parse(renderAgy('PostToolUse', safe).stdout)).toEqual({});
});

test('SessionStart agy: user-shim ghi roots.json khoa agy -> goc plugin (home tam, shim dir da tren PATH nen khong ghi PATH that)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-shim-')); const home = path.join(d, 'home');
  const shimDir = path.join(home, process.platform === 'win32' ? '.harness-kit' : '.local', 'bin'); fs.mkdirSync(shimDir, { recursive: true });
  const e = { ...process.env, NODE_ENV: '', HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(d, 'Local'), PATH: shimDir, Path: shimDir, HUB_DATA_DIR: path.join(d, 'data'), CLAUDE_AUDIT_DIR: path.join(d, 'audit') };
  delete e.HOOK_USER_SHIM_ENABLED;
  spawn(NEW, ['SessionStart', 'session-agy'], JSON.stringify({ conversationId: 'c-shim' }), e);
  const roots = JSON.parse(fs.readFileSync(path.join(shimDir, 'roots.json'), 'utf8'));
  expect(roots.agy.root).toBe(path.resolve(import.meta.dir, '..', '..', '..'));
}, 60000);

test('SessionStart agy ghi stamp khoa agy vao data root (fail-open)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-stamp-')); const data = path.join(d, 'data');
  const e = { ...process.env, HUB_DATA_DIR: data, CLAUDE_AUDIT_DIR: path.join(d, 'audit'), HOOK_USER_SHIM_ENABLED: '0' };
  const r = spawn(NEW, ['SessionStart', 'session-agy'], JSON.stringify({ conversationId: 'c-stamp' }), e);
  expect(JSON.parse(r.stdout)).toEqual({});
  const st = JSON.parse(fs.readFileSync(path.join(data, '.harness-writers.json'), 'utf8'));
  expect(Object.keys(st)).toEqual(['agy']); expect(st.agy.version).toMatch(/^\d+\.\d+\.\d+/); expect(Object.keys(st.agy).sort()).toEqual(['at', 'schema', 'version']);
}, 60000);

test('HookRun cua hook agy ghi cli=agy va sid = conversationId', () => {
  const e = env();
  spawn(NEW, ['SessionStart', 'audit-agy'], JSON.stringify({ conversationId: 'conv-hr' }), e);
  const rows = fs.readdirSync(e.CLAUDE_AUDIT_DIR, { recursive: true }).filter((f) => String(f).endsWith('.jsonl'))
    .flatMap((f) => fs.readFileSync(path.join(e.CLAUDE_AUDIT_DIR, String(f)), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const hr = rows.filter((x) => x.event === 'HookRun');
  expect(hr.length).toBeGreaterThan(0);
  for (const x of hr) { expect(x.cli).toBe('agy'); expect(x.sid).toBe('conv-hr'); }
}, 60000);
