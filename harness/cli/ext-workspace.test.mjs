// E2E: cong (tien trinh that) chay domain ext cua WORKSPACE khi ma loi nam o goc khac (plugin root != CLAUDE_PROJECT_DIR, nhu launcher hub).
// Truoc sua: cong khoa dang ky theo goc ma loi -> "domain la: X" exit 2, va stdout cua ext bi nuot. Hash lech van CHAN 66.
import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isPluginMode } from '../core/io/paths.mjs';

const GW = path.join(path.dirname(fileURLToPath(import.meta.url)), 'harness.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extws-'));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });
const reg = await import('./commands/ext-registry.mjs');

const ws = path.join(tmp, 'ws');
// Plugin mode: workspace = CLAUDE_PROJECT_DIR, lop may = CLAUDE_PLUGIN_DATA. Ban sao chep (khong plugin.json): workspace = HUB_DIR.
const wsEnv = isPluginMode() ? { CLAUDE_PROJECT_DIR: ws, CLAUDE_PLUGIN_DATA: path.join(tmp, 'pdata') } : { HUB_DIR: ws };
const machineFile = reg.machineFile({ env: wsEnv, workspace: ws });
const env = { ...process.env, ...wsEnv, HUB_DATA_DIR: path.join(tmp, 'data'), CLAUDE_AUDIT_DIR: path.join(tmp, 'audit') };
if (!wsEnv.HUB_DIR) delete env.HUB_DIR;
delete env.HARNESS_CONFIG_DIR;
const gw = (...a) => spawnSync(process.execPath, [GW, ...a], { cwd: tmp, env, encoding: 'utf8', timeout: 60000 });

test('domain ext dang ky o workspace chay qua cong o goc ma khac; hash lech => CHAN 66', async () => {
  const d = path.join(ws, 'hub', 'wsext'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'main.mjs'), `export const main = () => 'W-ok';`);
  fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ id: 'wsext', entry: 'main.mjs', domains: ['wsext'] }));
  expect((await reg.register('hub/wsext', { workspace: ws, machineFile, confirm: () => true })).code).toBe(0);
  expect(path.resolve(GW, '..', '..', '..')).not.toBe(path.resolve(ws));

  const ok = gw('wsext');
  expect(ok.status).toBe(0);
  expect(ok.stdout).toContain('W-ok');

  fs.writeFileSync(path.join(d, 'main.mjs'), `export const main = () => 'W-changed';`);
  const blocked = gw('wsext');
  expect(blocked.status).toBe(66);
  expect(blocked.stdout).not.toContain('W-changed');
  expect(blocked.stderr).toContain('ext approve wsext');
}, 120000);
