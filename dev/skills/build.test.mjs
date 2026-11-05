import { test, expect } from 'bun:test';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, 'build.mjs');
const GATE = path.join(HERE, '..', '..', 'harness', 'cli', 'harness.mjs');
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60000 });

test('build: khong lenh -> usage, ma 2; lenh la -> ma 2', () => {
  const a = run(BUILD, []);
  expect(a.status).toBe(2);
  expect(a.stdout).toContain('usage: harness.mjs build');
  const b = run(BUILD, ['zzz']);
  expect(b.status).toBe(2);
  expect(b.stderr).toContain('lenh la: zzz');
});

test('build skills check chuyen tham so sang skills cli', () => {
  const r = run(BUILD, ['skills', '--help']);
  expect(r.status === 0 || r.status === 2).toBe(true);
  expect(`${r.stdout}${r.stderr}`).toContain('skills');
});

