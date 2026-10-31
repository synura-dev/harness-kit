import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadHookConfig } from './config.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-cfg-'));
const cfgDir = path.join(root, 'config');
fs.mkdirSync(path.join(cfgDir, 'tx'), { recursive: true });
const opts = (o) => ({ defaults: { a: 1, b: 1 }, configDir: cfgDir, env: {}, ...o });

test('legacy local file + warning chi co ten file', () => {
  const f = path.join(root, 'hook.config.local.json');
  fs.writeFileSync(f, '{"a":2,"secret":"S3CR3T"}');
  const r = loadHookConfig('tx', opts({ files: [f] }));
  expect(r.config.a).toBe(2);
  expect(r.warnings.some((w) => w.startsWith('legacy-config'))).toBe(true);
  expect(JSON.stringify(r.warnings)).not.toContain('S3CR3T');
});

test('config/<tool>/local.json thang file legacy; env alias thang local', () => {
  const f = path.join(root, 'hook.config.local.json');
  fs.writeFileSync(path.join(cfgDir, 'tx', 'local.json'), '{"a":3}');
  expect(loadHookConfig('tx', opts({ files: [f] })).config.a).toBe(3);
  process.env.HK_TEST_OLD_A = '9';
  const r = loadHookConfig('tx', opts({ files: [f], env: { HK_TEST_OLD_A: 'a' } }));
  delete process.env.HK_TEST_OLD_A;
  expect(r.config.a).toBe(9);
  expect(r.warnings.some((w) => w.startsWith('legacy-env'))).toBe(true);
});

test('thieu file / JSON hong khong throw', () => {
  const bad = path.join(root, 'bad.json');
  fs.writeFileSync(bad, '{oops');
  const r = loadHookConfig('tx', { defaults: { a: 1 }, files: [bad, path.join(root, 'none.json')], configDir: path.join(root, 'empty') });
  expect(r.config.a).toBe(1);
  expect(r.warnings.length).toBeGreaterThan(0);
});
