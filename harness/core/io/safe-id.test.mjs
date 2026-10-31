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
test('HUB_DATA_DIR: runs/play/audit cung nam duoi do', async () => {
  const { dataRoot, isPluginMode } = await import('./paths.mjs');
  const old = { d: process.env.HUB_DATA_DIR };
  process.env.HUB_DATA_DIR = path.resolve('/tmp-x-data');
  try {
    const base = path.resolve('/tmp-x-data');
    // plugin mode: registry plugin dat runs o zone system
    const zone = isPluginMode() ? 'system' : '';
    expect(runsDir('/whatever')).toBe(path.join(base, zone, 'runs'));
    expect(dataRoot('play', { repoDir: '/whatever' })).toBe(path.join(base, 'play'));
  } finally {
    if (old.d === undefined) delete process.env.HUB_DATA_DIR; else process.env.HUB_DATA_DIR = old.d;
  }
});
