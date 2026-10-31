import { test, expect } from 'bun:test';
import { safeId } from './safe-id.mjs';
import { logPath, runsDir } from './safe-id.mjs';
import path from 'node:path';

test('safeId giu dau cham, bo ky tu la, cat 80', () => {
  expect(safeId('a.b c/d_e-f')).toBe('a.bcd_e-f');
  expect(safeId('x'.repeat(100)).length).toBe(80);
  expect(safeId(undefined)).toBe('');
});
test('ten file runs khop run_id audit khi id co dau cham', () => {
  const id = 'claude-t.1-abc';
  expect(path.basename(logPath('/r', id))).toBe(safeId(id) + '.log');
});
test('workspace co hub/dispatch manifest (extRoots hub) -> runs o system/runs ca hai mode', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sid-ws-'));
  const pdata = path.join(ws, '.pdata');
  // hub mode doc <ws>/config/workspace; plugin mode doc lop may (CLAUDE_PLUGIN_DATA/config/workspace/local.json). Lop du an khong duoc dat extRoots.
  for (const d of [path.join(ws, 'config', 'workspace'), path.join(pdata, 'config', 'workspace'), path.join(ws, 'hub', 'dispatch'), path.join(ws, 'harness', 'observe', 'storage')]) fs.mkdirSync(d, { recursive: true });
  // hub mode doc registry.json o <ws>/harness (thieu -> registry fail-open, khong nap manifest); plugin mode doc registry cua plugin.
  fs.writeFileSync(path.join(ws, 'harness', 'observe', 'storage', 'registry.json'), JSON.stringify({ enforce: 'warn', entries: {} }));
  fs.writeFileSync(path.join(ws, 'config', 'workspace', 'default.json'), JSON.stringify({ extRoots: ['hub'] }));
  fs.writeFileSync(path.join(pdata, 'config', 'workspace', 'local.json'), JSON.stringify({ extRoots: ['hub'] }));
  fs.writeFileSync(path.join(ws, 'hub', 'dispatch', 'manifest.json'), JSON.stringify({ id: 'dispatch', data: [{ zone: 'system', path: 'runs', class: 'log', tool: 'runs', legacy: 'runs' }] }));
  const keys = ['HUB_DATA_DIR', 'HUB_DIR', 'CLAUDE_PLUGIN_DATA'];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const base = path.join(ws, 'dd');
  Object.assign(process.env, { HUB_DATA_DIR: base, HUB_DIR: ws, CLAUDE_PLUGIN_DATA: pdata });
  try {
    expect(runsDir(ws)).toBe(path.join(base, 'system', 'runs'));
  } finally {
    for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
});
test('HUB_DATA_DIR: runs/play/audit cung nam duoi do', async () => {
  const { dataRoot, isPluginMode } = await import('./paths.mjs');
  const old = { d: process.env.HUB_DATA_DIR };
  process.env.HUB_DATA_DIR = path.resolve('/tmp-x-data');
  try {
    const base = path.resolve('/tmp-x-data');
    // Workspace gia '/whatever' khong co hub/dispatch manifest -> registry khong co muc runs -> phang ca hai mode (dung).
    const zone = '';
    expect(runsDir('/whatever')).toBe(path.join(base, zone, 'runs'));
    expect(dataRoot('play', { repoDir: '/whatever' })).toBe(path.join(base, 'play'));
  } finally {
    if (old.d === undefined) delete process.env.HUB_DATA_DIR; else process.env.HUB_DATA_DIR = old.d;
  }
});
