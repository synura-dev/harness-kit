// bun test harness/tools/agy.test.mjs
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkHookCommand } from './adapters/agy.mjs';

test('checkHookCommand: resolve tu .agents/, cam tien to .agents/', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-'));
  const A = path.join(root, '.agents');
  fs.mkdirSync(path.join(A, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(A, 'hooks', 'x.mjs'), '');
  fs.writeFileSync(path.join(root, 'scripts', 'd.mjs'), '');
  expect(checkHookCommand('node hooks/x.mjs', A)).toEqual([]);
  expect(checkHookCommand('node ../scripts/d.mjs', A)).toEqual([]);
  expect(checkHookCommand('node hooks/none.mjs', A).length).toBe(1);
  const bad = checkHookCommand('node .agents/hooks/x.mjs', A);
  expect(bad.length).toBe(1);
  expect(bad[0]).toContain('bat dau bang .agents/');
  expect(checkHookCommand('node "C:/a/x.mjs"', A).length).toBeGreaterThan(0);
});

test('agy adapter run(): chap nhan layout agy, tu choi layout Claude', async () => {
  const { run } = await import('./adapters/agy.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-'));
  const A = path.join(root, '.agents');
  fs.mkdirSync(path.join(A, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(A, 'hooks', 'x.mjs'), '');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'x');
  const hooks = (o) => fs.writeFileSync(path.join(A, 'hooks.json'), JSON.stringify(o));
  hooks({ a: { PostToolUse: [{ matcher: '*', hooks: [{ command: 'node hooks/x.mjs' }] }], SessionStart: [{ command: 'node hooks/x.mjs' }] } });
  expect((await run({ root })).problems.filter((p) => p.includes('hooks.json'))).toEqual([]);
  hooks({ hooks: { PostToolUse: [{ matcher: '*', hooks: [{ command: 'node hooks/x.mjs' }] }] } });
  expect((await run({ root })).problems.some((p) => p.includes('layout kieu Claude'))).toBe(true);
});

test('mapTools: map da xac minh, bo trung, bo ten chua map', async () => {
  const { mapTools } = await import('./adapters/agy.mjs');
  expect(mapTools('Read, Glob, Grep, Bash')).toEqual(['view_file', 'run_command']);
  expect(mapTools('Read, Edit, Write, WebSearch, WebFetch')).toEqual(['view_file', 'edit_file', 'write_file']);
  expect(mapTools('WebSearch')).toEqual([]);
});

test('toolNote: chi-doc khi khong co edit/write', async () => {
  const { toolNote } = await import('./adapters/agy.mjs');
  expect(toolNote(['view_file', 'edit_file'])).not.toContain('CHI DOC');
  expect(toolNote(['view_file'])).toContain('CHI DOC');
  expect(toolNote(['view_file'])).toContain('khong dung link markdown file:///');
  expect(toolNote([])).toBe('\n');
});

test('agy adapter: khong sinh agents/<n>.md (viet tay), validator canh bao', async () => {
  const { run, checkAgentFile } = await import('./adapters/agy.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ag-'));
  const A = path.join(root, '.agents');
  fs.mkdirSync(path.join(A, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'x');
  const f = path.join(A, 'agents', 'v.md');
  fs.writeFileSync(f, '---\nname: v\ndescription: mo ta\nmodel: flash\ntools: [view_file]\n---\nThan prompt\n');
  const r = await run({ root });
  expect(r.problems).toEqual([]);
  expect(fs.readFileSync(f, 'utf8')).toContain('Than prompt');
  fs.writeFileSync(f, '---\nname: v\ndescription: d\nmodel: haiku\n---\n');
  expect((await run({ root })).problems.length).toBe(1);
  expect(checkAgentFile('---\nname: a\ndescription: d\nmodel: haiku\n---\n', 'f').length).toBe(1);
  expect(checkAgentFile('---\nname: a\ndescription: d\nmodel: pro\ntools: Read\n---\n', 'f').length).toBe(1);
  expect(checkAgentFile('---\nname: a\ndescription: d\ntools: [Read, view_file]\n---\n', 'f').length).toBe(1);
  expect(checkAgentFile('---\nname: a\ndescription: d\ntools: [view_file, run_command]\n---\n', 'f')).toEqual([]);
  expect(checkAgentFile('---\nname: a\ndescription: d\nmodel: inherit\n---\n', 'f')).toEqual([]);
});
