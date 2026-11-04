// route-check QUA dispatcher that (hooks/dispatch/run.mjs): warn hien qua systemMessage, block qua {decision:'block'}.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const RUN = path.join(ROOT, 'harness', 'hooks', 'dispatch', 'run.mjs');
const BAD = 'status: done\nserves: x\nassumptions: y\ncounter: khong co\nadopted: z';

function dispatch(mode, extra = {}, msg = BAD) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'route-disp-'));
  const audit = path.join(d, 'audit'); fs.mkdirSync(audit, { recursive: true });
  const env = { ...process.env, HUB_DATA_DIR: path.join(d, 'data'), CLAUDE_AUDIT_DIR: audit, GUARD_LOG_FILE: path.join(d, 'g.jsonl'), HUB_DIR: ROOT, HOOK_VERIFY_GATE_ROUTEFIELDS: mode };
  const input = JSON.stringify({ hook_event_name: 'SubagentStop', session_id: 'rd1', agent_id: 'a1', agent_type: 'builder', cwd: d, last_assistant_message: msg, ...extra });
  const r = spawnSync(process.execPath, [RUN, 'SubagentStop', 'verify-gate'], { input, env, encoding: 'utf8', timeout: 60000 });
  let out = {}; try { out = r.stdout.trim() ? JSON.parse(r.stdout) : {}; } catch {}
  return { out, status: r.status };
}

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
