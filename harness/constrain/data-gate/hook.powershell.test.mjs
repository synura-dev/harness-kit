// data-gate: tool PowerShell duoc kiem nhu Bash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mod, { handle } from './hook.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dgps-'));
const data = path.join(tmp, 'data');
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'x.json'), '{}');
const call = (command) => handle('PreToolUse', { tool_name: 'PowerShell', tool_input: { command }, cwd: tmp }, { cfg: { enabled: true, allow: [] }, env: { HUB_DATA_DIR: data } });

test('PowerShell: chan doc data, cho qua lenh khac', async () => {
  assert.equal((await call('Get-Content data/x.json')).decision, 'deny');
  assert.notEqual((await call('Get-Content docs/a.md')).decision, 'deny');
  assert.ok(mod.tools.test('PowerShell'));
});
