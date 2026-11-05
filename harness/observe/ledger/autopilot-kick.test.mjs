import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kickAutopilot, AUTOPILOT_SCRIPT } from './autopilot-kick.mjs';
import { dataPathFor } from '../../core/io/storage.mjs';

const NOW = Date.parse('2026-11-05T12:00:00Z');

test('kick autopilot: qua han -> spawn 1 lan (khoa); lastRun moi -> khong; script ton tai', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'apkick-')); const env = { HUB_DATA_DIR: d }; let n = 0;
  const spawnAutopilot = () => { n++; };
  assert.equal(fs.existsSync(AUTOPILOT_SCRIPT), true);
  assert.equal(kickAutopilot({ env }, { spawnAutopilot }, NOW), true);
  assert.equal(kickAutopilot({ env }, { spawnAutopilot }, NOW + 1000), false); // khoa
  assert.equal(n, 1);
  const dir = dataPathFor('evolve', 'autopilot', { quiet: true, env });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ lastRun: NOW }));
  fs.rmSync(path.join(dir, 'kick.json'));
  assert.equal(kickAutopilot({ env }, { spawnAutopilot }, NOW + 3600e3), false); // <24h
  assert.equal(kickAutopilot({ env }, { spawnAutopilot }, NOW + 25 * 3600e3), true);
  fs.rmSync(d, { recursive: true, force: true });
});
