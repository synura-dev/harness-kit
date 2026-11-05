// append (ledgerDone/spawnBackground) cung khoa voi compact: khong mat dong; so cu proc-ledger.json duoc doc gop mot lan.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { compactLedger, readLedger, ledgerPath } from './proc.mjs';
import { withLock } from './lockfile.mjs';

test('append dong thoi voi compact khong mat muc', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-cc-'));
  const f = ledgerPath(dir);
  const base = Array.from({ length: 50 }, (_, i) => JSON.stringify({ op: 'add', pid: 1000 + i, key: 'b' + i, deadline: 1, startedAt: 1 }) + '\n').join('');
  fs.writeFileSync(f, base);
  const child = path.join(dir, 'child.mjs');
  const url = pathToFileURL(path.resolve(import.meta.dir, 'proc.mjs')).href;
  fs.writeFileSync(child, `import { ledgerDone } from ${JSON.stringify(url)};\nfor (let i = 0; i < 40; i++) ledgerDone({ key: 'b' + i }, { dir: ${JSON.stringify(dir)} });\n`);
  const p = cp.spawn(process.execPath, [child], { stdio: 'ignore' });
  const exited = new Promise((r) => p.on('exit', r));
  let done = false; exited.then(() => { done = true; });
  while (!done) { withLock(f, () => compactLedger(f, { minBytes: 10 }), { retries: 40, waitMs: 5 }); await new Promise((r) => setTimeout(r, 2)); }
  const left = readLedger(f).map((e) => e.key).sort();
  expect(left).toEqual(Array.from({ length: 10 }, (_, i) => 'b' + (i + 40)).sort());
}, 30000);

test('so cu proc-ledger.json doc gop mot lan roi bo qua', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-lg-'));
  fs.writeFileSync(path.join(dir, 'proc-ledger.json'), JSON.stringify([{ pid: 7, key: 'old', deadline: 1, startedAt: 1 }]));
  expect(readLedger(ledgerPath(dir)).map((e) => e.key)).toEqual(['old']);
  expect(fs.existsSync(path.join(dir, 'proc-ledger.json'))).toBe(false);
});
