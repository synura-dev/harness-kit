// Sao chep dang ky ext sang thu muc du lieu cua CLI khac (agy khong doc duoc ~/.claude). Moi test dung thu muc tam + tiem home/env.
import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pluginLayerDirs } from '../config/config.mjs';
import { writeAll, readAll } from './ext-trust.mjs';
import { syncUserShim, rootsFile } from '../runtime/user-shim.mjs';
import { handle } from '../../build/user-shim/hook.mjs';

const tmps = [];
afterAll(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const mk = () => { const t = fs.mkdtempSync(path.join(os.tmpdir(), 'extmir-')); tmps.push(t); return t; };
const reg = (d) => path.join(d, 'config', 'ext', 'local.json');
const J = { extensions: { 'E:/hub': [{ id: 'knowledge', root: 'ext/knowledge', hash: 'abc', approvedAt: 'x' }] } };

function agyPlugin(t) {
  const root = path.join(t, '.gemini', 'config', 'plugins', 'harness-kit');
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'harness-kit' }));
  fs.writeFileSync(path.join(root, 'bin', 'harness'), '');
  return root;
}

test('agy: pluginLayerDirs tro vao plugin_data cua agy, KHONG ~/.claude (ke ca khi co CLAUDE_PLUGIN_DATA vang)', () => {
  const t = mk(); const root = agyPlugin(t);
  const want = path.join(t, '.gemini', 'config', 'plugin_data', 'harness-kit', 'config');
  const d = pluginLayerDirs({ env: { CLAUDE_PROJECT_DIR: t }, repoDir: root });
  expect(d.machineDir).toBe(want);
  expect(d.machineDir.includes(`${path.sep}.claude${path.sep}`)).toBe(false);
});

test('writeAll: ghi ban chinh roi sao nguyen van sang moi data da dang ky va con ton tai; loi mot ban chi canh bao', () => {
  const t = mk();
  const A = path.join(t, 'a'), B = path.join(t, 'b'), gone = path.join(t, 'gone'), bad = path.join(t, 'bad');
  fs.mkdirSync(A); fs.mkdirSync(B); fs.writeFileSync(bad, 'file, khong phai thu muc');
  const shimDir = path.join(t, 'bin'); fs.mkdirSync(shimDir);
  fs.writeFileSync(rootsFile(shimDir), JSON.stringify({ claude: { scan: t, data: A }, agy: { root: t, data: B }, x: { data: gone }, y: { data: bad } }));
  const warns = []; const ow = console.error; console.error = (m) => warns.push(String(m));
  try { writeAll({ machineFile: reg(A), shimDir }, J); } finally { console.error = ow; }
  const main = fs.readFileSync(reg(A), 'utf8');
  expect(JSON.parse(main)).toEqual(J);
  expect(fs.readFileSync(reg(B), 'utf8')).toBe(main);
  expect(fs.existsSync(gone)).toBe(false);
  expect(warns.some((w) => w.includes(bad))).toBe(true);
});

test('writeAll khong co shimDir/roots.json -> chi ban chinh, khong nem', () => {
  const t = mk(); const A = path.join(t, 'a');
  writeAll({ machineFile: reg(A), shimDir: path.join(t, 'khong-co') }, J);
  expect(readAll({ machineFile: reg(A) })).toEqual(J);
});

test('readAll: loi doc (khong phai ENOENT) nem kem huong dan chay ext approve o terminal de dong bo', () => {
  const t = mk(); const f = reg(t); fs.mkdirSync(f, { recursive: true }); // doc 1 thu muc -> EISDIR
  expect(() => readAll({ machineFile: f })).toThrow(/ext approve/);
});

test('syncUserShim ghi data vao khoa cua tool, giu khoa tool kia (va data cua no)', () => {
  const t = mk(); const dir = path.join(t, 'bin');
  const inj = { env: { LOCALAPPDATA: path.join(t, 'L'), PATH: '' }, home: path.join(t, 'h'), regPath: 'C:\\x', setUserPath: () => null };
  const c = path.join(t, 'c'), a = path.join(t, 'a'); fs.mkdirSync(c, { recursive: true }); fs.mkdirSync(a, { recursive: true });
  syncUserShim({ dir, tool: 'claude', pluginRoot: c, data: path.join(t, 'cd'), ...inj });
  syncUserShim({ dir, tool: 'agy', pluginRoot: a, data: path.join(t, 'ad'), ...inj });
  const r = JSON.parse(fs.readFileSync(rootsFile(dir), 'utf8'));
  expect(r.claude.data).toBe(path.join(t, 'cd'));
  expect(r.agy.data).toBe(path.join(t, 'ad'));
});

test('hook SessionStart agy dang ky data = plugin_data cua agy; chi khoa agy', async () => {
  const t = mk(); const root = agyPlugin(t);
  const inj = { env: { LOCALAPPDATA: path.join(t, 'L'), PATH: '' }, home: path.join(t, 'h'), regPath: 'C:\\x', setUserPath: () => null };
  fs.mkdirSync(inj.home);
  await handle('SessionStart', {}, { cfg: { enabled: true, events: ['SessionStart'] }, pluginRoot: root, tool: 'agy', inj });
  const dir = path.join(inj.home, process.platform === 'win32' ? '.harness-kit' : '.local', 'bin');
  const r = JSON.parse(fs.readFileSync(rootsFile(dir), 'utf8'));
  expect(Object.keys(r)).toEqual(['agy']);
  expect(r.agy.data).toBe(path.join(t, '.gemini', 'config', 'plugin_data', 'harness-kit'));
  expect(fs.existsSync(r.agy.data)).toBe(true);
});
