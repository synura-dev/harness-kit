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

test('ext nhan argv dung nhu go (tru domain); chi loai --timeout-s cua cong', () => {
  const ext = path.join(tmp, 'echoflags'); fs.mkdirSync(ext);
  fs.writeFileSync(path.join(ext, 'main.mjs'), `export const main = (ctx, argv) => JSON.stringify({ argv });`);
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ id: 'echoflags', entry: 'main.mjs', domains: ['echoflags'] }));
  const externals = [{ id: 'echoflags', root: ext }];
  const argvOf = (a) => { const r = run(a, root, { capture: true, externals }); expect(r.code).toBe(0); return JSON.parse(r.stdout).argv; };
  expect(argvOf(['echoflags', 'list'])).toEqual(['list']);
  expect(argvOf(['echoflags', 'list', '--json'])).toEqual(['list', '--json']);
  expect(argvOf(['echoflags', '--json', 'list'])).toEqual(['--json', 'list']);
  expect(argvOf(['echoflags', 'a', '--raw', 'b'])).toEqual(['a', '--raw', 'b']);
  expect(argvOf(['--json', 'echoflags', 'list'])).toEqual(['--json', 'list']);
  expect(argvOf(['echoflags', 'list', '--max-bytes=5000'])).toEqual(['list', '--max-bytes=5000']);
  expect(argvOf(['echoflags', 'list', '--max-bytes', '0'])).toEqual(['list', '--max-bytes', '0']);
  expect(argvOf(['echoflags', 'list', '--timeout-s', '30', '--json'])).toEqual(['list', '--json']);
  expect(argvOf(['echoflags', '--timeout-s=30', 'list'])).toEqual(['list']);
  // cong khong co danh sach co chung rieng: co la/tuong lai di thang toi ext
  expect(argvOf(['echoflags', 'list', '--future-flag', 'x'])).toEqual(['list', '--future-flag', 'x']);
}, 60000);
