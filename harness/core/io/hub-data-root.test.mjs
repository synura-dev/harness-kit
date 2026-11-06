// bun test harness/core/io/hub-data-root.test.mjs
// Workspace co dau hieu (config/hub|workspace/default.json): quy tac nam o LOI (khong chi o wrapper). Plugin mode + khong HUB_DATA_DIR/HARNESS_CONFIG_DIR -> <ws>/data, <ws>/config.
import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir, ensureDataIgnore } from './paths.mjs';
import { loadConfig } from '../config/config.mjs';

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hubroot-')); made.push(d); return d; };
afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const markedWs = () => { const w = tmp(); fs.mkdirSync(path.join(w, 'config', 'workspace'), { recursive: true }); fs.writeFileSync(path.join(w, 'config', 'workspace', 'default.json'), '{"zzMarker":1}'); return w; };
const plugRepo = () => { const p = tmp(); fs.mkdirSync(path.join(p, '.claude-plugin')); fs.writeFileSync(path.join(p, '.claude-plugin', 'plugin.json'), '{"name":"t"}'); return p; };

test('co dau hieu + plugin mode + khong HUB_DATA_DIR -> <ws>/data, khong tao .harness', () => {
  const plug = plugRepo(); const ws = markedWs();
  const opts = { env: { CLAUDE_PROJECT_DIR: ws }, repoDir: plug };
  expect(dataDir('audit', opts)).toBe(path.join(ws, 'data', 'audit'));
  expect(ensureDataIgnore(opts)).toBe(false);
  expect(fs.existsSync(path.join(ws, '.harness'))).toBe(false);
});

test('co dau hieu: .harness/data da ton tai van chon <ws>/data (plugin lan ban sao)', () => {
  const plug = plugRepo(); const ws = markedWs();
  fs.mkdirSync(path.join(ws, '.harness', 'data'), { recursive: true });
  expect(dataDir('x', { env: { CLAUDE_PROJECT_DIR: ws }, repoDir: plug })).toBe(path.join(ws, 'data', 'x'));
  // ban sao (source 'default', co .harness/data): truoc day bi "dinh" vao .harness/data
  expect(dataDir('x', { env: { HUB_DIR: ws }, repoDir: tmp() })).toBe(path.join(ws, 'data', 'x'));
});

test('du an sach van .harness/data; HUB_DATA_DIR van thang', () => {
  const plug = plugRepo(); const proj = tmp(); const ws = markedWs(); const d = tmp();
  expect(dataDir('x', { env: { CLAUDE_PROJECT_DIR: proj }, repoDir: plug })).toBe(path.join(proj, '.harness', 'data', 'x'));
  expect(dataDir('x', { env: { CLAUDE_PROJECT_DIR: ws, HUB_DATA_DIR: d }, repoDir: plug })).toBe(path.join(path.resolve(d), 'x'));
});

test('config: plugin mode + co dau hieu + khong HARNESS_CONFIG_DIR -> doc <ws>/config', () => {
  const plug = plugRepo(); const ws = markedWs();
  const r = loadConfig('workspace', { env: { CLAUDE_PROJECT_DIR: ws, CLAUDE_PLUGIN_DATA: path.join(ws, 'pd') }, repoDir: plug });
  expect(r.config.zzMarker).toBe(1);
});

test('config: loadConfig({root}) co dau hieu (khong qua wrapper) doc khoa trong <ws>/config/hub/default.json; HARNESS_CONFIG_DIR thang', () => {
  const plug = plugRepo(); const ws = tmp();
  fs.mkdirSync(path.join(ws, 'config', 'hub'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'config', 'hub', 'default.json'), '{"zzRoot":7}');
  const env = { CLAUDE_PROJECT_DIR: ws, CLAUDE_PLUGIN_DATA: path.join(ws, 'pd') };
  expect(loadConfig('hub', { env, repoDir: plug, root: ws }).config.zzRoot).toBe(7);
  const other = tmp(); fs.mkdirSync(path.join(other, 'hub'), { recursive: true }); fs.writeFileSync(path.join(other, 'hub', 'default.json'), '{"zzRoot":9}');
  expect(loadConfig('hub', { env: { ...env, HARNESS_CONFIG_DIR: other }, repoDir: plug, root: ws }).config.zzRoot).toBe(9);
});
