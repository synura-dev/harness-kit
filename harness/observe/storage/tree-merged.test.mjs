import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { treeCmd, TREE_START } from './register.mjs';

function mk() {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'treem-'));
  const registryFile = path.join(hub, 'registry.json');
  fs.writeFileSync(registryFile, JSON.stringify({ entries: {
    'system/audit/runs': { class: 'log', owner: 'tools/a', retentionDays: 30 },
    'workspaces/*/events': { pattern: true, tool: 'events', class: 'log', owner: 'tools/ev', retentionDays: 14 },
  }, reserved: [] }));
  fs.mkdirSync(path.join(hub, 'data', 'workspaces', 'gem', 'events'), { recursive: true });
  return { hubRoot: hub, dataDir: path.join(hub, 'data'), registryFile, wsDir: path.join(hub, 'ws-none'), readmeFile: path.join(hub, 'README.md') };
}

test('tree dung registry hop nhat: entry thuong + mau workspaces/*/<tool> + muc suy ra theo ws', () => {
  const c = mk();
  const t = treeCmd([], c).lines.join('\n');
  expect(t).not.toContain('registry rong');
  expect(t).toContain('system/');
  expect(t).toMatch(/workspaces\/\n {2}\*\/\n {4}events {2}\[log\] owner=tools\/ev retention=14d/);
  expect(t).toMatch(/ {2}gem\/\n {4}events .*\(derived\)/);
});

test('tree --write-readme van ghi khoi cay', () => {
  const c = mk();
  const r = treeCmd(['--write-readme'], c);
  expect(r.code).toBe(0);
  expect(fs.readFileSync(c.readmeFile, 'utf8')).toContain(TREE_START);
});
