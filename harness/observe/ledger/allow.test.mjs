import { test, expect } from 'bun:test';
import { loadDefinitions, evaluateAll, allowedByPaths } from './engine.mjs';

const HUB = 'E:/11. Agents';
const edit = (cwd, file, sid = 's1', project = 'p') => ({ event: 'PostToolUse', ts: new Date().toISOString(), sid, actor: 'main', tool: 'Edit', ok: true, cwd, project, target: file, data: { files_touched: [file] } });

test('allowedByPaths: glob tuong doi goc hub; ngoai hub -> khong cho', () => {
  const g = ['docs/decisions/**', '.claude/memory/**', 'CLAUDE.md'];
  expect(allowedByPaths(edit('E:\\11. Agents\\docs\\decisions', 'x.md'), g, HUB)).toBe(true);
  expect(allowedByPaths(edit('E:\\11. Agents', '.claude/memory/a/b.md'), g, HUB)).toBe(true);
  expect(allowedByPaths(edit('E:\\11. Agents', 'CLAUDE.md'), g, HUB)).toBe(true);
  expect(allowedByPaths(edit('E:\\11. Agents', 'src/a.ts'), g, HUB)).toBe(false);
  expect(allowedByPaths(edit('E:\\06. Projects\\x', 'CLAUDE.md'), g, HUB)).toBe(false);
  expect(allowedByPaths({ cwd: HUB, data: {} }, g, HUB)).toBe(false);
});

test('main-self-edit: tinh ca hub, tru allowlist; ghi de duoc bang allow_paths', () => {
  const { defs } = loadDefinitions({ evolveDir: null });
  const events = [edit('E:\\11. Agents', 'harness/a.mjs'), edit('E:\\11. Agents', 'harness/b.mjs'), edit('E:\\11. Agents', 'harness/c.mjs'), edit('E:\\11. Agents\\docs\\decisions', 'd.md'), edit('E:\\11. Agents', 'CLAUDE.md')];
  const f = evaluateAll(defs.filter((d) => d.id === 'main-self-edit'), { events }, { hubDir: HUB, nowMs: Date.now() }, ['audit']);
  expect(f.length).toBe(1);
  expect(f[0].count).toBe(3);
  const d2 = { ...defs.find((d) => d.id === 'main-self-edit'), allow_paths: ['harness/**'] };
  expect(evaluateAll([d2], { events }, { hubDir: HUB, nowMs: Date.now() }, ['audit']).length).toBe(0); // con 2 su kien (decisions, CLAUDE.md) < nguong 3
  expect(evaluateAll([{ ...d2, threshold: 2 }], { events }, { hubDir: HUB, nowMs: Date.now() }, ['audit'])[0].count).toBe(2);
});

test('min_sessions: du count nhung it phien -> khong finding', () => {
  const { defs } = loadDefinitions({ evolveDir: null });
  const pf = defs.find((d) => d.id === 'propose-fix');
  expect(pf.action).toBe('propose'); expect(pf.cooldown_hours).toBe(168); expect(pf.group_by).toBeUndefined();
  const mk = (n, sessions) => ({ kind: 'error', fp: 'f', count: n, sessions, last_ts: new Date().toISOString(), sample: 's' });
  const run = (c) => evaluateAll([pf], { candidates: [c] }, { hubDir: HUB, nowMs: Date.now() }, ['candidates']).length;
  expect(run(mk(12, 2))).toBe(0);
  expect(run(mk(12, 3))).toBe(1);
  expect(run(mk(9, 5))).toBe(0);
});
