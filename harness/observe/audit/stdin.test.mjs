// node --test harness/observe/audit/stdin.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'audit-stdin-'));

function hang(script, root) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [path.join(HERE, script)], { env: { ...process.env, CLAUDE_AUDIT_DIR: root }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    const kill = setTimeout(() => p.kill(), 8000);
    p.on('close', (code) => { clearTimeout(kill); resolve({ code, out, ms: Date.now() - t0 }); }); // stdin khong bao gio dong
  });
}

test('audit.mjs: stdin khong dong -> thoat <5s, exit 0', async () => {
  const r = await hang('audit.mjs', tmp());
  assert.equal(r.code, 0);
  assert.ok(r.ms < 5000, `mat ${r.ms}ms`);
});

test('adapters/agy.mjs: stdin khong dong -> thoat <5s, in {}, exit 0', async () => {
  const r = await hang('adapters/agy.mjs', tmp());
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), '{}');
  assert.ok(r.ms < 5000, `mat ${r.ms}ms`);
});

test('adapters/agy.mjs: payload hong -> in {}, exit 0', () => {
  const r = spawnSync(process.execPath, [path.join(HERE, 'adapters', 'agy.mjs')], { input: '{not json', encoding: 'utf8', timeout: 10000, env: { ...process.env, CLAUDE_AUDIT_DIR: tmp() } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '{}');
});

test('writeEnvelope: khong vuot max_file_bytes', async () => {
  const { writeEnvelope } = await import('./audit.mjs');
  const root = tmp();
  const env = { ts: '2026-10-27T00:00:00Z', type: 't', sid: 's', summary: 'x'.repeat(200) };
  for (let i = 0; i < 20; i++) writeEnvelope(env, { max_file_bytes: 500 }, root);
  const dir = path.join(root, 'date=2026-10-27', 'type=t');
  for (const f of fs.readdirSync(dir)) {
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    // moi file: <=500 byte, hoac dung 1 dong (dong don le lon hon tran)
    assert.ok(Buffer.byteLength(txt) <= 500 || txt.trim().split('\n').length === 1);
  }
});
