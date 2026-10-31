import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { candidates } from './agy-shim.mjs';

test('candidates: env > local > installed_plugins (projectPath khop truoc, roi moi nhat)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-shim-'));
  const here = path.join(d, 'p', '.agents');
  fs.mkdirSync(here, { recursive: true });
  fs.writeFileSync(path.join(here, 'harness-agy.local.json'), JSON.stringify({ pluginRoot: 'L' }));
  fs.mkdirSync(path.join(d, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(d, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {
    'harness-kit@m': [{ installPath: 'OLD', lastUpdated: '2026-01-01' }, { installPath: 'NEW', lastUpdated: '2026-02-01' }, { installPath: 'MINE', projectPath: path.join(d, 'p'), lastUpdated: '2025-01-01' }],
    'other@m': [{ installPath: 'X' }],
  } }));
  expect(candidates({ env: { HARNESS_KIT_PLUGIN_DIR: 'E' }, here, ws: path.join(d, 'p'), home: d })).toEqual(['E', 'L', 'MINE', 'NEW', 'OLD']);
  fs.rmSync(d, { recursive: true, force: true });
});
