import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAgents, parseList, rolesTable, replaceBlock, BEGIN, END } from './agents.mjs';

test('parseList: CSV va mang JSON', () => {
  expect(parseList('A, B')).toEqual(['A', 'B']);
  expect(parseList('["Read", "Write"]')).toEqual(['Read', 'Write']);
});
test('loadAgents: bao name khac thu muc, thieu name', () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-'));
  const w = (d, t) => { fs.mkdirSync(path.join(r, '.claude/agents'), { recursive: true }); fs.writeFileSync(path.join(r, '.claude/agents', d + '.md'), t); };
  w('a', '---\nname: b\nmodel: haiku\nmaxTurns: 5\ntools: ["X","Y"]\n---\nx');
  w('c', '---\ndescription: d\n---\nx');
  const { agents, problems } = loadAgents(r);
  expect(agents[0].tools).toEqual(['X', 'Y']);
  expect(agents[0].maxTurns).toBe(5);
  expect(problems.join('|')).toContain('khac ten thu muc');
  expect(problems.join('|')).toContain('thieu name');
});
test('replaceBlock chi doi giua marker', () => {
  const t = `x\n${BEGIN}\nold\n${END}\ny`;
  expect(replaceBlock(t, 'NEW')).toBe(`x\n${BEGIN}\nNEW\n${END}\ny`);
  expect(replaceBlock('khong marker', 'N')).toBeNull();
  expect(rolesTable([{ name: 'a', model: 'm', maxTurns: 1, description: 'Mo ta. Them' }])).toContain('| `a` | m | 1 | Mo ta. Them |');
});
