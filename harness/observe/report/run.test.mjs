import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReport, saveBaseline, putObsidian, kickReport, markRun, baselineFile } from './run.mjs';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rrun-'));
const NOW = Date.parse('2026-11-05T12:00:00Z');
const ev = { ts: new Date(NOW - 86400000).toISOString(), sid: 's1', event: 'PostToolUse', tool: 'Bash', target: 'harness tasks' };

test('buildReport tren du lieu tiem vao: du muc, khong loi, baseline null', async () => {
  const r = await buildReport({ nowMs: NOW, events: [ev], ledger: [], baseline: null, projectDir: null });
  assert.equal(r.results.length, 10); assert.deepEqual(r.errors, []);
  assert.match(r.markdown, /# Bao cao harness tuan 2026-11-05/);
  assert.match(r.markdown, /chua chot/);
});

test('saveBaseline: dry-run khong ghi; that thi ghi va doc lai', async () => {
  const d = mk(); const o = { dataOpts: { env: { HUB_DATA_DIR: d } } };
  const r = await buildReport({ nowMs: NOW, events: [ev], ledger: [], baseline: null });
  assert.equal(saveBaseline(r, { ...o, dryRun: true }).ok, false);
  assert.equal(fs.existsSync(baselineFile(o.dataOpts)), false);
  const b = saveBaseline(r, o);
  if (b.ok) assert.equal(JSON.parse(fs.readFileSync(baselineFile(o.dataOpts), 'utf8')).date, '2026-11-05');
  assert.ok(b.baseline.kpis['kpi-info-fetch']);
  fs.rmSync(d, { recursive: true, force: true });
});

test('putObsidian: goi cong CLI voi --section; loi/qua dai -> ok:false', () => {
  let args;
  assert.equal(putObsidian('# md', { run: (_n, a) => { args = a; return { status: 0 }; } }).ok, true);
  assert.ok(args.includes('obsidian') && args.includes('put') && args.includes('--section') && args.includes('Noi dung=# md'));
  assert.equal(putObsidian('x', { run: () => ({ status: 1, stderr: 'no' }) }).ok, false);
  assert.equal(putObsidian('x'.repeat(30000), { run: () => ({ status: 0 }) }).ok, false);
});

test('kickReport: toi da 1 lan/7 ngay + khoa', () => {
  const d = mk(); const o = { env: { HUB_DATA_DIR: d } }; let n = 0;
  const ctx = { spawnReport: () => { n++; } };
  assert.equal(kickReport(o, ctx, NOW), true); assert.equal(n, 1);
  assert.equal(kickReport(o, ctx, NOW + 60000), false); // khoa
  markRun(o, NOW);
  assert.equal(kickReport(o, ctx, NOW + 3 * 86400000), false); // < 7 ngay
  assert.equal(kickReport(o, ctx, NOW + 8 * 86400000), true); assert.equal(n, 2);
  fs.rmSync(d, { recursive: true, force: true });
});
