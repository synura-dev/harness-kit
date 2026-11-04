import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, handle } from './hook.mjs';
import { checkRouteReport } from './gate.mjs';

const GOOD = [
  'status: done', 'serves: route A2', 'assumptions: verified hook doc; unverified agy',
  'counter: parser lech khi doi mau (gate.mjs:300)', 'adopted: bo gop brief, vi ton token',
].join('\n');
const withCounter = (c) => GOOD.replace(/counter:.*/, 'counter: ' + c);
const NOW = new Date('2026-10-29T10:00:00.000Z');
const inp = (msg) => ({ hook_event_name: 'SubagentStop', session_id: 'rc-1', agent_id: 'ag1', agent_type: 'builder', last_assistant_message: msg });
const go = (msg, mode = 'warn') => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'route-'));
  fs.mkdirSync(path.join(root, 'date=2026-10-29'), { recursive: true });
  const r = handle('SubagentStop', inp(msg), { cfg: { ...DEFAULTS, routeFields: mode }, root, now: NOW });
  return { r, root };
};
const gateRules = (root) => { try { return fs.readFileSync(path.join(root, 'date=2026-10-29', 'type=gate', 'claude-rc-1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).data.gate); } catch { return []; } };

test('du truong -> ok + audit ok', () => {
  expect(checkRouteReport(GOOD)).toEqual({ applies: true, ok: true, missing: [] });
  const { r, root } = go(GOOD);
  expect(r.warn).toBeUndefined();
  const g = gateRules(root).find((x) => x.rule === 'route-check');
  expect(g.decision).toBe('allow');
});

test('thieu truong -> warn, exit 0, audit route-check', () => {
  const { r, root } = go('status: done\nserves: x\n');
  expect(r.block).toBe(false);
  expect(r.systemMessage).toMatch(/assumptions/);
  expect(r.systemMessage).toMatch(/adopted/);
  const g = gateRules(root).find((x) => x.rule === 'route-check');
  expect(g.decision).toBe('warn');
  expect(g.reason).toMatch(/missing=.*counter.*agent=builder/);
});

test('counter "khong co" / none / N/A / - bi bat', () => {
  for (const c of ['không có', 'khong co', 'None', 'N/A', '-', '—']) {
    expect(checkRouteReport(withCounter(c)).missing).toEqual(['counter(khong-co)']);
  }
});

test('counter khong dan chung bi bat; path:dong, URL, con so duoc chap nhan', () => {
  expect(checkRouteReport(withCounter('co the vo khi doi mau')).missing).toEqual(['counter(thieu-dan-chung)']);
  expect(checkRouteReport(withCounter('xem src/a.mjs:12')).ok).toBe(true);
  expect(checkRouteReport(withCounter('theo https://example.com/doc')).ok).toBe(true);
  expect(checkRouteReport(withCounter('tre them 300ms moi lan')).ok).toBe(true);
});

test('mode block -> deny exitCode 2 kem ly do', () => {
  const { r } = go(withCounter('khong co'), 'block');
  expect(r.block).toBe(true);
  expect(r.reason).toMatch(/counter/);
});

test('block + stop_hook_active -> ha xuong warn (chan toi da 1 lan)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'route-'));
  fs.mkdirSync(path.join(root, 'date=2026-10-29'), { recursive: true });
  const r = handle('SubagentStop', { ...inp(withCounter('khong co')), stop_hook_active: true }, { cfg: { ...DEFAULTS, routeFields: 'block' }, root, now: NOW });
  expect(r.block).toBe(false);
  expect(r.systemMessage).toMatch(/counter/);
  expect(gateRules(root).find((x) => x.rule === 'route-check').decision).toBe('warn');
});

test('status chi kich hoat khi la dong dau hoac PASS|FAIL|BLOCKED|PARTIAL', () => {
  expect(checkRouteReport('ghi chu\nstatus: todo\nserves: x').applies).toBe(false);
  expect(checkRouteReport('tom tat\nstatus: PASS\nserves: x').applies).toBe(true);
  expect(checkRouteReport('tom tat\n- status: partial').applies).toBe(true);
});

test('counter: so tran khong du, so co don vi thi du', () => {
  expect(checkRouteReport(withCounter('rui ro 1 va 2')).missing).toEqual(['counter(thieu-dan-chung)']);
  for (const c of ['tre 3s', 'cham 120ms', 'sai 40%', 'file 2KB', 'mat 15 lượt', 'mat 15 turns', 'fail 3 tests', 'dai 30 dòng']) expect(checkRouteReport(withCounter(c)).ok).toBe(true);
});

test('fallback doc agent_transcript_path khi khong co last_assistant_message', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'route-'));
  fs.mkdirSync(path.join(root, 'date=2026-10-29'), { recursive: true });
  const tp = path.join(root, 't.jsonl');
  const line = (role, text) => JSON.stringify({ message: { role, content: [{ type: 'text', text }] } });
  fs.writeFileSync(tp, [line('assistant', GOOD), line('user', 'x'), line('assistant', 'status: done\nserves: x')].join('\n') + '\n');
  const i = { ...inp(undefined), agent_transcript_path: tp }; delete i.last_assistant_message;
  const r = handle('SubagentStop', i, { cfg: { ...DEFAULTS, routeFields: 'warn' }, root, now: NOW });
  expect(r.systemMessage).toMatch(/assumptions/);
});

test('khong co status -> bo qua (khong audit route-check)', () => {
  const { r, root } = go('xong roi, khong co mau', 'block');
  expect(r.block).toBe(false);
  expect(r.warn).toBeUndefined();
  expect(gateRules(root).some((x) => x.rule === 'route-check')).toBe(false);
});

test('off -> tat', () => {
  const { r, root } = go('status: done', 'off');
  expect(r.warn).toBeUndefined();
  expect(r.block).toBe(false);
  expect(gateRules(root).some((x) => x.rule === 'route-check')).toBe(false);
});

test('dong truong dang bold/bullet va gia tri xuong dong van nhan', () => {
  const md = '- **status**: done\n- **serves**:\n  route A2\n* assumptions: ok\n* counter: gate.mjs:1\n* adopted: yes';
  expect(checkRouteReport(md).ok).toBe(true);
});
