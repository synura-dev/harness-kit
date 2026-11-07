import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install, checkRuntime } from './install.mjs';
import { main } from './cli.mjs';

let root;
const w = (rel, txt) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); };
const r = (rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const ex = (rel) => fs.existsSync(path.join(root, ...rel.split('/')));
const rt = () => [{ name: 'node', ok: true, detail: 'x' }, { name: 'bun', ok: null, detail: 'khong co' }];
const doc = () => ({ ok: true, lines: [] });
const run = (o = {}) => install({ root, runtime: rt, doctor: doc, ...o });

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('dry-run va apply khong ghi gi vao thu muc, ok', () => {
  for (const apply of [false, true]) {
    const res = run({ apply });
    expect(res.apply).toBe(apply);
    expect(res.ok).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
  }
});

test('hook guide co trong ket qua, khong tao settings', () => {
  const res = run();
  expect(res.steps.at(-1).lines.join('\n')).toContain('settings.json');
  expect(ex('.claude/settings.json')).toBe(false);
});

test('checkRuntime: node cu bi bao MISS, bun tuy chon', () => {
  const x = checkRuntime({ nodeVersion: '16.0.0', bunVersion: null });
  expect(x[0].ok).toBe(false);
  expect(x[1].ok).toBe(null);
});

test('cli: --dry-run --skip-doctor --root chay duoc, exit 0', () => {
  let text = '';
  const code = main(['--dry-run', '--skip-doctor', '--root', root, '--json'], { out: (s) => { text += s; } });
  expect(code === 0 || code === 1).toBe(true);
  expect(ex('.claude/skills/alpha/.generated.json')).toBe(false);
});

test('cli --shim: dry-run khong ghi, ghi that idempotent, tu choi file la tru --force, --dir thieu gia tri', () => {
  const dir = path.join(root, 'userbin');
  fs.mkdirSync(dir);
  // dir da tren PATH -> khong dung PATH user; setUserPath nem neu lo bi goi (KHONG ghi PATH that)
  const shim = { pluginRoot: path.join(root, 'plugin'), env: { PATH: dir }, home: root, regPath: 'C:\\x', setUserPath: () => { throw new Error('khong duoc ghi PATH'); } };
  let text = '';
  const io = { out: (s) => { text += s; } };
  expect(main(['--shim', '--dir', dir, '--dry-run'], io, { shim })).toBe(0);
  expect(fs.readdirSync(dir)).toEqual([]);
  expect(text).toContain('se tao');
  expect(main(['--shim', '--dir', dir], io, { shim })).toBe(0);
  const names = fs.readdirSync(dir).sort();
  expect(names).toEqual(process.platform === 'win32' ? ['harness', 'harness.cmd', 'roots.json'] : ['harness', 'roots.json']);
  text = '';
  expect(main(['--shim', '--dir', dir], io, { shim })).toBe(0);
  expect(text).toContain('khop (bo qua)');
  expect(text).toContain('go: xoa');
  fs.writeFileSync(path.join(dir, names[0]), 'cua user');
  expect(main(['--shim', '--dir', dir], io, { shim })).toBe(1);
  expect(fs.readFileSync(path.join(dir, names[0]), 'utf8')).toBe('cua user');
  expect(main(['--shim', '--dir', dir, '--force'], io, { shim })).toBe(0);
  expect(fs.readFileSync(path.join(dir, names[0]), 'utf8')).toContain('harness-kit user shim');
  expect(main(['--shim', '--dir'], io, { shim })).toBe(2);
  expect(main(['--force'], io, { shim })).toBe(2);
});
