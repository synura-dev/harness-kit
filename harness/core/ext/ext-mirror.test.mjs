// Sao chep dang ky ext sang thu muc du lieu cua CLI khac (agy khong doc duoc ~/.claude). Moi test dung thu muc tam + tiem home/env/shimDir.
import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pluginLayerDirs } from '../config/config.mjs';
import { writeAll, readAll, mirrorRegistry } from './ext-trust.mjs';
import { remove, register, approve } from '../../cli/commands/ext-registry.mjs';
import { syncUserShim, rootsFile } from '../runtime/user-shim.mjs';
import { handle } from '../../build/user-shim/hook.mjs';

const tmps = [];
afterAll(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const mk = () => { const t = fs.mkdtempSync(path.join(os.tmpdir(), 'extmir-')); tmps.push(t); return t; };
const reg = (d) => path.join(d, 'config', 'ext', 'local.json');
const J = { extensions: { 'E:/hub': [{ id: 'knowledge', root: 'ext/knowledge', hash: 'abc', approvedAt: 'x' }] } };
const put = (d, j) => { fs.mkdirSync(path.dirname(reg(d)), { recursive: true }); fs.writeFileSync(reg(d), JSON.stringify(j, null, 2) + '\n'); };
const roots = (t, o) => { const s = path.join(t, 'bin'); fs.mkdirSync(s, { recursive: true }); fs.writeFileSync(rootsFile(s), JSON.stringify(o)); return s; };

function agyPlugin(t) {
  const root = path.join(t, '.gemini', 'config', 'plugins', 'harness-kit');
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'harness-kit' }));
  fs.writeFileSync(path.join(root, 'bin', 'harness'), '');
  return root;
}

test('agy: pluginLayerDirs tro vao plugin_data cua agy (chi .gemini/config/plugins/<ten>), KHONG ~/.claude', () => {
  const t = mk(); const root = agyPlugin(t);
  const d = pluginLayerDirs({ env: { CLAUDE_PROJECT_DIR: t }, repoDir: root });
  expect(d.machineDir).toBe(path.join(t, '.gemini', 'antigravity-cli', 'plugin_data', 'harness-kit', 'config'));
});

test('agy: env PLUGIN_DATA thang suy tu duong cai; CLAUDE_PLUGIN_DATA bi bo qua', () => {
  const t = mk(); const root = agyPlugin(t); const pd = path.join(t, 'given');
  expect(pluginLayerDirs({ env: { PLUGIN_DATA: pd, CLAUDE_PLUGIN_DATA: path.join(t, 'claude') }, repoDir: root }).primaryDir).toBe(pd);
  expect(pluginLayerDirs({ env: { CLAUDE_PLUGIN_DATA: path.join(t, 'claude') }, repoDir: root }).primaryDir).toBe(path.join(t, '.gemini', 'antigravity-cli', 'plugin_data', 'harness-kit'));
});

test('TB-5: --plugin-dir cua Claude (X/plugins/<ten>) giu hanh vi cu, khong sang X/plugin_data', () => {
  const t = mk(); const other = path.join(t, 'plugins', 'harness-kit');
  fs.mkdirSync(path.join(other, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(other, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'harness-kit' }));
  expect(pluginLayerDirs({ env: { CLAUDE_PROJECT_DIR: t }, repoDir: other }).machineDir).toBe(path.join(os.homedir(), '.claude', 'plugins', 'data', 'harness-kit', 'config'));
});

test('mirrorRegistry: nguon = ban chinh cua tool co data trung thu muc hien tai; sao nguyen van; data khong ton tai/loi -> failed', () => {
  const t = mk();
  const A = path.join(t, 'a'), B = path.join(t, 'b'), gone = path.join(t, 'gone'), bad = path.join(t, 'bad');
  fs.mkdirSync(B); fs.writeFileSync(bad, 'file'); put(A, J);
  const shimDir = roots(t, { claude: { scan: t, data: A }, agy: { root: t, data: B }, x: { data: gone }, y: { data: bad } });
  const m = mirrorRegistry({ machineFile: reg(A), shimDir });
  expect(fs.readFileSync(reg(B), 'utf8')).toBe(fs.readFileSync(reg(A), 'utf8'));
  expect(m.mirrored).toEqual(['agy']);
  expect(m.failed.length).toBe(2);
  expect(fs.existsSync(gone)).toBe(false);
  expect(m.failed.join(' ')).toContain(gone);
});

test('mirrorRegistry: thu muc du lieu hien tai KHONG khop data nao trong roots.json -> khong chep gi', () => {
  const t = mk(); const A = path.join(t, 'a'), B = path.join(t, 'b'), F = path.join(t, 'fake');
  fs.mkdirSync(B); put(A, J); put(F, { extensions: { fake: [] } });
  const shimDir = roots(t, { claude: { data: A }, agy: { data: B } });
  const m = mirrorRegistry({ machineFile: reg(F), shimDir });
  expect(m.mirrored).toEqual([]); expect(m.failed.length).toBe(1); expect(m.unmatched).toBe(true); expect(fs.existsSync(reg(B))).toBe(false); // Thap-3: canh bao + failed
});

const ents = (w, ids) => ({ extensions: { [w]: ids.map((id) => ({ id, root: 'x', hash: 'h', approvedAt: 'x' })) } });
const count = (f) => Object.values(JSON.parse(fs.readFileSync(f, 'utf8')).extensions).flat().length;

test('TB-1: ban cua tien trinh (agy) chua co, Claude co 3 muc, register foo -> Claude co 4 muc (khong mat approve cu)', async () => {
  const t = mk(); const w = path.join(t, 'ws'); fs.mkdirSync(w); const A = path.join(t, 'claude'), B = path.join(t, 'agy');
  fs.mkdirSync(B); put(A, ents(w, ['a', 'b', 'c']));
  fs.mkdirSync(path.join(w, 'ext', 'foo'), { recursive: true });
  fs.writeFileSync(path.join(w, 'ext', 'foo', 'manifest.json'), JSON.stringify({ id: 'foo', entry: 'i.mjs', domain: 'foo' }));
  fs.writeFileSync(path.join(w, 'ext', 'foo', 'i.mjs'), '');
  const shimDir = roots(t, { claude: { data: A }, agy: { data: B } });
  const r = await register('ext/foo', { workspace: w, machineFile: reg(B), shimDir, confirm: () => true });
  expect(r.code).toBe(0);
  expect(count(reg(A))).toBe(4); expect(count(reg(B))).toBe(4);
});

test('TB-1: rao chan - nguon it hon dich > 1 muc thi KHONG chep de, code 1', () => {
  const t = mk(); const w = path.join(t, 'ws'); const A = path.join(t, 'a'), B = path.join(t, 'b');
  put(A, ents(w, ['a'])); put(B, ents(w, ['a', 'b', 'c', 'd']));
  const shimDir = roots(t, { claude: { data: A }, agy: { data: B } });
  const before = fs.readFileSync(reg(B), 'utf8');
  const m = mirrorRegistry({ machineFile: reg(A), shimDir });
  expect(m.failed.length).toBe(1); expect(m.mirrored).toEqual([]);
  expect(fs.readFileSync(reg(B), 'utf8')).toBe(before);
});

test('writeAll chi ghi ban chinh (khong chep)', () => {
  const t = mk(); const A = path.join(t, 'a'), B = path.join(t, 'b'); fs.mkdirSync(B);
  roots(t, { claude: { data: A }, agy: { data: B } });
  writeAll({ machineFile: reg(A), shimDir: path.join(t, 'bin') }, J);
  expect(readAll({ machineFile: reg(A) })).toEqual(J); expect(fs.existsSync(reg(B))).toBe(false);
});

test('readAll: loi doc (khong phai ENOENT) nem kem huong dan chay ext approve o terminal de dong bo', () => {
  const t = mk(); const f = reg(t); fs.mkdirSync(f, { recursive: true });
  expect(() => readAll({ machineFile: f })).toThrow(/ext approve/);
});

// --- CAO-1: gia mach approve qua buoc chep ---
const ws0 = (t) => { const w = path.join(t, 'ws'); fs.mkdirSync(w, { recursive: true }); return w; };
const withGuard = (w) => ({ extensions: { [w]: [{ id: 'dummy', root: 'x', hash: 'h', approvedAt: 'x', guard: { event: 'PreToolUse', matcher: 'Bash', args: [], domain: 'd' } }] } });
const plainExt = (w) => ({ extensions: { [w]: [{ id: 'dummy', root: 'x', hash: 'h', approvedAt: 'x' }] } });

test('CAO-1a: remove --yes (khong guard, khong qua TTY) KHONG chep sang CLI khac', async () => {
  const t = mk(); const w = ws0(t); const A = path.join(t, 'a'), B = path.join(t, 'b');
  put(A, plainExt(w)); put(B, J);
  const shimDir = roots(t, { claude: { data: A }, agy: { data: B } });
  const r = await remove('dummy', { workspace: w, machineFile: reg(A), shimDir, yes: true });
  expect(r.code).toBe(0);
  expect(JSON.parse(fs.readFileSync(reg(B), 'utf8'))).toEqual(J);
});

test('CAO-1b: CLAUDE_PLUGIN_DATA tro vao thu muc gia (khong dang ky) + remove co guard qua confirm -> ban that khong doi', async () => {
  const t = mk(); const w = ws0(t); const real = path.join(t, 'real'), B = path.join(t, 'b'), fake = path.join(t, 'fake');
  put(real, J); put(B, J); put(fake, withGuard(w));
  const repoDir = path.join(t, 'repo'); fs.mkdirSync(path.join(repoDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, '.claude-plugin', 'plugin.json'), '{"name":"harness-kit"}');
  const shimDir = roots(t, { claude: { data: real }, agy: { data: B } });
  const before = fs.readFileSync(reg(real), 'utf8');
  const r = await remove('dummy', { workspace: w, repoDir, env: { CLAUDE_PLUGIN_DATA: fake, CLAUDE_PROJECT_DIR: w }, shimDir, yes: true, confirm: () => true });
  expect(r.code).toBe(0);
  expect(fs.readFileSync(reg(real), 'utf8')).toBe(before); expect(fs.readFileSync(reg(B), 'utf8')).toBe(before);
});

test('CAO-1c: plugin chep sang X/.gemini/config/plugins/harness-kit (data khong dang ky) -> khong chep vao ban that', async () => {
  const t = mk(); const w = ws0(t); const real = path.join(t, 'real'), B = path.join(t, 'b');
  put(real, J); put(B, J);
  const repoDir = agyPlugin(path.join(t, 'evil')); put(path.join(t, 'evil', '.gemini', 'antigravity-cli', 'plugin_data', 'harness-kit'), withGuard(w));
  const shimDir = roots(t, { claude: { data: real }, agy: { data: B } });
  const before = fs.readFileSync(reg(real), 'utf8');
  const r = await remove('dummy', { workspace: w, repoDir, env: { CLAUDE_PROJECT_DIR: w }, shimDir, yes: true, confirm: () => true });
  expect(r.code).toBe(0);
  expect(fs.readFileSync(reg(real), 'utf8')).toBe(before); expect(fs.readFileSync(reg(B), 'utf8')).toBe(before);
});

test('remove co guard qua confirm tren data da dang ky -> chep sang CLI khac; chep loi -> code 1 kem thong bao', async () => {
  const t = mk(); const w = ws0(t); const A = path.join(t, 'a'), B = path.join(t, 'b'), gone = path.join(t, 'gone');
  put(A, withGuard(w)); put(B, J);
  let shimDir = roots(t, { claude: { data: A }, agy: { data: B } });
  const r = await remove('dummy', { workspace: w, machineFile: reg(A), shimDir, yes: true, confirm: () => true });
  expect(r.code).toBe(0); expect(fs.readFileSync(reg(B), 'utf8')).toBe(fs.readFileSync(reg(A), 'utf8'));
  put(A, withGuard(w)); shimDir = roots(t, { claude: { data: A }, agy: { data: B }, z: { data: gone } });
  const r2 = await remove('dummy', { workspace: w, machineFile: reg(A), shimDir, yes: true, confirm: () => true });
  expect(r2.code).toBe(1); expect(r2.text).toContain(gone);
});

test('syncUserShim ghi data vao khoa cua tool, giu khoa tool kia (va data cua no)', () => {
  const t = mk(); const dir = path.join(t, 'bin');
  const inj = { env: { LOCALAPPDATA: path.join(t, 'L'), PATH: '' }, home: path.join(t, 'h'), regPath: 'C:\\x', setUserPath: () => null };
  const c = path.join(t, 'c'), a = path.join(t, 'a'); fs.mkdirSync(c, { recursive: true }); fs.mkdirSync(a, { recursive: true });
  syncUserShim({ dir, tool: 'claude', pluginRoot: c, data: path.join(t, 'cd'), ...inj });
  syncUserShim({ dir, tool: 'agy', pluginRoot: a, data: path.join(t, 'ad'), ...inj });
  const r = JSON.parse(fs.readFileSync(rootsFile(dir), 'utf8'));
  expect(r.claude.data).toBe(path.join(t, 'cd')); expect(r.agy.data).toBe(path.join(t, 'ad'));
});

test('hook SessionStart agy dang ky data = plugin_data cua agy; chi khoa agy', async () => {
  const t = mk(); const root = agyPlugin(t);
  const inj = { env: { LOCALAPPDATA: path.join(t, 'L'), PATH: '' }, home: path.join(t, 'h'), regPath: 'C:\\x', setUserPath: () => null };
  fs.mkdirSync(inj.home);
  await handle('SessionStart', {}, { cfg: { enabled: true, events: ['SessionStart'] }, pluginRoot: root, tool: 'agy', inj });
  const dir = path.join(inj.home, process.platform === 'win32' ? '.harness-kit' : '.local', 'bin');
  const r = JSON.parse(fs.readFileSync(rootsFile(dir), 'utf8'));
  expect(Object.keys(r)).toEqual(['agy']);
  expect(r.agy.data).toBe(path.join(t, '.gemini', 'antigravity-cli', 'plugin_data', 'harness-kit'));
  expect(fs.existsSync(r.agy.data)).toBe(true);
});
