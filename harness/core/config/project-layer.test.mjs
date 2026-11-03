// Plugin mode: lop du an (workspace/.harness/config/<tool>/project.json) khong tin cay; chi whitelist khoa duoc dat.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, PROJECT_LAYER_ALLOW } from './config.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const wj = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };

function load(tool, projectJson, defaults = {}) {
  const plugin = tmp('plug-'), prj = tmp('prj-'), pdata = tmp('pdata-');
  wj(path.join(plugin, '.claude-plugin', 'plugin.json'), { name: 'x-kit' });
  wj(path.join(prj, '.harness', 'config', tool, 'project.json'), projectJson);
  const env = { CLAUDE_PROJECT_DIR: prj, CLAUDE_PLUGIN_DATA: pdata };
  try { return loadConfig(tool, { env, repoDir: plugin, root: plugin, defaults }); }
  finally { for (const d of [plugin, prj, pdata]) fs.rmSync(d, { recursive: true, force: true }); }
}

test('workspace/project.json doc hai bi chan hoan toan', () => {
  const r = load('workspace', { projectResolver: '../../evil.mjs', extRoots: ['/tmp/x'], ownerRoots: ['/tmp/y'], other: 1 });
  expect(r.config.projectResolver).toBeUndefined();
  expect(r.config.extRoots).toBeUndefined();
  expect(r.config.ownerRoots).toBeUndefined();
  expect(r.config.other).toBeUndefined();
  expect(r.warnings.filter((w) => /khong duoc phep o lop du an/.test(w)).length).toBe(4);
});

test('knowledge.root tu lop du an bi chan', () => {
  const r = load('knowledge', { root: 'C:/evil', probe: { allow: [['rm']] } }, { root: '' });
  expect(r.config.root).toBe('');
  expect(r.config.probe).toBeUndefined();
});

test('extensions/extRoots tu lop du an bi chan o moi tool (ext, workspace, guard)', () => {
  const bad = { extensions: { 'C:/x': [{ id: 'evil', root: 'e', hash: 'h' }] }, extRoots: ['C:/evil'] };
  for (const tool of ['ext', 'workspace', 'guard']) {
    const r = load(tool, bad);
    expect(r.config.extensions).toBeUndefined();
    expect(r.config.extRoots).toBeUndefined();
    expect(r.warnings.filter((w) => /khoa "(extensions|extRoots)" khong duoc phep o lop du an/.test(w)).length).toBe(2);
  }
  expect(Object.keys(PROJECT_LAYER_ALLOW)).toEqual(['guard']);
});

test('guard: lop du an chi duoc them denyPatterns/allowlist/protectedPaths; khoa khac bi bo', () => {
  expect(PROJECT_LAYER_ALLOW.guard).toEqual(['denyPatterns', 'allowlist', 'protectedPaths']);
  const r = load('guard', { logFile: '../../x', denyPatterns: [{ id: 'p1', pattern: 'zz', reason: 'r' }] }, { logFile: 'safe.log', denyPatterns: [] });
  expect(r.config.logFile).toBe('safe.log');
  expect(r.config.denyPatterns.map((d) => d.id)).toEqual(['p1']);
});
