import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncCoreMirror, mirrorRoot, pickCoreMirror } from './core-mirror.mjs';
import { pluginLayerDirs } from '../config/config.mjs';

const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
function fixture() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-'));
  const root = path.join(t, 'plug'); const data = path.join(t, 'data');
  w(path.join(root, 'harness', 'core', 'ext', 'ctx.mjs'), 'export const a=1');
  w(path.join(root, 'harness', 'core', 'ext', 'ctx.test.mjs'), 'test');
  w(path.join(root, 'harness', 'x', 'y.mjs'), 'y');
  w(path.join(root, '.antigravity-plugin', 'plugin.json'), '{"version":"1.2.3"}');
  return { t, root, data };
}

test('copy, bo test, stamp -> fresh lan 2, doi file -> copy lai, prune ban khac', () => {
  const { root, data } = fixture();
  fs.mkdirSync(path.join(data, 'core', '0.0.1'), { recursive: true });
  const a = syncCoreMirror({ pluginRoot: root, dataDir: data, version: '1.2.3' });
  expect(a.action).toBe('copied');
  const d = mirrorRoot(data, '1.2.3');
  expect(fs.existsSync(path.join(d, 'harness', 'core', 'ext', 'ctx.mjs'))).toBe(true);
  expect(fs.existsSync(path.join(d, 'harness', 'core', 'ext', 'ctx.test.mjs'))).toBe(false);
  expect(fs.existsSync(path.join(d, '.antigravity-plugin', 'plugin.json'))).toBe(true);
  expect(fs.existsSync(path.join(data, 'core', '0.0.1'))).toBe(false);
  expect(syncCoreMirror({ pluginRoot: root, dataDir: data, version: '1.2.3' }).action).toBe('fresh');
  w(path.join(root, 'harness', 'x', 'y.mjs'), 'changed!');
  expect(syncCoreMirror({ pluginRoot: root, dataDir: data, version: '1.2.3' }).action).toBe('copied');
  expect(fs.readFileSync(path.join(d, 'harness', 'x', 'y.mjs'), 'utf8')).toBe('changed!');
  expect(fs.readdirSync(path.join(data, 'core'))).toEqual(['1.2.3']);
});

test('vuot gioi han / thieu nguon -> khong nem, khong de lai ban sao', () => {
  const { root, data } = fixture();
  const r = syncCoreMirror({ pluginRoot: root, dataDir: data, version: '1.2.3', limits: { maxFiles: 1 } });
  expect(r.ok).toBe(false);
  expect(fs.existsSync(mirrorRoot(data, '1.2.3'))).toBe(false);
  expect(syncCoreMirror({ pluginRoot: path.join(root, 'nope'), dataDir: data, version: '1' }).ok).toBe(false);
});

test('pickCoreMirror: sach -> dung; sua file / them file .mjs -> tu choi + warn; khong agy -> null', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-'));
  const root = path.join(t, '.gemini', 'config', 'plugins', 'harness-kit');
  w(path.join(root, 'harness', 'core', 'ext', 'ctx.mjs'), 'export const a=1');
  w(path.join(root, 'harness', 'x', 'y.mjs'), 'y');
  w(path.join(root, '.antigravity-plugin', 'plugin.json'), '{"version":"1.2.3"}');
  const data = path.join(t, '.gemini', 'antigravity-cli', 'plugin_data', 'harness-kit');
  expect(syncCoreMirror({ pluginRoot: root, dataDir: data, version: '1.2.3' }).ok).toBe(true);
  const env = { ANTIGRAVITY_AGENT: '1' };
  const ok = pickCoreMirror({ root, env });
  expect(ok.dir).toBe(mirrorRoot(data, '1.2.3'));
  expect(pickCoreMirror({ root, env: {} })).toBe(null);
  const t0 = performance.now(); pickCoreMirror({ root, env }); console.log('verify ms', (performance.now() - t0).toFixed(1));
  const y = path.join(ok.dir, 'harness', 'x', 'y.mjs');
  fs.writeFileSync(y, 'evil');
  expect(pickCoreMirror({ root, env }).warn).toContain('y.mjs');
  fs.writeFileSync(y, 'y');
  expect(pickCoreMirror({ root, env }).dir).toBe(ok.dir);
  w(path.join(ok.dir, 'harness', 'x', 'extra.mjs'), 'evil');
  expect(pickCoreMirror({ root, env }).warn).toContain('extra.mjs');
});

test('pluginLayerDirs nhan ra layout ban sao -> primaryDir agy', () => {
  const pd = path.join('C:', 'u', '.gemini', 'antigravity-cli', 'plugin_data', 'harness-kit');
  const d = pluginLayerDirs({ env: {}, repoDir: path.join(pd, 'core', '0.4.5') });
  expect(path.resolve(d.primaryDir)).toBe(path.resolve(pd));
  expect(path.resolve(d.machineDir)).toBe(path.resolve(pd, 'config'));
});
