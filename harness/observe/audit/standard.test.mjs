// Chuan HOOK_MODULE (Dot 5.1) cho audit: default export hop le, handle async (event,input,ctx), write:false khong ghi file, envelope trong records.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import audit from './audit.mjs';
import { validateHookModule, validateHookResult } from '../../core/config/shape.mjs';

test('default export hop le, handle async', () => {
  expect(validateHookModule(audit)).toEqual([]);
  expect(audit.handle.constructor.name).toBe('AsyncFunction');
});

test('handle(write:false): khong ghi file, records[audit]; write mac dinh: ghi file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-std-'));
  const root = path.join(dir, 'audit');
  const NOW = new Date('2026-10-29T10:00:00Z');
  const inp = { hook_event_name: 'Stop', session_id: 'std-1' };
  try {
    const r = await audit.handle('Stop', inp, { root, write: false, now: NOW });
    expect(validateHookResult(r)).toEqual([]);
    expect(r.records[0].sink).toBe('audit');
    expect(r.records[0].data.event).toBe('Stop');
    expect(fs.existsSync(root)).toBe(false);
    expect(await audit.handle(undefined, null, { root, write: false })).toEqual({});
    await audit.handle('Stop', inp, { root, now: NOW });
    expect(fs.existsSync(root)).toBe(true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
