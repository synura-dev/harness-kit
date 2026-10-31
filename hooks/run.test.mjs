// Test wrapper hooks/run.mjs: env sach (khong HUB_*/HARNESS_*/CLAUDE_*), chi CLAUDE_PROJECT_DIR.
// Du an sach -> du lieu <du an>/.harness; du an co dau hieu workspace (config/hub|workspace/default.json) -> data/ + config/, khong tao .harness.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { deriveEnv } from './run.mjs';
import { workspaceMarker } from '../harness/core/io/paths.mjs';

const WRAP = path.join(import.meta.dir, 'run.mjs');
const PLUGIN = path.resolve(import.meta.dir, '..');

function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(HUB_|HARNESS_|CLAUDE_|GUARD_)/.test(k)) env[k] = v;
  return { ...env, ...extra };
}
function wsProject(marker = 'hub') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-hook-ws-'));
  fs.mkdirSync(path.join(d, 'config', marker), { recursive: true });
  fs.writeFileSync(path.join(d, 'config', marker, 'default.json'), '{}');
  fs.mkdirSync(path.join(d, 'data'));
  return d;
}
const plainProject = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-hook-plain-'));
const run = (event, input, env) => spawnSync(process.execPath, [WRAP, event], { input: JSON.stringify(input), env, encoding: 'utf8', timeout: 60000 });
const bash = (command, cwd) => ({ session_id: 's-test', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });
const decision = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision; } catch { return null; } };
const files = (dir) => { const out = []; const walk = (p) => { for (const e of fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }) : []) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else out.push(f); } }; walk(dir); return out; };

test('workspaceMarker: config/hub hoac config/workspace default.json; repo plugin va du an thuong khong tinh', () => {
  expect(workspaceMarker(wsProject('hub'))).toMatch(/hub[\\/]default\.json$/);
  expect(workspaceMarker(wsProject('workspace'))).toMatch(/workspace[\\/]default\.json$/);
  const p = plainProject(); fs.mkdirSync(path.join(p, 'config'));
  expect(workspaceMarker(p)).toBeNull();
  expect(workspaceMarker(PLUGIN)).toBeNull();
  expect(workspaceMarker('')).toBeNull();
});

test('deriveEnv: dau hieu workspace -> data/ + config/ cua du an, plugin dir', () => {
  const d = wsProject();
  const env = deriveEnv({ CLAUDE_PROJECT_DIR: d });
  expect(env.HUB_DATA_DIR).toBe(path.join(d, 'data'));
  expect(env.HARNESS_CONFIG_DIR).toBe(path.join(d, 'config'));
  expect(env.HARNESS_PLUGIN_DIR).toBe(PLUGIN);
});

test('deriveEnv: khong ghi de bien da co; CLAUDE_PLUGIN_ROOT uu tien', () => {
  const d = wsProject();
  const env = deriveEnv({ CLAUDE_PROJECT_DIR: d, HUB_DATA_DIR: '/x/data', CLAUDE_PLUGIN_ROOT: d });
  expect(env.HUB_DATA_DIR).toBe('/x/data');
  expect(env.HARNESS_CONFIG_DIR).toBe(path.join(d, 'config'));
  expect(env.HARNESS_PLUGIN_DIR).toBe(path.resolve(d));
});

test('deriveEnv: du an thuong / khong CLAUDE_PROJECT_DIR -> giu mac dinh plugin mode', () => {
  const plain = plainProject(); fs.mkdirSync(path.join(plain, 'config'));
  expect(deriveEnv({ CLAUDE_PROJECT_DIR: plain }).HUB_DATA_DIR).toBeUndefined();
  const e = deriveEnv({});
  expect(e.HUB_DATA_DIR).toBeUndefined();
  expect(e.HARNESS_CONFIG_DIR).toBeUndefined();
});

test('du an co dau hieu: force push -> deny, du lieu vao <du an>/data, khong tao .harness', () => {
  const d = wsProject();
  const r = run('PreToolUse', bash('git push --force origin main', d), cleanEnv({ CLAUDE_PROJECT_DIR: d }));
  expect(r.status === 2 || decision(r) === 'deny').toBe(true);
  expect(files(path.join(d, 'data')).length).toBeGreaterThan(0);
  expect(fs.existsSync(path.join(d, '.harness'))).toBe(false);
});

test('du an sach: force push -> deny, du lieu vao <du an>/.harness, khong tao data/', () => {
  const d = plainProject();
  const r = run('PreToolUse', bash('git push --force origin main', d), cleanEnv({ CLAUDE_PROJECT_DIR: d }));
  expect(r.status === 2 || decision(r) === 'deny').toBe(true);
  expect(files(path.join(d, '.harness')).length).toBeGreaterThan(0);
  expect(fs.existsSync(path.join(d, 'data'))).toBe(false);
  expect(r.stderr).not.toContain('rule=no-path');
});

test('PreToolUse lenh vo hai -> khong deny', () => {
  const d = wsProject();
  const r = run('PreToolUse', bash('git status', d), cleanEnv({ CLAUDE_PROJECT_DIR: d }));
  expect(r.status).toBe(0);
  expect(decision(r)).not.toBe('deny');
});

test('du an khong ton tai: khong vo', () => {
  const gone = path.join(plainProject(), 'khong-co');
  const r = run('PostToolUse', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} }, cleanEnv({ CLAUDE_PROJECT_DIR: gone }));
  expect(r.status).toBe(0);
});

test('su kien sai -> fail-open {} exit 0, co dong HKERR HK-HOOK-001', () => {
  const r = run('Bad-Event!', {}, cleanEnv());
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe('{}');
  const line = r.stderr.split('\n').find((l) => l.startsWith('HKERR '));
  expect(JSON.parse(line.slice(6)).code).toBe('HK-HOOK-001');
});
