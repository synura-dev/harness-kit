// pluginLayerDirs: CLI (khong env) va hook (CLAUDE_PLUGIN_DATA=<plugin>-<mkt>) phai ra CUNG thu muc may.
import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pluginLayerDirs } from './config.mjs';
import { guardConfigHealth } from './guard-health.mjs';

const tmps = [];
afterAll(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const reg = (d) => { fs.mkdirSync(path.join(d, 'config', 'ext'), { recursive: true }); fs.writeFileSync(path.join(d, 'config', 'ext', 'local.json'), '{"extensions":{}}'); };
const mk = () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'pdid-')); tmps.push(t);
  const repo = path.join(t, 'plugins', 'cache', 'mkt', 'harness-kit', '1.0.0');
  fs.mkdirSync(path.join(repo, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'harness-kit' }));
  const data = path.join(t, 'plugins', 'data');
  return { t, repo, data, primary: path.join(data, 'harness-kit-mkt'), legacy: path.join(data, 'harness-kit') };
};
const cfg = (d) => { fs.mkdirSync(path.join(d, 'config'), { recursive: true }); };
const env0 = (x = {}) => ({ CLAUDE_PROJECT_DIR: os.tmpdir(), ...x });

test('legacy co config, primary thieu, khong env -> legacy', () => {
  const m = mk(); cfg(m.legacy);
  expect(pluginLayerDirs({ env: env0(), repoDir: m.repo }).machineDir).toBe(path.join(m.legacy, 'config'));
});

test('env primary (rong) -> CUNG machineDir voi khong env (bug goc)', () => {
  const m = mk(); cfg(m.legacy); fs.mkdirSync(m.primary, { recursive: true });
  const a = pluginLayerDirs({ env: env0(), repoDir: m.repo }).machineDir;
  const b = pluginLayerDirs({ env: env0({ CLAUDE_PLUGIN_DATA: m.primary }), repoDir: m.repo }).machineDir;
  expect(b).toBe(a);
  expect(b).toBe(path.join(m.legacy, 'config'));
});

test('primary config RONG + legacy co registry -> legacy, co hoac khong env', () => {
  const m = mk(); reg(m.legacy); cfg(m.primary);
  const want = path.join(m.legacy, 'config');
  expect(pluginLayerDirs({ env: env0(), repoDir: m.repo }).machineDir).toBe(want);
  expect(pluginLayerDirs({ env: env0({ CLAUDE_PLUGIN_DATA: m.primary }), repoDir: m.repo }).machineDir).toBe(want);
});

test('primary co ext/local.json -> dung primary, co hoac khong env', () => {
  const m = mk(); reg(m.legacy); reg(m.primary);
  const want = path.join(m.primary, 'config');
  expect(pluginLayerDirs({ env: env0(), repoDir: m.repo }).machineDir).toBe(want);
  expect(pluginLayerDirs({ env: env0({ CLAUDE_PLUGIN_DATA: m.primary }), repoDir: m.repo }).machineDir).toBe(want);
});

test('khong legacy, khong primary -> primary suy tu id', () => {
  const m = mk();
  expect(pluginLayerDirs({ env: env0(), repoDir: m.repo }).machineDir).toBe(path.join(m.primary, 'config'));
});

test('repoDir ngoai cache -> hanh vi cu (~/.claude/plugins/data/<name>)', () => {
  const m = mk(); const other = path.join(m.t, 'src'); fs.mkdirSync(path.join(other, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(other, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'zz-kit' }));
  expect(pluginLayerDirs({ env: env0(), repoDir: other }).machineDir)
    .toBe(path.join(os.homedir(), '.claude', 'plugins', 'data', 'zz-kit', 'config'));
});

test('health: legacy con registry ma may dung primary -> canh bao tach', () => {
  const m = mk(); reg(m.legacy); reg(m.primary);
  const r = guardConfigHealth({ hubRoot: m.repo, env: env0(), repoDir: m.repo });
  expect(r.some((x) => x.split && /tach/.test(x.problem))).toBe(true);
});

test('health: legacy dang duoc dung (primary rong) -> khong canh bao', () => {
  const m = mk(); reg(m.legacy); cfg(m.primary);
  const r = guardConfigHealth({ hubRoot: m.repo, env: env0(), repoDir: m.repo });
  expect(r.some((x) => x.split)).toBe(false);
});
