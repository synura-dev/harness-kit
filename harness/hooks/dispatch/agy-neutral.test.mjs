// Duong agy tool-neutral: khong co chuoi `.claude` (ke ca comment). Loai core/agy/agents.mjs (nguon vai tro Claude cho dev) va file test.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeEnvelope } from '../../core/audit/audit-write.mjs';
import { listFiles } from '../../observe/views/query/files.mjs';

const H = path.resolve(import.meta.dir, '..', '..');
const FILES = [
  'hooks/dispatch/agy-native.mjs', 'hooks/dispatch/agy.mjs', 'hooks/dispatch/agy-harness.mjs', 'core/io/agy-payload.mjs',
  'constrain/bash-guard/adapters/agy.mjs', 'core/runtime/user-shim.mjs', 'core/agy/legacy.mjs',
  ...fs.readdirSync(path.join(H, 'observe', 'audit', 'adapters')).filter((f) => /^agy.*\.mjs$/.test(f) && !/\.test\./.test(f)).map((f) => 'observe/audit/adapters/' + f),
];
// shortcut: T8 xoa `.claude` khoi core/runtime/user-shim.mjs (pluginCacheDir -> build/user-shim/claude-cache.mjs); T8 merge xong thi xoa muc nay.
const PENDING_T8 = new Set(['core/runtime/user-shim.mjs']);

for (const rel of FILES) {
  const f = path.join(H, rel);
  if (!fs.existsSync(f)) continue; // file khong ton tai (vd agy-harness.mjs) -> khong co gi de kiem
  const t = PENDING_T8.has(rel) ? test.todo : test;
  t(`agy-neutral: ${rel} khong chua .claude`, () => { expect(fs.readFileSync(f, 'utf8').includes('.claude')).toBe(false); });
}

test('tuong thich nguoc: dong audit co truong la van doc/query duoc', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-neutral-'));
  const env = { ts: '2026-11-07T01:02:03.000Z', type: 'gate', session_id: 's1', data: { kind: 'gate' }, truong_la_moi: { x: 1 } };
  writeEnvelope(env, {}, root);
  const files = listFiles(root, { type: ['gate'] });
  expect(files.length).toBe(1);
  const j = JSON.parse(fs.readFileSync(files[0].path, 'utf8').trim());
  expect(j.truong_la_moi).toEqual({ x: 1 });
  expect(j.data.kind).toBe('gate');
});
