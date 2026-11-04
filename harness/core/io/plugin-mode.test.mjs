// Plugin mode: ma nam trong plugin (.claude-plugin/plugin.json) -> goc = du an, du lieu = <du an>/.harness/data, tao lazy .gitignore. Hub (khong co plugin.json) giu hanh vi cu.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveHub, dataDir, isPluginMode, ensureDataIgnore } from './paths.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plugmode-'));

test('hub (khong plugin.json): hanh vi cu', () => {
  const repo = tmp();
  expect(isPluginMode(repo)).toBe(false);
  expect(resolveHub({ env: {}, repoDir: repo })).toEqual({ hubDir: repo, source: 'default' });
  expect(dataDir('x', { env: {}, repoDir: repo })).toBe(path.join(repo, 'data', 'x'));
});

test('ensureDataIgnore: .gitignore co san nhung thieu data/ -> append, giu noi dung cu, idempotent', () => {
  const plug = tmp(); const proj = tmp();
  fs.mkdirSync(path.join(plug, '.claude-plugin'));
  fs.writeFileSync(path.join(plug, '.claude-plugin', 'plugin.json'), '{"name":"t"}');
  fs.mkdirSync(path.join(proj, '.harness'));
  fs.writeFileSync(path.join(proj, '.harness', '.gitignore'), 'config/local.json');
  const opts = { env: { CLAUDE_PROJECT_DIR: proj }, repoDir: plug };
  expect(ensureDataIgnore(opts)).toBe(true);
  expect(fs.readFileSync(path.join(proj, '.harness', '.gitignore'), 'utf8')).toBe('config/local.json\n*\n');
  expect(ensureDataIgnore(opts)).toBe(false);
});

test('plugin mode: goc = CLAUDE_PROJECT_DIR, data = .harness/data, PLUGIN_ROOT khong bi ghi', () => {
  const plug = tmp(); const proj = tmp();
  fs.mkdirSync(path.join(plug, '.claude-plugin'));
  fs.writeFileSync(path.join(plug, '.claude-plugin', 'plugin.json'), '{"name":"t"}');
  const opts = { env: { CLAUDE_PROJECT_DIR: proj }, repoDir: plug };
  expect(resolveHub(opts)).toEqual({ hubDir: proj, source: 'plugin' });
  expect(dataDir('audit', opts)).toBe(path.join(proj, '.harness', 'data', 'audit'));
  expect(resolveHub({ env: {}, repoDir: plug, cwd: proj }).hubDir).toBe(proj);
  expect(ensureDataIgnore(opts)).toBe(true);
  expect(fs.readFileSync(path.join(proj, '.harness', '.gitignore'), 'utf8')).toBe('*\n');
  expect(ensureDataIgnore(opts)).toBe(false);
  expect(fs.readdirSync(plug).sort()).toEqual(['.claude-plugin']);
});

test('git status sach sau khi ghi .harness (ignore ca .gitignore)', () => {
  const plug = tmp(); const proj = tmp();
  fs.mkdirSync(path.join(plug, '.claude-plugin'));
  fs.writeFileSync(path.join(plug, '.claude-plugin', 'plugin.json'), '{"name":"t"}');
  Bun.spawnSync(['git', 'init', '-q'], { cwd: proj });
  const opts = { env: { CLAUDE_PROJECT_DIR: proj }, repoDir: plug };
  ensureDataIgnore(opts);
  fs.mkdirSync(path.join(proj, '.harness', 'data'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.harness', 'data', 'x.json'), '{}');
  const out = Bun.spawnSync(['git', 'status', '--short'], { cwd: proj }).stdout.toString();
  expect(out.trim()).toBe('');
});

test('CLI ban sao (khong plugin.json) dung chung goc .harness khi hook plugin da tao; hub goc khong co .harness giu goc cu', () => {
  const repo = tmp();
  expect(dataDir('audit', { env: {}, repoDir: repo })).toBe(path.join(repo, 'data', 'audit'));
  fs.mkdirSync(path.join(repo, '.harness', 'data'), { recursive: true });
  expect(dataDir('audit', { env: {}, repoDir: repo })).toBe(path.join(repo, '.harness', 'data', 'audit'));
});
