// bun test harness/cli/commands/doctor-legacy.test.mjs - doctor canh bao <ws>/.harness/data khi workspace co dau hieu
import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DOCTOR = path.join(import.meta.dir, 'doctor.mjs');
const made = [];
afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const hub = (marker, legacy) => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'doclegacy-')); made.push(r);
  fs.mkdirSync(path.join(r, 'config', 'hub'), { recursive: true });
  if (marker) fs.writeFileSync(path.join(r, 'config', 'hub', 'default.json'), '{}');
  if (legacy) fs.mkdirSync(path.join(r, '.harness', 'data'), { recursive: true });
  return r;
};
const run = (h) => spawnSync('node', [DOCTOR], { encoding: 'utf8', timeout: 60000, env: { ...process.env, HUB_DIR: h } }).stdout;

test('doctor: marker + .harness/data -> canh bao kem lenh sua', () => {
  expect(run(hub(true, true))).toContain('harness data adopt --legacy-harness');
});
test('doctor: khong .harness/data hoac khong marker -> khong canh bao', () => {
  expect(run(hub(true, false))).not.toContain('--legacy-harness');
  expect(run(hub(false, true))).not.toContain('--legacy-harness');
});
