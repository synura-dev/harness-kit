import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sumUsage, readUsageDelta, USAGE_TAIL } from './usage-tail.mjs';
import { buildEnvelope } from './audit.mjs';
import { readAuditConfig } from '../../core/config/audit-config.mjs';

const line = (id, o, extra = {}) => JSON.stringify({ type: 'assistant', uuid: 'u' + id, message: { id, model: 'claude-x', usage: { input_tokens: 10, output_tokens: o, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, ...extra } } }) + '\n';
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'utail-'));

test('sumUsage: dedupe theo message.id (lay output lon nhat), cong 4 loai token', () => {
  const r = sumUsage(line('a', 3) + line('a', 7) + line('b', 4) + JSON.stringify({ type: 'user' }) + '\n');
  expect(r).toMatchObject({ input: 20, output: 11, cache_read: 200, cache_creation: 10, msgs: 2 });
});

test('readUsageDelta: chi cong message moi ke tu lan truoc; offset theo transcript', () => {
  const d = mk(); const f = path.join(d, 't.jsonl'); const root = path.join(d, 'audit');
  fs.writeFileSync(f, line('a', 3) + line('b', 4));
  const r1 = readUsageDelta(f, { root });
  expect(r1.msgs).toBe(2); expect(r1.output).toBe(7);
  fs.appendFileSync(f, line('c', 5));
  const r2 = readUsageDelta(f, { root });
  expect(r2.msgs).toBe(1); expect(r2.output).toBe(5);
  expect(readUsageDelta(f, { root }).msgs).toBe(0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('readUsageDelta: dong cuoi dang ghi do khong tinh; file lon -> chi doc duoi, truncated', () => {
  const d = mk(); const f = path.join(d, 't.jsonl'); const root = path.join(d, 'audit');
  fs.writeFileSync(f, line('a', 3) + '{"type":"assistant","message":{"id":"zz","usage":{"output_tok');
  expect(readUsageDelta(f, { root }).msgs).toBe(1);
  const big = path.join(d, 'big.jsonl');
  fs.writeFileSync(big, line('old', 1).repeat(1) + 'x'.repeat(USAGE_TAIL.maxBytes) + '\n' + line('new', 9));
  const r = readUsageDelta(big, { root });
  expect(r.truncated).toBe(true); expect(r.msgs).toBe(1); expect(r.output).toBe(9);
  fs.rmSync(d, { recursive: true, force: true });
});

test('readUsageDelta: khong co file/khong phai jsonl -> null (fail-open)', () => {
  expect(readUsageDelta('/khong/co.jsonl')).toBeNull();
  expect(readUsageDelta(null)).toBeNull();
  expect(readUsageDelta('/x/y.txt')).toBeNull();
});

test('buildEnvelope Stop: data.usage la object cua phan moi; Stop sau chi cong phan them', () => {
  const d = mk(); const f = path.join(d, 's.jsonl'); const root = path.join(d, 'audit');
  fs.writeFileSync(f, line('a', 3));
  const cfg = readAuditConfig();
  const e1 = buildEnvelope({ hook_event_name: 'Stop', session_id: 'sess1', transcript_path: f, cwd: d }, cfg, new Date(), { root });
  expect(e1.data.usage).toMatchObject({ input: 10, output: 3, cache_read: 100, cache_creation: 5, msgs: 1 });
  fs.appendFileSync(f, line('b', 8));
  const e2 = buildEnvelope({ hook_event_name: 'Stop', session_id: 'sess1', transcript_path: f, cwd: d }, cfg, new Date(), { root });
  expect(e2.data.usage).toMatchObject({ output: 8, msgs: 1 });
  fs.rmSync(d, { recursive: true, force: true });
});
