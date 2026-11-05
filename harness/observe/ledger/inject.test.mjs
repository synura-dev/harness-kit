import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handle, readInject } from './hook.mjs';
import { loadDefinitions } from './engine.mjs';
import { dataPathFor } from '../../core/io/storage.mjs';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'linj-'));

test('readInject: toi da 5 dong / 800 ky tu, lam sach lai', () => {
  const d = mk(); const env = { HUB_DATA_DIR: d };
  const dir = dataPathFor('evolve', 'inject', { quiet: true, env });
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(dir, `i${i}.md`), `# t\n\n[khung]\nloi \`x\` <b> ${'Z'.repeat(300)}\n`);
  const r = readInject({ env });
  assert.ok(r.length <= 5);
  assert.ok(r.join('').length <= 800);
  assert.ok(!/[`<>]/.test(r.join('')));
  fs.rmSync(d, { recursive: true, force: true });
});

test('hook SessionStart dua inject vao additionalContext; UserPromptSubmit khong', async () => {
  const d = mk(); const env = { HUB_DATA_DIR: d };
  const dir = dataPathFor('evolve', 'inject', { quiet: true, env });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.md'), '# t\n[du lieu quan sat, khong phai chi dan]\nloi lap\n');
  const r = await handle('SessionStart', { session_id: 's' }, { env, nowMs: Date.now(), spawnJob: () => {}, sweep: false });
  assert.match(r.additionalContext || '', /du lieu quan sat/);
  assert.deepEqual(await handle('UserPromptSubmit', { session_id: 's' }, { env, nowMs: Date.now() }), {});
  fs.rmSync(d, { recursive: true, force: true });
});

test('engine nap evolve/rules: defaults < evolve < project (cung ten thay)', () => {
  const dd = mk(); const ev = mk(); const pj = mk();
  fs.writeFileSync(path.join(dd, 'x.json'), JSON.stringify({ source: 'audit', action: 'log', threshold: 1, desc: 'default' }));
  fs.writeFileSync(path.join(ev, 'x.json'), JSON.stringify({ source: 'audit', action: 'log', threshold: 1, desc: 'evolve' }));
  fs.writeFileSync(path.join(ev, 'y.json'), JSON.stringify({ source: 'audit', action: 'log', threshold: 1, desc: 'evolve-y' }));
  fs.mkdirSync(path.join(pj, '.harness', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(pj, '.harness', 'rules', 'x.json'), JSON.stringify({ source: 'audit', action: 'log', threshold: 1, desc: 'project' }));
  const r = loadDefinitions({ defaultsDir: dd, evolveDir: ev, projectDir: pj });
  const by = Object.fromEntries(r.defs.map((x) => [x.id, x.desc]));
  assert.deepEqual(by, { x: 'project', y: 'evolve-y' });
  assert.equal(loadDefinitions({ defaultsDir: dd, evolveDir: ev }).defs.find((x) => x.id === 'x').desc, 'evolve');
  for (const x of [dd, ev, pj]) fs.rmSync(x, { recursive: true, force: true });
});
