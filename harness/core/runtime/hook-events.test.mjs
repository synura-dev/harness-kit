// 14 su kien hook cua plugin (HOOK_EVENTS trong tools/plugin/export.mjs): moi su kien -> goi dispatcher voi stdin mau, exit code dung, khong chay doi (dem dong audit).
// stdin la pipe (khong TTY) nen cac nhanh approval (PreToolUse/PermissionRequest) chay nhanh khong-TTY.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOOK_EVENTS } from './hook-events.mjs';

const ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const RUN = path.join(ROOT, 'harness', 'hooks', 'dispatch', 'run.mjs');

const countLines = (dir) => {
  let n = 0;
  const walk = (p) => {
    for (const e of fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }) : []) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else if (f.endsWith('.jsonl')) n += fs.readFileSync(f, 'utf8').split('\n').filter((l) => l && !l.includes('"event":"HookRun"')).length; // HookRun (se/0029) la dong do tre, khong tinh
    }
  };
  walk(dir);
  return n;
};

// Worktree*: HUB_DIR tro vao repo tam (khong dung repo that).
function tmpRepo(d) {
  const r = path.join(d, 'repo');
  fs.mkdirSync(r);
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: r });
  g('init', '-q'); fs.writeFileSync(path.join(r, 'a.txt'), 'x'); g('add', 'a.txt'); g('commit', '-q', '-m', 'i');
  return r;
}

test('hooks.json cua plugin khai bao 14 su kien', () => {
  expect(HOOK_EVENTS.length).toBe(14);
  expect(new Set(HOOK_EVENTS.map((e) => e[0])).size).toBe(14);
});

for (const [ev] of HOOK_EVENTS) {
  test(`su kien ${ev}: exit 0, stdout JSON hop le/duong dan, <= 1 dong audit (khong chay doi)`, () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'evs-'));
    const audit = path.join(d, 'audit');
    fs.mkdirSync(audit);
    const wt = ev.startsWith('Worktree');
    const hub = wt ? tmpRepo(d) : ROOT;
    const env = { ...process.env, HUB_DATA_DIR: path.join(d, 'data'), CLAUDE_AUDIT_DIR: audit, GUARD_LOG_FILE: path.join(d, 'g.jsonl'), HUB_DIR: hub };
    const input = JSON.stringify({ session_id: 'evs1', cwd: hub, hook_event_name: ev, tool_name: 'Bash', tool_input: { command: 'git status' }, tool_response: { stdout: 'x' }, prompt: 'hi', message: 'm', name: 'wt1', worktree_path: path.join(hub, '.worktrees', 'wt1'), agent_id: 'a1', agent_type: 'builder', error: 'e', reason: 'r' });
    const r = spawnSync(process.execPath, [RUN, ev], { input, env, encoding: 'utf8', timeout: 60000 });
    expect(r.status).toBe(0);
    if (!wt) expect(() => JSON.parse(r.stdout || '{}')).not.toThrow();
    const n = countLines(audit);
    expect(n).toBeLessThanOrEqual(1);
    if (!wt) expect(n).toBe(1);
  });
}
