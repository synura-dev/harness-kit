// Plugin mode: lop plugin < may < du an. Lop du an chi siet them, khong ha/tat luat loi (Deny).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, evaluate } from './hook.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = [path.join(HERE, 'hook.config.json')];
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const wj = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };

function setup({ project, machine }) {
  const plugin = tmp('plug-'), prj = tmp('prj-'), pdata = tmp('pdata-');
  wj(path.join(plugin, '.claude-plugin', 'plugin.json'), { name: 'x-kit' });
  if (project) wj(path.join(prj, '.harness', 'config', 'guard', 'project.json'), project);
  if (machine) wj(path.join(pdata, 'config', 'guard', 'local.json'), machine);
  const env = { CLAUDE_PROJECT_DIR: prj, CLAUDE_PLUGIN_DATA: pdata };
  const r = load(CORE, { env, hubRoot: plugin, repoDir: plugin });
  return { r, id: (c) => evaluate(c, r.config)?.id ?? null };
}

test('lop du an them luat moi (siet them)', () => {
  const { id } = setup({ project: { denyPatterns: [{ id: 'proj-rule', pattern: 'forbiddenword', reason: 'x' }] } });
  assert.equal(id('echo forbiddenword'), 'proj-rule');
  assert.equal(id('git push --force origin main'), 'git-force-push');
});

test('lop du an KHONG tat/ghi de luat loi, khong ha mode', () => {
  const { r, id } = setup({ project: { mode: 'off', denyPatterns: [{ id: 'git-force-push', disable: true }, { id: 'mongo-cli', pattern: 'zzz', reason: 'x' }] } });
  assert.equal(id('git push --force origin main'), 'git-force-push');
  assert.equal(id('mongosh x'), 'mongo-cli');
  assert.equal(r.config.mode, 'enforce');
});

test('allowlist du an tro toi luat loi bi bo', () => {
  const { id } = setup({ project: { allowlist: [{ id: 'a', pattern: 'git push', for: ['git-force-push'] }] } });
  assert.equal(id('git push --force origin main'), 'git-force-push');
});

test('lop may tat duoc luat loi (do nguoi dung chu may quyet)', () => {
  const { id } = setup({ machine: { denyPatterns: [{ id: 'git-force-push', disable: true }] } });
  assert.equal(id('git push --force origin main'), null);
});

test('khong co lop nao: luat loi van chan, .harness khong tao', () => {
  const { id } = setup({});
  assert.equal(id('git push --force origin main'), 'git-force-push');
});
