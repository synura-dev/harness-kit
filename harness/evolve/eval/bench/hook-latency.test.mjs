import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, collectEntries, writeDocOut, parseArgs } from './hook-latency.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(HERE, '..', '..', '..', '..');
let tmp, settingsFile;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
  fs.mkdirSync(path.join(tmp, '.claude'));
  settingsFile = path.join(tmp, '.claude', 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'cat > /dev/null; exit 0' }] }, { matcher: 'Read', hooks: [{ type: 'command', command: 'exit 1' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'exit 0' }] }],
  } }));
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('collectEntries: loc theo matcher (Bash khop, Read khong), bo hook khong phai command', () => {
  const e = collectEntries(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), ['PreToolUse', 'Stop']);
  expect(e.map((x) => `${x.event}:${x.matcher}`)).toEqual(['PreToolUse:Bash', 'Stop:(none)']);
});

test('parseArgs: tu choi event la / n ngoai khoang / co la', () => {
  expect(() => parseArgs(['--event', 'Nope'])).toThrow(/event la/);
  expect(() => parseArgs(['--n', '0'])).toThrow(/--n/);
  expect(() => parseArgs(['--x'])).toThrow(/tham so la/);
  expect(parseArgs(['--event=Stop,PreToolUse', '--n', '2']).events).toEqual(['Stop', 'PreToolUse']);
});

test('main: chay 2 lan / 1 event voi settings tam; mac dinh KHONG ghi file; --json hop le', () => {
  const lines = [];
  const code = main(['--settings', settingsFile, '--event', 'PreToolUse', '--n', '2', '--json'], { out: (s) => lines.push(s), err: () => {} });
  expect(code).toBe(0);
  const j = JSON.parse(lines.join('\n'));
  expect(j.hooks.length).toBe(1);
  expect(j.hooks[0]).toMatchObject({ event: 'PreToolUse', n: 2, nonZeroExit: 0, timedOut: 0 });
  expect(j.chains[0]).toMatchObject({ event: 'PreToolUse', hooks: 1, n: 2 });
  expect(j.truncated).toBeNull();
  expect(fs.readdirSync(tmp).sort()).toEqual(['.claude']); // khong ghi file nao
});

test('--out: ghi file khi co, tu choi doc mac dinh va file co san neu thieu --force', () => {
  const out = path.join(tmp, 'res.md');
  const quiet = { out: () => {}, err: () => {} };
  expect(main(['--settings', settingsFile, '--event', 'Stop', '--n', '1', '--out', out], quiet)).toBe(0);
  expect(fs.readFileSync(out, 'utf8')).toContain('## Tung hook');
  expect(main(['--settings', settingsFile, '--event', 'Stop', '--n', '1', '--out', out], quiet)).toBe(2);
  expect(main(['--settings', settingsFile, '--event', 'Stop', '--n', '1', '--out', out, '--force'], quiet)).toBe(0);
  const doc = path.join(HUB, 'docs', 'research', 'hook-latency-baseline.md');
  const before = fs.existsSync(doc) ? fs.readFileSync(doc, 'utf8') : null;
  expect(() => writeDocOut(doc, 'x', { force: true, protect: doc })).toThrow(/doc mac dinh/);
  // plugin mode: goc workspace = CLAUDE_PROJECT_DIR (cwd); ep = HUB de doc mac dinh trung doc o tren (hub mode bo qua bien nay)
  const oldP = process.env.CLAUDE_PROJECT_DIR; process.env.CLAUDE_PROJECT_DIR = HUB;
  try { expect(main(['--settings', settingsFile, '--event', 'Stop', '--n', '1', '--out', doc, '--force'], quiet)).toBe(2); }
  finally { if (oldP === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = oldP; }
  expect(fs.existsSync(doc) ? fs.readFileSync(doc, 'utf8') : null).toBe(before);
});

test('tran tong: timeout-s qua nho -> dung em, truncated: timeout', () => {
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'sleep 1' }] }] } }));
  const lines = [];
  main(['--settings', settingsFile, '--event', 'Stop', '--n', '50', '--timeout-s', '0.5', '--json'], { out: (s) => lines.push(s), err: () => {} });
  expect(JSON.parse(lines.join('\n')).truncated).toBe('timeout');
}, 30000);

test('qua cong harness: eval bench --event PreToolUse --n 1 --settings tam chay duoc', () => {
  const r = spawnSync(process.execPath, [path.join(HUB, 'harness', 'cli', 'harness.mjs'), 'eval', 'bench', '--settings', settingsFile, '--event', 'PreToolUse', '--n', '1'], { cwd: HUB, encoding: 'utf8', timeout: 60000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('PreToolUse');
});
