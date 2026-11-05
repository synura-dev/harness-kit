import { test, expect } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProcDirect, scanProcDirect, PROC_EXCEPTIONS } from './proc-check.mjs';

test('check proc-direct bat goi thang child_process, bo qua test/ngoai le', () => {
  const v = checkProcDirect([
    { path: 'harness/a.mjs', text: "import { spawn } from 'node:child_process';" },
    { path: 'harness/b.mjs', text: "const { x } = await import('node:child_process');" },
    { path: 'harness/c.mjs', text: "const c = require('child_process');" },
    { path: 'harness/d.mjs', text: "Bun.spawnSync(['git']);" },
    { path: 'harness/ok.mjs', text: "import { spawn } from '../core/runtime/proc.mjs';\n// child_process chi la comment" },
    { path: 'harness/a.test.mjs', text: "import cp from 'node:child_process';" },
    { path: 'harness/core/runtime/proc.mjs', text: "import cp from 'node:child_process';" },
  ]);
  expect(v.map((x) => x.file)).toEqual(['harness/a.mjs', 'harness/b.mjs', 'harness/c.mjs', 'harness/d.mjs']);
});

test('cay repo hien tai khong con goi thang child_process', () => {
  const root = path.resolve(import.meta.dir, '..', '..');
  expect(scanProcDirect(root)).toEqual([]);
  expect(Object.keys(PROC_EXCEPTIONS).length).toBeLessThanOrEqual(6);
});
