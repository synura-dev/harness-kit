import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unregisteredDirs } from './harness.mjs';
import { writeEnvelope } from '../core/audit/audit-write.mjs';

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dg-'));

test('unregisteredDirs: thu muc la -> ten; zone/reserved/dot -> bo qua; loi -> null', () => {
  const d = tmp();
  for (const n of ['zzz-lalala', 'system', '.state']) fs.mkdirSync(path.join(d, n));
  expect(unregisteredDirs({ env: { HUB_DATA_DIR: d } })).toBe('zzz-lalala');
  fs.rmSync(path.join(d, 'zzz-lalala'), { recursive: true });
  expect(unregisteredDirs({ env: { HUB_DATA_DIR: d } })).toBeNull();
  expect(unregisteredDirs({ env: { HUB_DATA_DIR: path.join(d, 'khong-co') } })).toBeNull();
});

test('audit writer: moi muc deu ghi (enforce van chi warn), fail-open', () => {
  for (const mode of ['off', 'warn', 'enforce']) {
    const d = tmp();
    const old = { ...process.env };
    process.env.HARNESS_DATA_ENFORCE = mode;
    try {
      const a = path.join(d, 'audit');
      writeEnvelope({ ts: '2026-01-01T00:00:00Z', type: 't', sid: 's' }, {}, a);
      expect(fs.existsSync(path.join(a, 'date=2026-01-01', 'type=t', 's.jsonl'))).toBe(true);
    } finally { process.env.HARNESS_DATA_ENFORCE = old.HARNESS_DATA_ENFORCE; if (old.HARNESS_DATA_ENFORCE === undefined) delete process.env.HARNESS_DATA_ENFORCE; }
  }
});

const compact = (mode) => {
  const d = tmp();
  const tasks = path.join(d, 'TASKS.md');
  fs.writeFileSync(tasks, '# T\n\n## Done\n- [x] a\n- [x] b\n- [x] c\n- [x] d\n');
  const arch = path.join(d, 'zzz-unreg', 'archive.jsonl');
  const r = spawnSync(process.execPath, [path.join(root, 'hub/tasks/tasks.mjs'), 'compact', '--keep-done', '0'], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HUB_DATA_DIR: d, HUB_TASKS_FILE: tasks, HUB_TASKS_ARCHIVE: arch, HARNESS_EXT_ALLOW_WRITE: path.dirname(arch), HARNESS_DATA_ENFORCE: mode },
  });
  return { r, arch };
};

