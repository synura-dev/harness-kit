import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as configRun } from './config.mjs';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slim2-'));
const put = (root, rel, obj) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj)); };

// HARNESS_CONFIG_DIR ep layering hub (plugin mode se tron config plugin vao ket qua)

test('config sources: usage error without tool; prints key sources without values', () => {
  const errs = [];
  expect(configRun(['sources'], { cfgDir: path.join(mk(), 'config'), emitOpts: { err: (m) => errs.push(m) } }).code).toBe(2);
  expect(errs.join('')).toContain('usage');

  const root = mk();
  put(root, 'config/demo/default.json', { contextLines: 123457 });
  const r = configRun(['sources', 'demo'], { cfgDir: path.join(root, 'config'), emitOpts: {} });
  expect(r.code).toBe(0);
  const s = JSON.stringify(r);
  expect(s).toContain('contextLines');
  expect(s).not.toContain('123457');
});test('config sources: usage error without tool; prints key sources without values', () => {
  const errs = [];
  expect(configRun(['sources'], { cfgDir: path.join(mk(), 'config'), emitOpts: { err: (m) => errs.push(m) } }).code).toBe(2);
  expect(errs.join('')).toContain('usage');

  const root = mk();
  put(root, 'config/demo/default.json', { contextLines: 123457 });
  const r = configRun(['sources', 'demo'], { cfgDir: path.join(root, 'config'), emitOpts: {} });
  expect(r.code).toBe(0);
  const s = JSON.stringify(r);
  expect(s).toContain('contextLines');
  expect(s).not.toContain('123457');
});
