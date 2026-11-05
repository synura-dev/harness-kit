// bun test harness/tools/sync.test.mjs
import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncAll } from './sync.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-'));
  const sk = path.join(root, '.agents', 'skills', 'demo');
  fs.mkdirSync(sk, { recursive: true });
  fs.writeFileSync(path.join(sk, 'SKILL.md'), '---\nname: demo\n---\nbody\n');
  fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
  fs.cpSync(path.join(import.meta.dir, '..', 'harness', 'tools', 'adapters'), path.join(root, 'tools', 'adapters'), { recursive: true });
  fs.cpSync(path.join(import.meta.dir, '..', 'harness', 'tools', 'adapters'), path.join(root, 'harness', 'tools', 'adapters'), { recursive: true });
  fs.mkdirSync(path.join(root, 'harness', 'core', 'io'), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dir, '..', 'harness', 'core', 'io', 'paths.mjs'), path.join(root, 'harness', 'core', 'io', 'paths.mjs'));
  fs.mkdirSync(path.join(root, 'harness', 'core', 'agy'), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dir, '..', 'harness', 'core', 'io', 'agy-payload.mjs'), path.join(root, 'harness', 'core', 'io', 'agy-payload.mjs'));
  fs.copyFileSync(path.join(import.meta.dir, '..', 'harness', 'core', 'agy', 'agents.mjs'), path.join(root, 'harness', 'core', 'agy', 'agents.mjs'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'tools.json'), JSON.stringify({ tools: { claude: { enabled: true } } }));
  // Tuong minh: doc config tu fixture (plugin mode mac dinh doc lop plugin/may/du an).
  process.env.HARNESS_CONFIG_DIR = path.join(root, 'config');
  return { root, sk };
}
afterAll(() => { delete process.env.HARNESS_CONFIG_DIR; });
const snap = (dir) => fs.readdirSync(dir, { recursive: true }).sort().map((f) => {
  const p = path.join(dir, f); return f + ':' + (fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : '');
}).join('\n');

test('symlink dich: khong ghi de nguon, check khop', async () => {
  const { root, sk } = fixture();
  fs.symlinkSync(sk, path.join(root, '.claude', 'skills', 'demo'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = snap(path.join(root, '.agents'));
  const r = await syncAll({ root });
  expect(r[0].problems).toEqual([]);
  expect(snap(path.join(root, '.agents'))).toBe(before);
  expect(fs.existsSync(path.join(sk, '.generated'))).toBe(false);
  const c = await syncAll({ root, check: true });
  expect(c[0].changes).toEqual([]);
});

test('link hong (dom may) duoc go va tao lai: copy mode', async () => {
  const { root, sk } = fixture();
  const dst = path.join(root, '.claude', 'skills', 'demo');
  fs.symlinkSync(path.join(root, 'gone'), dst, process.platform === 'win32' ? 'junction' : 'dir');
  expect((await syncAll({ root, check: true }))[0].changes.length).toBe(1);
  const r = await syncAll({ root });
  expect(r[0].problems).toEqual([]);
  expect(fs.lstatSync(dst).isSymbolicLink()).toBe(false);
  expect(fs.readFileSync(path.join(dst, 'SKILL.md'), 'utf8')).toContain('GENERATED');
  expect(fs.existsSync(path.join(sk, '.generated'))).toBe(false);
  expect((await syncAll({ root, check: true }))[0].changes).toEqual([]);
});

test('link mode: tao link dung, sua link tro sai, idempotent', async () => {
  const { root, sk } = fixture();
  fs.writeFileSync(path.join(root, 'config', 'tools.json'), JSON.stringify({ tools: { claude: { enabled: true, skillsMode: 'link' } } }));
  const dst = path.join(root, '.claude', 'skills', 'demo');
  const wrong = path.join(root, 'wrong'); fs.mkdirSync(wrong);
  fs.symlinkSync(wrong, dst, process.platform === 'win32' ? 'junction' : 'dir');
  const r = await syncAll({ root });
  expect(r[0].problems).toEqual([]);
  expect(fs.realpathSync(dst)).toBe(fs.realpathSync(sk));
  if (process.platform !== 'win32') expect(path.isAbsolute(fs.readlinkSync(dst))).toBe(false);
  expect((await syncAll({ root, check: true }))[0].changes).toEqual([]);
  expect(fs.existsSync(path.join(wrong, 'SKILL.md'))).toBe(false);
});

test('copy mode idempotent: chay 2 lan khong doi', async () => {
  const { root } = fixture();
  await syncAll({ root });
  const a = snap(path.join(root, '.claude'));
  const r2 = await syncAll({ root });
  expect(r2[0].changes).toEqual([]);
  expect(snap(path.join(root, '.claude'))).toBe(a);
  expect((await syncAll({ root, check: true }))[0].changes).toEqual([]);
});

test('syncRules: paths duoc sinh, khong paths bi bo, nguon MARK bi bo', async () => {
  const { root } = fixture();
  const rd = path.join(root, '.agents', 'rules');
  fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(path.join(rd, 'scoped.md'), '---\ntrigger: model_decision\npaths:\n  - "x/**"\n---\nbody\n');
  fs.writeFileSync(path.join(rd, 'plain.md'), '---\ntrigger: model_decision\n---\nbody\n');
  fs.writeFileSync(path.join(rd, 'gen.md'), '---\npaths:\n  - "y/**"\n---\n<!-- GENERATED - do not edit: sinh tu x -->\n');
  await syncAll({ root });
  const out = path.join(root, '.claude', 'rules');
  expect(fs.existsSync(path.join(out, 'scoped.md'))).toBe(true);
  expect(fs.existsSync(path.join(out, 'plain.md'))).toBe(false);
  expect(fs.existsSync(path.join(out, 'gen.md'))).toBe(false);
});

test('agent .claude/agents viet tay: sync khong sinh/xoa', async () => {
  const { root } = fixture();
  const dir = path.join(root, '.claude', 'agents'); fs.mkdirSync(dir, { recursive: true });
  const hand = path.join(dir, 'hand.md'); fs.writeFileSync(hand, 'tay\nnhac GENERATED - do not edit trong than\n');
  const gen = path.join(dir, 'old.md'); fs.writeFileSync(gen, '<!-- GENERATED - do not edit: sinh tu x boi tools/sync.mjs -->\nbody\n');
  await syncAll({ root });
  expect(fs.existsSync(hand)).toBe(true);
  expect(fs.existsSync(gen)).toBe(true);
});

import { spawnSync } from 'node:child_process';
const SYNC = path.join(import.meta.dir, 'sync.mjs');
const cli = (args, hub, file = SYNC) => spawnSync('node', [file, ...args], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...(hub ? { HUB_DIR: hub, HARNESS_CONFIG_DIR: path.join(hub, 'config') } : {}) } });
test('cli: --tool sai/thieu gia tri -> exit 2', () => {
  const { root } = fixture();
  expect(cli(['--check', '--tool', 'tenSai'], root).status).toBe(2);
  expect(cli(['--check', '--tool'], root).status).toBe(2);
});
test('cli: tools.json hong -> exit 2, khong bat lai tool bi tat', () => {
  const { root } = fixture();
  fs.writeFileSync(path.join(root, 'config', 'tools.json'), '{ hong');
  const p = cli(['--check'], root);
  expect(p.status).toBe(2);
  expect(p.stderr).toContain('JSON hong');
});
test('cli: --check voi duong dan chu thuong (win32) van chay dung', () => {
  if (process.platform !== 'win32') return;
  const p = cli(['--check'], null, SYNC.toLowerCase());
  // so sanh voi chay duong dan goc: ket qua phai y het (ban sao worktree/plugin co the lech README do settings khong hook, dung ca hai)
  const q = cli(['--check']);
  expect(p.stdout).toBe(q.stdout);
  expect(p.status).toBe(q.status);
});

test('co harness/skills: skill lane ngoai (chi o .agents/skills) van dong bo, skill harness khong bi syncSkills cu ghi', async () => {
  const { root } = fixture(); // demo = skill lane ngoai
  const hs = path.join(root, 'harness', 'skills', 'hsk'); fs.mkdirSync(hs, { recursive: true });
  fs.writeFileSync(path.join(hs, 'SKILL.md'), '---\nname: hsk\n---\nnguon that\n');
  const ag = path.join(root, '.agents', 'skills', 'hsk'); fs.mkdirSync(ag, { recursive: true });
  fs.writeFileSync(path.join(ag, 'SKILL.md'), '---\nname: hsk\n---\nbanbuild\n');
  const hdst = path.join(root, '.claude', 'skills', 'hsk'); fs.mkdirSync(hdst, { recursive: true });
  fs.writeFileSync(path.join(hdst, 'SKILL.md'), 'do build ghi\n');
  fs.writeFileSync(path.join(hdst, '.generated'), 'GENERATED boi skills build\n');
  const dst = path.join(root, '.claude', 'skills', 'demo');
  await syncAll({ root, only: 'claude' });
  expect(fs.readFileSync(path.join(dst, 'SKILL.md'), 'utf8')).toContain('body');
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\nnoi dung moi\n');
  expect((await syncAll({ root, only: 'claude', check: true }))[0].changes.length).toBe(1);
  await syncAll({ root, only: 'claude' });
  expect(fs.readFileSync(path.join(dst, 'SKILL.md'), 'utf8')).toContain('noi dung moi');
  expect(fs.readFileSync(path.join(hdst, 'SKILL.md'), 'utf8')).toBe('do build ghi\n');
  expect(fs.readFileSync(path.join(hdst, '.generated'), 'utf8')).toBe('GENERATED boi skills build\n');
  // skill harness bi go khoi .agents/skills: syncSkills cu khong xoa ban .claude (skills build lo)
  fs.rmSync(ag, { recursive: true });
  await syncAll({ root, only: 'claude' });
  expect(fs.existsSync(hdst)).toBe(true);
});
