import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extgw-'));
const _old = { d: process.env.HUB_DATA_DIR, a: process.env.CLAUDE_AUDIT_DIR };
process.env.HUB_DATA_DIR = path.join(tmp, 'data');
process.env.CLAUDE_AUDIT_DIR = path.join(tmp, 'audit');
afterAll(() => { for (const [k, v] of [['HUB_DATA_DIR', _old.d], ['CLAUDE_AUDIT_DIR', _old.a]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });
const { run } = await import('./harness.mjs');

test('cong chay domain external qua ctx; domain core khong bi ext de', () => {
  const ext = path.join(tmp, 'demo'); fs.mkdirSync(ext);
  fs.writeFileSync(path.join(ext, 'main.mjs'), `export const main = (ctx, argv) => 'demo:' + argv.join('+');`);
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ id: 'demo', entry: 'main.mjs', domains: ['demo', 'data'] }));
  const externals = [{ id: 'demo', root: ext }];
  const r = run(['demo', 'x', 'y'], root, { capture: true, externals });
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('demo:x+y');
  const core = run(['data', 'ls'], root, { capture: true, externals });
  expect(core.code).toBe(0);
  expect(core.stdout || core.text || '').not.toContain('demo:');
}, 60000);

test('cong chuyen lai co chung --json/--raw/--max-bytes cho ext; khong co co thi giu nguyen', () => {
  const ext = path.join(tmp, 'echoflags'); fs.mkdirSync(ext);
  fs.writeFileSync(path.join(ext, 'main.mjs'), `export const main = (ctx, argv) => argv.includes('--json') ? JSON.stringify({ argv }) : 'plain:' + argv.join('+');`);
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ id: 'echoflags', entry: 'main.mjs', domains: ['echoflags'] }));
  const externals = [{ id: 'echoflags', root: ext }];
  const j = run(['echoflags', 'list', '--json'], root, { capture: true, externals });
  expect(j.code).toBe(0);
  expect(JSON.parse(j.stdout).argv).toEqual(['list', '--json']);
  const raw = run(['echoflags', 'list', '--raw', '--max-bytes', '5000'], root, { capture: true, externals });
  expect(raw.code).toBe(0);
  expect(raw.stdout).toContain('plain:list+--raw+--max-bytes+5000');
  const plain = run(['echoflags', 'list'], root, { capture: true, externals });
  expect(plain.stdout).toContain('plain:list');
  expect(plain.stdout).not.toContain('--');
}, 60000);
