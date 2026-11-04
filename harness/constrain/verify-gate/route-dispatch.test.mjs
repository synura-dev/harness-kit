// route-check QUA dispatcher that (hooks/dispatch/run.mjs): warn hien qua systemMessage, block qua {decision:'block'}.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const RUN = path.join(ROOT, 'harness', 'hooks', 'dispatch', 'run.mjs');
const BAD = 'status: done\nserves: x\nassumptions: y\ncounter: khong co\nadopted: z';

/** Seed audit: 1 lan sua file ma (agent a1) khong co bang chung test -> gate cu se block. */
function seedEdit(audit) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(audit, `date=${day}`, 'type=tool'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(ROOT, 'zz-route-fake.mjs');
  fs.writeFileSync(path.join(dir, 'claude-rd1.jsonl'), JSON.stringify({ v: 2, sid: 'claude-rd1', agent_id: 'a1', ts: new Date(Date.now() - 5000).toISOString(), type: 'tool', event: 'PostToolUse', tool: 'Edit', target: f, ok: true, data: { files_touched: [f] } }) + '\n');
}

function dispatch(mode, extra = {}, msg = BAD, seed = null) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'route-disp-'));
  const audit = path.join(d, 'audit'); fs.mkdirSync(audit, { recursive: true });
  if (seed) seed(audit);
  const env = { ...process.env, HUB_DATA_DIR: path.join(d, 'data'), CLAUDE_AUDIT_DIR: audit, GUARD_LOG_FILE: path.join(d, 'g.jsonl'), HUB_DIR: ROOT, HOOK_VERIFY_GATE_ROUTEFIELDS: mode };
  const input = JSON.stringify({ hook_event_name: 'SubagentStop', session_id: 'rd1', agent_id: 'a1', agent_type: 'builder', cwd: d, last_assistant_message: msg, ...extra });
  const r = spawnSync(process.execPath, [RUN, 'SubagentStop', 'verify-gate'], { input, env, encoding: 'utf8', timeout: 60000 });
  let out = {}; try { out = r.stdout.trim() ? JSON.parse(r.stdout) : {}; } catch {}
  return { out, status: r.status };
}

test('thieu ca bang chung test lan route -> MOT block, ly do gop', () => {
  const { out } = dispatch('block', {}, BAD, seedEdit);
  expect(out.decision).toBe('block');
  expect(out.reason).toMatch(/test\/tsc/);
  expect(out.reason).toMatch(/route-check.*counter/);
});

test('luot 2 (stop_hook_active): gate cu van nhu truoc (allow), route chi warn', () => {
  const { out } = dispatch('block', { stop_hook_active: true }, BAD, seedEdit);
  expect(out.decision).toBeUndefined();
  expect(out.systemMessage).toMatch(/counter/);
});

test('route tat + thieu bang chung -> gate cu van block nhu main', () => {
  const { out } = dispatch('off', {}, BAD, seedEdit);
  expect(out.decision).toBe('block');
  expect(out.reason).toMatch(/test\/tsc/);
  expect(out.reason).not.toMatch(/route-check/);
});

test('dispatcher warn -> systemMessage, khong chan', () => {
  const { out, status } = dispatch('warn');
  expect(status).toBe(0);
  expect(out.decision).toBeUndefined();
  expect(out.systemMessage).toMatch(/route-check.*counter/);
});

test('dispatcher block -> decision block kem ly do', () => {
  const { out } = dispatch('block');
  expect(out.decision).toBe('block');
  expect(out.reason).toMatch(/route-check.*counter/);
});

test('dispatcher block + stop_hook_active -> chi warn', () => {
  const { out } = dispatch('block', { stop_hook_active: true });
  expect(out.decision).toBeUndefined();
  expect(out.systemMessage).toMatch(/counter/);
});

test('dispatcher du truong -> khong canh bao', () => {
  const { out } = dispatch('block', {}, 'status: done\nserves: x\nassumptions: y\ncounter: gate.mjs:3\nadopted: z');
  expect(out.decision).toBeUndefined();
  expect(out.systemMessage).toBeUndefined();
});
