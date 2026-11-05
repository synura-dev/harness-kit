import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harnessCall, tally, collect, render } from './usage.mjs';

const post = (cmd, ok = true) => ({ event: 'PostToolUse', tool: 'Bash', ok, data: { cmd_line: cmd } });

test('harnessCall: bo cd/timeout, lay domain + sub', () => {
  expect(harnessCall('cd "x y" && timeout 5 harness tasks new --x')).toEqual({ domain: 'tasks', sub: 'new' });
  expect(harnessCall('harness doctor --json')).toEqual({ domain: 'doctor', sub: null });
  expect(harnessCall('git status')).toBeNull();
});

test('tally cmd/ext/hook dem lan + loi', () => {
  const ev = [post('harness tasks new'), post('harness tasks set', false), post('harness obsidian put'), post('ls'), { hook: 'guard', action: 'block' }, { hook: 'guard', action: 'error' }];
  expect([...tally(ev, 'cmd')].sort()).toEqual([['obsidian put', { n: 1, err: 0 }], ['tasks new', { n: 1, err: 0 }], ['tasks set', { n: 1, err: 1 }]]);
  expect(tally(ev, 'ext').get('tasks')).toEqual({ n: 2, err: 1 });
  expect(tally(ev, 'hook').get('guard')).toEqual({ n: 2, err: 1 });
});

test('collect: loc ngay + timeout -> truncated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const now = Date.parse('2026-11-05T00:00:00Z');
  for (const d of ['2026-11-04', '2026-10-01']) {
    const dir = path.join(root, `date=${d}`, 'type=tool'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's.jsonl'), JSON.stringify(post('harness doctor')) + '\n');
  }
  expect(collect({ root, days: 7, nowMs: now }).events.length).toBe(1);
  expect(collect({ root, days: 90, nowMs: now, timeoutMs: -1 }).truncated).toBe('timeout');
  const r = render({ by: 'cmd', days: 7, limit: 5, root, nowMs: now });
  expect(r.summary).toContain('doctor');
  fs.rmSync(root, { recursive: true, force: true });
});

test('harnessCall: duong dan, bo chuoi nhay; tally dem PowerShell', () => {
  expect(harnessCall('node /x/bin/harness.mjs tasks new')).toEqual({ domain: 'tasks', sub: 'new' });
  expect(harnessCall('C:\\a\\harness.cmd doctor')).toEqual({ domain: 'doctor', sub: null });
  expect(harnessCall('git commit -m "fix harness tasks"')).toBeNull();
  expect(harnessCall('harness projects brief gemsocial')).toEqual({ domain: 'projects', sub: 'brief' });
  const ps = { event: 'PostToolUse', tool: 'PowerShell', ok: true, data: { cmd_line: 'harness tasks new' } };
  expect(tally([ps], 'cmd').get('tasks new')).toEqual({ n: 1, err: 0 });
});
