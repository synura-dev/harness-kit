import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkManifest, checkRegistry } from './manifest-check.mjs';
import { REPO_DIR } from '../../harness/core/io/paths.mjs';

function mkHook(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'man-'));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, 'harness/hooks/h', f)), { recursive: true });
    fs.writeFileSync(path.join(root, 'harness/hooks/h', f), c);
  }
  return checkManifest(root).filter((m) => m.startsWith('hook h'));
}

function mkReg(manifests, files = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
  for (const [dir, m] of Object.entries(manifests)) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'manifest.json'), JSON.stringify({ layer: 'ext', kind: 'cli', ...m }));
  }
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), '');
  }
  return root;
}

describe('manifest-check', () => {
  test('checkManifest/checkRegistry on current repo produce zero warnings', () => {
    expect(checkManifest(REPO_DIR)).toEqual([]);
    expect(checkRegistry(REPO_DIR)).toEqual([]);
  });

  test('hook with only valid adapter needs no defaults.mjs', () => {
    expect(mkHook({ 'README.md': 'x', 'adapters/a.mjs': 'export default 1;' })).toEqual([]);
  });

  test('hook with empty defaults.mjs and no json/adapter is warned', () => {
    expect(mkHook({ 'README.md': 'x', 'defaults.mjs': '' }).length).toBe(1);
    expect(mkHook({ 'README.md': 'x', 'hook.config.json': 'not json' }).length).toBe(1);
    expect(mkHook({ 'README.md': 'x', 'hook.config.json': '{}' }).length).toBe(1);
  });

  test('hook with non-empty config json passes; missing README warned', () => {
    expect(mkHook({ 'README.md': 'x', 'hook.config.json': '{"a":1}' })).toEqual([]);
    expect(mkHook({ 'hook.config.json': '{"a":1}' })).toEqual(['hook h: thieu README.md']);
  });

  test('file .mjs chua khai bao trong manifest cua cli/plugin bi canh bao; cung ten o thu muc khac khong tinh', () => {
    const root = mkReg(
      { 'harness/plugins/a': { id: 'a', entry: 'x.mjs', domain: 'a' }, 'harness/plugins/b': { id: 'b', entry: 'y.mjs', domain: 'b' } },
      ['harness/plugins/a/x.mjs', 'harness/plugins/b/y.mjs', 'harness/plugins/b/x.mjs']);
    const w = checkManifest(root);
    expect(w.some((m) => m.startsWith('chua co trong manifest: harness/plugins/b/x.mjs'))).toBe(true);
    expect(w.some((m) => m.includes('plugins/a/x.mjs'))).toBe(false);
  });

  test('helper khai bao khong bat buoc la domain; domain tro file thieu bi bao loi', () => {
    const ok = mkReg({ 'harness/plugins/a': { id: 'a', entry: 'a.mjs', domain: 'a', files: { helpers: ['util.mjs'] } } }, ['harness/plugins/a/a.mjs', 'harness/plugins/a/util.mjs']);
    expect(checkManifest(ok)).toEqual([]);
    const bad = mkReg({ 'harness/plugins/a': { id: 'a', entry: 'a.mjs', domain: 'a', domains: { a: 'a.mjs', z: { file: 'z.mjs' } } } }, ['harness/plugins/a/a.mjs']);
    expect(checkManifest(bad).join('|')).toContain('domain z tro file khong ton tai');
  });

  test('plugin thieu manifest.json bi canh bao; default=run co timeout trong shim', () => {
    const root = mkReg({}, ['harness/plugins/p/p.mjs']);
    expect(checkManifest(root)).toContain('chua co manifest.json: harness/plugins/p');
    const r2 = mkReg({ 'harness/cli': { id: 'cli', entry: 'harness.mjs', domain: 'harness', domains: { x: { file: 'x.mjs', default: 'run' } } } }, ['harness/cli/harness.mjs', 'harness/cli/x.mjs']);
    expect(checkRegistry(r2).join('|')).toContain('domain x: default=run thieu timeout');
  });
});
