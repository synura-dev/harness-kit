// bun test harness/knowledge/inject/handle.test.mjs - hop dong HOOK_MODULE: handle(event, input, ctx) -> {additionalContext}.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { put } from '../vault/vault.mjs';
import { handle, hook } from './hook.mjs';
import { validateHookModule, validateHookResult } from '../../core/config/contract.mjs';

const NOW = '2026-10-29';
let root;
const add = (meta, body = 'noi dung') => { const r = put({ meta, body }, { root, now: NOW }); if (!r.ok) throw new Error(r.errors.join('; ')); };

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinject-h-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('descriptor hop le theo validateHookModule', () => {
  expect(validateHookModule(hook)).toEqual([]);
  expect(hook.events).toEqual(['UserPromptSubmit', 'SessionStart']);
});

test('handle(event, input, ctx): khop -> {additionalContext}; chuoi khop dang cu', () => {
  add({ id: 'deploy-verify', kind: 'lesson', tags: ['deploy'], source: 'docs/deploy.md' }, 'Kiem hash + health sau deploy');
  const input = { prompt: 'chuẩn bị deploy bản mới' };
  const r = handle('UserPromptSubmit', input, { root, now: NOW });
  expect(validateHookResult(r)).toEqual([]);
  expect(r.additionalContext).toContain('- deploy-verify [lesson] Kiem hash + health sau deploy — docs/deploy.md');
  const old = JSON.parse(handle({ hook_event_name: 'UserPromptSubmit', ...input }, { root, now: NOW }));
  expect(old.hookSpecificOutput.additionalContext).toBe(r.additionalContext);
  expect(input).toEqual({ prompt: 'chuẩn bị deploy bản mới' }); // khong doi input
});

test('khong khop / su kien khac / timeout vault / input hong -> {} khong nem', () => {
  add({ id: 'deploy-verify', kind: 'lesson', tags: ['deploy'] }, 'x');
  expect(handle('UserPromptSubmit', { prompt: 'viết bài thơ' }, { root, now: NOW })).toEqual({});
  expect(handle('PreToolUse', { prompt: 'deploy' }, { root, now: NOW })).toEqual({});
  expect(handle('UserPromptSubmit', { prompt: 'deploy' }, { root, now: NOW, cfg: { timeoutMs: 1 } })).toEqual({});
  expect(handle('UserPromptSubmit', null, { root })).toEqual({});
  expect(handle('', { hook_event_name: 'SessionStart' }, { root, now: NOW })).toEqual({});
});

test('SessionStart: event lay tu input khi doi so rong (dang dispatcher hook.handle(input, ctx))', () => {
  add({ id: 'always-rule', kind: 'rule', tags: ['pinned'] }, 'Luon chay test co timeout');
  const r = hook.handle({ hook_event_name: 'SessionStart', source: 'startup' }, { root, now: NOW });
  expect(r.additionalContext).toContain('always-rule [rule]');
});

test('ctx.query in-process: khong spawn vault; nhan args dung; null/loi -> {}', () => {
  let seen;
  const items = [{ id: 'deploy-verify', kind: 'lesson', tags: ['deploy'], line: 'Kiem hash', status: 'active', source: null }];
  const r = handle('UserPromptSubmit', { prompt: 'deploy' }, { root: path.join(root, 'khong-ton-tai'), now: NOW, query: (a) => { seen = a; return { items }; } });
  expect(r.additionalContext).toContain('deploy-verify [lesson] Kiem hash');
  expect(seen.status).toBe('active');
  expect(seen.limit).toBe(500);
  expect(handle('UserPromptSubmit', { prompt: 'deploy' }, { query: () => null })).toEqual({});
  expect(handle('UserPromptSubmit', { prompt: 'deploy' }, { query: () => { throw new Error('x'); } })).toEqual({});
});
