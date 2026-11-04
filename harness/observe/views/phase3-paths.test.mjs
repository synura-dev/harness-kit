// GD3/I2: cac duong cung da chuyen qua dataPathFor/resolver; prune runs doc lap audit; verify-gate doc ca goc moi va legacy.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { dataPathFor } from '../../core/io/storage.mjs';
import { run as runsRun } from './runs.mjs';
import { prune } from './prune.mjs';
import { run as gate, auditReadRoots, DEFAULTS } from '../../constrain/verify-gate/hook.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gd3-i2-'));
const reg = { entries: { audit: { path: 'system/audit', legacy: 'audit' }, runs: { path: 'system/runs', legacy: 'runs' }, 'agy-home': { path: 'external/agy-home', legacy: 'agy-home' } } };
const env = (d) => ({ HUB_DATA_DIR: d });

test('dataPathFor ton trong HUB_DATA_DIR va path moi cua entry (gateway)', () => {
  const d = tmp();
  const p = dataPathFor('audit', 'gateway', 'date=2026-10-30', { env: env(d), registry: reg, quiet: true });
  expect(p).toBe(path.join(d, 'system', 'audit', 'gateway', 'date=2026-10-30'));
});

test('runs doc: mode read lui ve legacy khi path moi chua co', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'runs'));
  fs.writeFileSync(path.join(d, 'runs', 'a.md'), '# bao cao a\n');
  const dir = dataPathFor('runs', { env: env(d), registry: reg, mode: 'read', quiet: true });
  expect(dir).toBe(path.join(d, 'runs'));
  const out = [];
  runsRun(['list', '--json'], { dir, emitOpts: { write: (s) => out.push(s) } });
  fs.mkdirSync(path.join(d, 'system', 'runs'), { recursive: true });
  expect(dataPathFor('runs', { env: env(d), registry: reg, mode: 'read', quiet: true })).toBe(path.join(d, 'system', 'runs'));
});

test('prune runs chay doc lap khi audit va runs o cho khac nhau', () => {
  const d = tmp();
  const audit = path.join(d, 'system', 'audit'); const runs = path.join(d, 'elsewhere', 'runs');
  fs.mkdirSync(audit, { recursive: true }); fs.mkdirSync(runs, { recursive: true });
  const old = path.join(runs, 'old.log'); fs.writeFileSync(old, 'x');
  const past = new Date(Date.now() - 90 * 86400000); fs.utimesSync(old, past, past);
  const r = prune({ root: audit, runsRoot: runs, days: 30, yes: true });
  expect(r.removed.some((p) => p.endsWith('old.log'))).toBe(true);
  expect(fs.existsSync(old)).toBe(false);
});

test('auditReadRoots tra goc moi + legacy; CLAUDE_AUDIT_DIR thang the', () => {
  const d = tmp();
  expect(auditReadRoots({ env: env(d), registry: reg })).toEqual([path.join(d, 'system', 'audit'), path.join(d, 'audit')]);
  expect(auditReadRoots({ env: { CLAUDE_AUDIT_DIR: 'X:/a' } })).toEqual(['X:/a']);
});

test('verify-gate doc ca goc moi va legacy: edit o legacy, test pass o goc moi -> allow; thieu root moi van doc legacy', () => {
  const NOW = new Date('2026-10-29T10:00:00.000Z'); const SID = 'abc-9';
  const put = (root, type, e) => {
    const dir = path.join(root, 'date=2026-10-29', `type=${type}`); fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `claude-${SID}.jsonl`), JSON.stringify({ v: 2, sid: `claude-${SID}`, agent_id: null, ...e, type }) + '\n');
  };
  const at = (s) => new Date(NOW.getTime() - 600000 + s * 1000).toISOString();
  const legacy = tmp(); const fresh = tmp();
  put(legacy, 'prompt', { ts: at(0), event: 'UserPromptSubmit' });
  put(legacy, 'tool', { ts: at(1), event: 'PostToolUse', tool: 'Edit', target: 'src/a.ts', ok: true, data: { files_touched: ['src/a.ts'] } });
  const inp = { hook_event_name: 'Stop', session_id: SID, stop_hook_active: false };
  expect(gate(inp, { cfg: DEFAULTS, root: fresh, readRoots: [fresh, legacy], now: NOW, write: false }).decision).toBe('block');
  put(fresh, 'tool', { ts: at(2), event: 'PostToolUse', tool: 'Bash', target: 'bun test', ok: true, data: { bg: false, verifier_outcome: 'pass', verify_kind: 'test' } });
  expect(gate(inp, { cfg: DEFAULTS, root: fresh, readRoots: [fresh, legacy], now: NOW, write: false }).decision).toBe('allow');
  const missing = path.join(tmp(), 'nope');
  expect(gate(inp, { cfg: DEFAULTS, root: missing, readRoots: [missing, legacy], now: NOW, write: false }).decision).toBe('block');
});

