import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, run, sidOf, handle, MODULE } from './hook.mjs';
import { validateHookModule, validateHookResult } from '../../core/config/contract.mjs';
import { decide, scopeEvents, kindOf, outcomeOf } from './gate.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hook.mjs');
const SID = 'abc-123';
const NOW = new Date('2026-10-29T10:00:00.000Z');
let n = 0;
const ts = () => new Date(NOW.getTime() - 600000 + (n++) * 1000).toISOString();

function mkRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vgate-')); }
function put(root, type, env) {
  const dir = path.join(root, 'date=2026-10-29', `type=${type}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `claude-${SID}.jsonl`), JSON.stringify({ v: 2, sid: `claude-${SID}`, agent_id: null, ...env, type }) + '\n');
}
const prompt = (root, extra = {}) => put(root, 'prompt', { ts: ts(), event: 'UserPromptSubmit', ...extra });
const edit = (root, file = 'src/a.ts', extra = {}) => put(root, 'tool', { ts: ts(), event: 'PostToolUse', tool: 'Edit', target: file, ok: true, data: { files_touched: [file] }, ...extra });
const bash = (root, cmd, data = {}, extra = {}) => put(root, 'tool', { ts: ts(), event: 'PostToolUse', tool: 'Bash', target: cmd, ok: true, data: { bg: false, ...data }, ...extra });
const stop = (extra = {}) => ({ hook_event_name: 'Stop', session_id: SID, stop_hook_active: false, ...extra });
const go = (root, inp) => run(inp, { cfg: DEFAULTS, root, now: NOW });
const gateLines = (root) => { try { return fs.readFileSync(path.join(root, 'date=2026-10-29', 'type=gate', `claude-${SID}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };

test('sua code + khong test -> block + ghi vet', () => {
  const r0 = mkRoot(); prompt(r0); edit(r0);
  const r = go(r0, stop());
  expect(r.decision).toBe('block');
  expect(r.out.decision).toBe('block');
  expect(r.out.reason).toMatch(/test\/tsc/);
  expect(gateLines(r0).at(-1).data.gate.decision).toBe('block');
});

test('sua code + test pass sau sua -> cho qua', () => {
  const r0 = mkRoot(); prompt(r0); edit(r0); bash(r0, 'bun test', { verifier_outcome: 'pass', verify_kind: 'test' });
  expect(go(r0, stop()).decision).toBe('allow');
});

test('du phong verifyKind khi audit chua co verify_kind (tsc)', () => {
  const r0 = mkRoot(); prompt(r0); edit(r0); bash(r0, 'timeout 60 bunx tsc --noEmit', { verifier_outcome: 'pass' });
  expect(go(r0, stop()).code).toBe('evidence_ok');
});

test('test pass TRUOC lan sua cuoi -> block', () => {
  const r0 = mkRoot(); prompt(r0); edit(r0); bash(r0, 'bun test', { verifier_outcome: 'pass', verify_kind: 'test' }); edit(r0, 'src/b.mjs');
  expect(go(r0, stop()).decision).toBe('block');
});

test('test fail sau sua -> block', () => {
  const r0 = mkRoot(); prompt(r0); edit(r0); put(r0, 'tool', { ts: ts(), event: 'PostToolUseFailure', tool: 'Bash', target: 'bun test', ok: false, data: { verifier_outcome: 'fail', exit_code: 1 } });
  expect(go(r0, stop()).decision).toBe('block');
});

test('stop lan 2 (stop_hook_active) -> cho qua + ghi vet', () => {
  const r0 = mkRoot(); prompt(r0); edit(r0);
  const r = go(r0, stop({ stop_hook_active: true }));
  expect(r.decision).toBe('allow');
  expect(r.code).toBe('already_blocked_stop_hook_active');
  expect(gateLines(r0).at(-1).data.gate.rule).toBe('already_blocked_stop_hook_active');
});

test('stop lan 2 (dau block trong audit, khong co stop_hook_active) -> cho qua', () => {
  const r0 = mkRoot(); prompt(r0); edit(r0);
  expect(go(r0, stop()).decision).toBe('block');
  const r = run(stop(), { cfg: DEFAULTS, root: r0, now: new Date(NOW.getTime() + 60000) });
  expect(r.decision).toBe('allow');
  expect(r.code).toBe('already_blocked_audit');
});

test('luot moi (UserPromptSubmit sau block) -> dau block cu khong tinh', () => {
  const r0 = mkRoot(); prompt(r0); edit(r0);
  expect(go(r0, stop()).decision).toBe('block');
  const later = new Date(NOW.getTime() + 60000).toISOString();
  put(r0, 'prompt', { ts: later, event: 'UserPromptSubmit' });
  put(r0, 'tool', { ts: new Date(NOW.getTime() + 61000).toISOString(), event: 'PostToolUse', tool: 'Write', target: 'x.py', ok: true, data: {} });
  expect(run(stop(), { cfg: DEFAULTS, root: r0, now: new Date(NOW.getTime() + 62000) }).decision).toBe('block');
});

test('chi doc/tra cuu -> cho qua; sua .md khong tinh la code', () => {
  const r0 = mkRoot(); prompt(r0);
  put(r0, 'tool', { ts: ts(), event: 'PostToolUse', tool: 'Read', target: 'src/a.ts', ok: true, data: {} });
  bash(r0, 'git status');
  edit(r0, 'docs/x.md');
  const r = go(r0, stop());
  expect(r.decision).toBe('allow');
  expect(r.code).toBe('no_change');
});

test('audit hong -> fail-open + ghi vet', () => {
  const r0 = mkRoot(); prompt(r0); edit(r0);
  fs.appendFileSync(path.join(r0, 'date=2026-10-29', 'type=tool', `claude-${SID}.jsonl`), '{hong json\n');
  const r = go(r0, stop());
  expect(r.decision).toBe('allow');
  expect(r.code).toBe('fail_open_audit_corrupt');
  expect(gateLines(r0).at(-1).data.gate.rule).toBe('fail_open_audit_corrupt');
});

test('dong hong le (<= maxBadRatio) bi bo qua, van quyet dinh; dong cuoi chua ghi xong khong tinh hong', () => {
  const r0 = mkRoot(); prompt(r0); edit(r0);
  for (let i = 0; i < 5; i++) bash(r0, 'git status');
  const f = path.join(r0, 'date=2026-10-29', 'type=tool', `claude-${SID}.jsonl`);
  fs.appendFileSync(f, '{hong json\n');
  const r = go(r0, stop());
  expect(r.code).toBe('missing_code'); // 1/8 hong < 20%
  expect(gateLines(r0).at(-1).data.gate.reason).toMatch(/bad=1/);
  const r1 = mkRoot(); prompt(r1); edit(r1); bash(r1, 'bun test', { verifier_outcome: 'pass', verify_kind: 'test' });
  fs.appendFileSync(path.join(r1, 'date=2026-10-29', 'type=tool', `claude-${SID}.jsonl`), '{"v":2,"ts":"2026-10-29T09:59');
  expect(go(r1, stop()).code).toBe('evidence_ok');
});

test('git root that: test o thu muc khac du an -> block; cung git root -> cho qua', () => {
  const base = mkRoot(); const p1 = path.join(base, 'p1'), p2 = path.join(base, 'p2');
  for (const d of [path.join(p1, '.git'), path.join(p1, 'src'), path.join(p1, 'lib'), p2]) fs.mkdirSync(d, { recursive: true });
  const r0 = mkRoot(); prompt(r0);
  edit(r0, path.join(p1, 'src', 'a.ts'), { cwd: p1, data: { files_touched: ['src/a.ts'] } });
  bash(r0, `cd "${p2}" && bun test`, { verifier_outcome: 'pass', verify_kind: 'test' }, { cwd: p1 });
  expect(go(r0, stop({ cwd: p1 })).code).toBe('missing_code');
  bash(r0, 'cd lib && bun test', { verifier_outcome: 'pass', verify_kind: 'test' }, { cwd: p1 });
  expect(run(stop({ cwd: p1 }), { cfg: DEFAULTS, root: r0, now: NOW }).code).toBe('evidence_ok');
});

test('file sua ngoai moi git repo (thu muc tam/scratchpad) khong bi gate; repo tam co .git van bi gate; ignorePaths cau hinh', () => {
  const base = mkRoot(); const plain = path.join(base, 'plain'), repo = path.join(base, 'repo');
  for (const d of [plain, path.join(repo, '.git')]) fs.mkdirSync(d, { recursive: true });
  const fp = path.join(plain, 's.mjs'), fr = path.join(repo, 's.mjs');
  const r1 = mkRoot(); prompt(r1); edit(r1, fp, { cwd: plain });
  expect(go(r1, stop({ cwd: plain })).decision).toBe('allow');
  const r2 = mkRoot(); prompt(r2); edit(r2, fr, { cwd: repo });
  expect(go(r2, stop({ cwd: repo })).code).toBe('missing_code');
  const r3 = mkRoot(); prompt(r3); edit(r3, fr, { cwd: repo });
  expect(run(stop({ cwd: repo }), { cfg: { ...DEFAULTS, ignorePaths: [repo] }, root: r3, now: NOW }).decision).toBe('allow');
});

test('goc audit khong ton tai -> fail-open', () => {
  const r = go(path.join(os.tmpdir(), 'vgate-khong-co-' + Date.now()), stop());
  expect(r.decision).toBe('allow');
  expect(r.code).toBe('fail_open_error');
});

test('SubagentStop: chi xet su kien cua agent_id do', () => {
  const r0 = mkRoot(); prompt(r0);
  edit(r0, 'src/a.ts', { agent_id: 'ag1', actor: 'sub' });
  bash(r0, 'bun test', { verifier_outcome: 'pass' }, { agent_id: 'ag2' });
  expect(go(r0, { hook_event_name: 'SubagentStop', session_id: SID, agent_id: 'ag1', stop_hook_active: false }).decision).toBe('block');
  expect(go(r0, { hook_event_name: 'SubagentStop', session_id: SID, agent_id: 'ag2', stop_hook_active: false }).decision).toBe('allow');
  expect(go(r0, stop()).decision).toBe('allow'); // main khong sua
});

test('deploy can hash + health sau deploy', () => {
  const r0 = mkRoot(); prompt(r0);
  bash(r0, 'ssh srv "cd app && pm2 reload all"');
  expect(go(r0, stop()).code).toBe('missing_deploy');
  const r1 = mkRoot(); prompt(r1);
  bash(r1, 'ssh srv "cd app && pm2 reload all"'); bash(r1, 'git rev-parse HEAD'); bash(r1, 'curl -fsS https://x.example/health');
  expect(go(r1, stop()).decision).toBe('allow');
});

test('ham thuan: PowerShell khong co verifier_outcome -> suy tu exit/ok; nen -> none', () => {
  const e = { event: 'PostToolUse', tool: 'PowerShell', ok: true, target: 'bun test', data: {} };
  expect(kindOf(e)).toBe('test');
  expect(outcomeOf(e, 'test')).toBe('pass');
  expect(outcomeOf({ ...e, data: { bg: true } }, 'test')).toBe('none');
  expect(outcomeOf({ ...e, data: { verifier_outcome: 'none' } }, 'test')).toBe('none');
  expect(decide(scopeEvents([], { event: 'Stop' }), DEFAULTS).decision).toBe('allow');
  expect(sidOf({ session_id: 'a/b c' })).toBe('claude-abc');
  expect(sidOf({})).toBe(null);
});

test('CLI: stdin mau -> JSON block / rong; stdin hong -> exit 0', () => {
  const r0 = mkRoot(); prompt(r0, { ts: new Date(Date.now() - 5000).toISOString() });
  const dir = path.join(r0, `date=${new Date().toISOString().slice(0, 10)}`, 'type=tool');
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(path.join(r0, 'date=2026-10-29', 'type=prompt'), path.join(r0, `date=${new Date().toISOString().slice(0, 10)}`, 'type=prompt'));
  fs.appendFileSync(path.join(dir, `claude-${SID}.jsonl`), JSON.stringify({ v: 2, ts: new Date(Date.now() - 2000).toISOString(), type: 'tool', event: 'PostToolUse', tool: 'Write', target: 'a.ts', ok: true, agent_id: null, data: {} }) + '\n');
  const env = { ...process.env, CLAUDE_AUDIT_DIR: r0, HUB_CONFIG_DIR: r0 };
  const a = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(stop()), env, encoding: 'utf8', timeout: 15000 });
  expect(a.status).toBe(0);
  expect(JSON.parse(a.stdout).decision).toBe('block');
  const b = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(stop({ stop_hook_active: true })), env, encoding: 'utf8', timeout: 15000 });
  expect(b.status).toBe(0);
  expect(b.stdout).toBe('');
  const c = spawnSync(process.execPath, [HOOK], { input: 'khong phai json', env, encoding: 'utf8', timeout: 15000 });
  expect(c.status).toBe(0);
  expect(c.stdout).toBe('');
});

test('MODULE hop le; handle() truc tiep: block -> deny + reason, record.code', () => {
  expect(validateHookModule(MODULE)).toEqual([]);
  expect(MODULE.onError).toBe('open');
  const r0 = mkRoot(); prompt(r0); edit(r0);
  const r = handle('Stop', stop(), { cfg: DEFAULTS, root: r0, now: NOW });
  expect(r.decision).toBe('deny');
  expect(r.block).toBe(true);
  expect(r.reason).toMatch(/test\/tsc/);
  expect(r.record.code).toBe('missing_code');
  expect(validateHookResult(r)).toEqual([]);
  expect(gateLines(r0).at(-1).data.gate.decision).toBe('block');
});

test('handle() truc tiep: test pass -> allow; stdin rac -> allow fail-open', () => {
  const r0 = mkRoot(); prompt(r0); edit(r0); bash(r0, 'bun test', { verifier_outcome: 'pass', verify_kind: 'test' });
  const r = handle('Stop', stop(), { cfg: DEFAULTS, root: r0, now: NOW });
  expect(r).toMatchObject({ decision: 'allow', block: false });
  expect(validateHookResult(r)).toEqual([]);
  const b = handle('Stop', null, { root: mkRoot(), now: NOW });
  expect(b).toMatchObject({ decision: 'allow', block: false, record: { code: 'fail_open_bad_stdin' } });
});
