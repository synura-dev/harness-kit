import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sumUsage, readUsageDelta, USAGE_TAIL } from './usage-tail.mjs';
import { buildEnvelope, readAuditConfig } from './audit.mjs';

const line = (id, o, extra = {}) => JSON.stringify({ type: 'assistant', uuid: 'u' + id, message: { id, model: 'claude-x', usage: { input_tokens: 10, output_tokens: o, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, ...extra } } }) + '\n';
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'utail-'));

test('sumUsage: dedupe theo message.id (lay output lon nhat), cong 4 loai token', () => {
  const r = sumUsage(line('a', 3) + line('a', 7) + line('b', 4) + JSON.stringify({ type: 'user' }) + '\n');
  expect(r).toMatchObject({ input: 20, output: 11, cache_read: 200, cache_creation: 10, msgs: 2 });
  expect(r.total_tokens).toBe(41);
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

test('readUsageDelta: offset tinh theo byte, tieng Viet cat giua ky tu khong lech', () => {
  const d = mk(); const f = path.join(d, 'vi.jsonl'); const root = path.join(d, 'audit');
  const vi = (id, o) => JSON.stringify({ type: 'assistant', uuid: id, message: { id, usage: { input_tokens: 1, output_tokens: o }, content: [{ text: 'Xin chào các bạn, đây là tiếng Việt ưu tiên' }] } });
  fs.writeFileSync(f, Buffer.concat([Buffer.from(vi('a', 2) + '\n'), Buffer.from(vi('b', 3), 'utf8').subarray(0, 60)])); // dong b cat giua ky tu da byte
  const r1 = readUsageDelta(f, { root });
  expect(r1.msgs).toBe(1); expect(r1.output).toBe(2);
  const full = Buffer.from(vi('b', 3) + '\n' + vi('c', 4) + '\n');
  fs.writeFileSync(f, Buffer.concat([Buffer.from(vi('a', 2) + '\n'), full]));
  const r2 = readUsageDelta(f, { root });
  expect(r2.msgs).toBe(2); expect(r2.output).toBe(7);
  expect(readUsageDelta(f, { root }).msgs).toBe(0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('readUsageDelta: nhay vao giua ky tu UTF-8 (qua tran) khong nem, bo dong dau', () => {
  const d = mk(); const f = path.join(d, 'big.jsonl'); const root = path.join(d, 'audit');
  fs.writeFileSync(f, Buffer.concat([Buffer.from('ế'.repeat(Math.ceil(USAGE_TAIL.maxBytes / 3) + 5) + '\n'), Buffer.from(line('z', 6))]));
  const r = readUsageDelta(f, { root });
  expect(r.truncated).toBe(true); expect(r.msgs).toBe(1); expect(r.output).toBe(6);
  fs.rmSync(d, { recursive: true, force: true });
});

test('offset moi transcript mot file: Stop va SubagentStop khong de nhau, ghi atomic', () => {
  const d = mk(); const root = path.join(d, 'audit');
  const f1 = path.join(d, 'main.jsonl'); const f2 = path.join(d, 'agent.jsonl');
  fs.writeFileSync(f1, line('a', 3)); fs.writeFileSync(f2, line('b', 4));
  expect(readUsageDelta(f1, { root }).msgs).toBe(1);
  expect(readUsageDelta(f2, { root }).msgs).toBe(1);
  fs.appendFileSync(f1, line('c', 5));
  expect(readUsageDelta(f2, { root }).msgs).toBe(0); // agent khong lam mat offset cua main
  const r = readUsageDelta(f1, { root });
  expect(r.msgs).toBe(1); expect(r.output).toBe(5); // khong tinh doi
  const files = fs.readdirSync(path.join(root, '.state', 'usage-offsets'));
  expect(files.filter((n) => n.endsWith('.json')).length).toBe(2);
  expect(files.some((n) => n.endsWith('.tmp'))).toBe(false);
  fs.rmSync(d, { recursive: true, force: true });
});

test('buildEnvelope Stop: usage_mode = cumulative khi doc duoc ca transcript, delta khi qua tran', () => {
  const d = mk(); const f = path.join(d, 'm.jsonl'); const root = path.join(d, 'audit');
  fs.writeFileSync(f, line('a', 3));
  const cfg = readAuditConfig();
  const inp = { hook_event_name: 'Stop', session_id: 'sess2', transcript_path: f, cwd: d };
  expect(buildEnvelope(inp, cfg, new Date(), { root }).data.usage_mode).toBe('cumulative');
  const small = { ...cfg, transcript_max_bytes: 10 };
  fs.appendFileSync(f, line('b', 4));
  const e = buildEnvelope(inp, small, new Date(), { root });
  expect(e.data.usage_mode).toBe('delta'); expect(e.tokens_out).toBe(4);
  fs.rmSync(d, { recursive: true, force: true });
});
