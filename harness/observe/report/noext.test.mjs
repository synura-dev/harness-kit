// Tich hop: core khong co extension nao van chay tron vong (job ledger -> hook canh bao -> bao cao ghi file -> autopilot dry-run).
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runJob } from '../ledger/job.mjs';
import { handle } from '../ledger/hook.mjs';
import { ledgerFile, pendingFile } from '../ledger/ledger.mjs';
import { buildReport, writeReportFile, putObsidian, reportsDir, NO_SOURCE } from './run.mjs';
import { runAutopilot } from '../../evolve/loop/autopilot.mjs';

const NOW = Date.now();
const fail = (i) => ({ v: 2, ts: new Date(NOW - 3600e3 + i * 60e3).toISOString(), type: 'tool', event: 'PostToolUse', sid: 's' + (i % 2), actor: 'main', tool: 'Bash', ok: false, status: 'error', target: 'bun test', data: { error: 'cannot find module foo', error_fp: 'aaaaaaaaaa' } });

test('hub tam khong ext: ledger -> hook warn -> report file -> autopilot dry-run', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noext-'));
  try {
    const hub = path.join(tmp, 'hub'); fs.mkdirSync(hub, { recursive: true });
    const env = { ...process.env, HUB_DIR: hub, HUB_DATA_DIR: path.join(tmp, 'data') };
    const dataOpts = { env };
    const events = [1, 2, 3, 4].map(fail);

    // 1) job ledger
    const job = await runJob({ nowMs: NOW, hubDir: hub, events, dataOpts, projectDir: null });
    expect(job.errors).toEqual([]);
    expect(job.entries).toBeGreaterThan(0);
    expect(fs.existsSync(ledgerFile(dataOpts))).toBe(true);
    expect(fs.existsSync(pendingFile(dataOpts))).toBe(true);

    // 2) hook doc warn-pending, canh bao ra additionalContext
    const h = await handle('UserPromptSubmit', { session_id: 'sx' }, { env, nowMs: NOW, write: false });
    expect(String(h.additionalContext || '')).toMatch(/ledger\[/);

    // 3) report: ghi file .md trong thu muc du lieu, KPI task done = khong co nguon, day Obsidian that bai khong hong
    const r = await buildReport({ nowMs: NOW, events, hubDir: hub, dataOpts, baseline: null, projectDir: null });
    expect(r.errors).toEqual([]);
    expect(r.markdown).toContain(NO_SOURCE);
    const f = writeReportFile(r.markdown, { dataOpts, nowMs: NOW });
    expect(f && f.startsWith(reportsDir(dataOpts))).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toContain('# Bao cao harness tuan');
    const put = putObsidian(r.markdown, { run: () => ({ status: 1, stderr: 'no ext' }) });
    expect(put.ok).toBe(false);
    expect(fs.existsSync(f)).toBe(true);

    // 4) autopilot dry-run
    const ap = await runAutopilot({ dryRun: true, force: true, nowMs: NOW, hubRoot: hub, dataBase: path.join(tmp, 'data'), dataRoot: path.join(tmp, 'data', 'evolve'), auditDir: path.join(tmp, 'audit'), ledgerFile: ledgerFile(dataOpts) });
    expect(ap.dryRun).toBe(true);
    expect(ap.errors).toEqual([]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('writeReportFile: retention giu toi da keep file moi nhat', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noext-ret-'));
  try {
    const dataOpts = { env: { ...process.env, HUB_DIR: tmp, HUB_DATA_DIR: tmp } };
    for (let w = 0; w < 6; w++) writeReportFile('x', { dataOpts, nowMs: NOW + w * 7 * 86400e3, keep: 3 });
    expect(fs.readdirSync(reportsDir(dataOpts)).length).toBe(3);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
