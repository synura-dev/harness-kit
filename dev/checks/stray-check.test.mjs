import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strayReason, checkStray } from './clutter-check.mjs';
import { collectStray } from './scan-input.mjs';
import { DUP_ALLOW } from '../../harness/core/config/contract.mjs';

test('strayReason: thu muc rac, *.local.json that, .log/.bak/.tmp; extension data va example hop le', () => {
  for (const d of ['harness/.claude', 'harness/data', 'harness/node_modules', 'harness/.worktrees', 'harness/hooks/x/node_modules']) expect(strayReason(d, true)).not.toBe('');
  for (const f of ['harness/hooks/a/hook.config.local.json', 'harness/x.log', 'harness/y.BAK', 'harness/z.tmp']) expect(strayReason(f, false)).not.toBe('');
  expect(strayReason('harness/plugins/data', true)).toBe('');
  expect(strayReason('harness/hooks/a/hook.config.local.example.json', false)).toBe('');
  expect(strayReason('harness/core/a.mjs', false)).toBe('');
  expect(strayReason('data/x.log', false)).toBe('');
  expect(checkStray([{ path: 'harness/a.log' }, { path: 'harness/a.mjs' }]).map((f) => f.rule + ':' + f.severity)).toEqual(['stray:error']);
});

test('collectStray: quet harness/ tren cay that, khong di sau vao thu muc rac', () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'stray-'));
  const w = (p, s = 'x') => { fs.mkdirSync(path.dirname(path.join(r, p)), { recursive: true }); fs.writeFileSync(path.join(r, p), s); };
  w('harness/core/ok.mjs'); w('harness/plugins/data/data.mjs'); w('harness/data/a.json'); w('harness/hooks/g/hook.config.local.json');
  w('harness/cli/run.log'); w('harness/.claude/settings.json'); w('data/audit.log');
  const { entries, truncated } = collectStray(r);
  expect(entries.map((e) => e.path).sort()).toEqual(['harness/.claude', 'harness/cli/run.log', 'harness/data', 'harness/hooks/g/hook.config.local.json']);
  expect(truncated).toBe(false);
  expect(collectStray(r, { maxEntries: 2 }).truncated).toBe('limit');
});

test('DUP_ALLOW: <= 12 muc, moi muc co {name, files, reason}', () => {
  expect(DUP_ALLOW.length).toBeLessThanOrEqual(12);
  for (const x of DUP_ALLOW) {
    expect(typeof x.name).toBe('string');
    expect(Array.isArray(x.files) && x.files.length >= 2).toBe(true);
    expect(typeof x.reason === 'string' && x.reason.length > 0).toBe(true);
  }
});
