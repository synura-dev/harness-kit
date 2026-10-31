// Chuan HOOK_MODULE (Dot 5.1) cho inject: default export hop le, handle async (event,input,ctx), write:false khong ghi file, ctx.query van dung.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import inject from './hook.mjs';
import { validateHookModule, validateHookResult } from '../../core/config/contract.mjs';

test('default export hop le, handle async', () => {
  expect(validateHookModule(inject)).toEqual([]);
  expect(inject.handle.constructor.name).toBe('AsyncFunction');
});

test('handle(write:false): ket qua hop le, khong ghi file (thu muc tam)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-std-'));
  try {
    const r = await inject.handle('UserPromptSubmit', { prompt: 'xin chao', session_id: 's' }, { write: false, root: dir });
    expect(validateHookResult(r)).toEqual([]);
    expect(await inject.handle('SessionStart', null, { write: false, root: dir })).toEqual({});
    expect(fs.readdirSync(dir)).toEqual([]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
