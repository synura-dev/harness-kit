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
  expect(r.warn).toMatch(/assumptions/);
  expect(r.warn).toMatch(/adopted/);
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
  expect(r.exitCode).toBe(2);
  expect(r.reason).toMatch(/counter/);
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
