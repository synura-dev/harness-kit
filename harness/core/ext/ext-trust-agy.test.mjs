// readAll: ENOENT khong duoc la "chua dang ky" khi thu muc thuc ra khong doc duoc (sandbox agy); agy chay ban cai cua Claude -> loi ro.
import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAll, unreadableAncestor } from './ext-trust.mjs';

const tmps = [];
afterAll(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const mk = () => { const t = fs.mkdtempSync(path.join(os.tmpdir(), 'extagy-')); tmps.push(t); return t; };

test('unreadableAncestor: stat tung cap, EPERM/EACCES -> tra {dir, code}; ENOENT bo qua; sach -> null', () => {
  const f = path.join(os.tmpdir(), 'a', 'b', 'c.json');
  const T = path.resolve(os.tmpdir());
  const mkfs = (bad) => ({ statSync: (p) => { const r = path.resolve(p); if (r === path.resolve(bad)) { const e = new Error('x'); e.code = 'EPERM'; throw e; } if (T.startsWith(r)) return {}; const e = new Error('n'); e.code = 'ENOENT'; throw e; } });
  expect(unreadableAncestor(f, mkfs(path.join(os.tmpdir(), 'a')))).toEqual({ dir: path.join(os.tmpdir(), 'a'), code: 'EPERM' });
  expect(unreadableAncestor(f, mkfs(path.join(os.tmpdir(), 'zzz')))).toBeNull();
});

test('unreadableAncestor: cap ton tai gan nhat readdir EPERM -> bao', () => {
  const f = path.join(os.tmpdir(), 'q', 'c.json'); const T = path.resolve(os.tmpdir());
  const fsx = { statSync: (p) => { if (T.startsWith(path.resolve(p))) return {}; const e = new Error('n'); e.code = 'ENOENT'; throw e; }, readdirSync: () => { const e = new Error('x'); e.code = 'EPERM'; throw e; } };
  expect(unreadableAncestor(f, fsx)).toEqual({ dir: T, code: 'EPERM' });
});

test('readAll: file that su vang trong thu muc doc duoc -> rong (khong dang ky)', () => {
  const t = mk();
  expect(readAll({ machineFile: path.join(t, 'config', 'ext', 'local.json') })).toEqual({ extensions: {} });
});

test('readAll: agy (ANTIGRAVITY_AGENT=1) chay ban cai Claude (cache layout) -> loi chi dung ban cai cua agy', () => {
  const t = mk();
  const repoDir = path.join(t, '.claude', 'plugins', 'cache', 'mkt', 'harness-kit', '0.4.3');
  fs.mkdirSync(path.join(repoDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, '.claude-plugin', 'plugin.json'), '{"name":"harness-kit"}');
  const env = { ANTIGRAVITY_AGENT: '1', CLAUDECODE: '1', CLAUDE_PROJECT_DIR: t };
  expect(() => readAll({ repoDir, env })).toThrow(/agy.*\.gemini.*plugins.*harness-kit/s);
  // doc duoc (vd Claude con sinh tu agy) -> dung registry, khong chan
  const d = path.join(t, 'd'); fs.mkdirSync(path.join(d, 'config', 'ext'), { recursive: true });
  fs.writeFileSync(path.join(d, 'config', 'ext', 'local.json'), JSON.stringify({ extensions: { w: [{ id: 'k' }] } }));
  expect(readAll({ repoDir, env: { ...env, CLAUDE_PLUGIN_DATA: d } }).extensions.w[0].id).toBe('k');
  // khong phai agy: hanh vi cu (ENOENT -> rong)
  expect(readAll({ repoDir, env: { CLAUDE_PLUGIN_DATA: path.join(t, 'none'), CLAUDE_PROJECT_DIR: t } })).toEqual({ extensions: {} });
});
