import { test, expect } from 'bun:test';
import { render } from './cli.mjs';

test('apply/rollback --approve qua CLI: khong TTY -> exit 2 (agent khong tu duyet)', async () => {
  for (const cmd of ['apply', 'rollback']) {
    const r = await render({ cmd, arg: 'x1', approve: true, isTTY: false });
    expect(r.code).toBe(2);
    expect(r.summary).toContain('agent khong tu duyet');
  }
});

test('apply/rollback: nguoi tu choi -> exit 1; dong y moi toi ham apply', async () => {
  expect((await render({ cmd: 'apply', arg: 'x1', approve: true, confirm: () => false })).code).toBe(1);
  expect((await render({ cmd: 'rollback', arg: 'v1', approve: true, confirm: () => false })).code).toBe(1);
  await expect(render({ cmd: 'apply', arg: 'khong-co', approve: true, confirm: () => true, dataBase: '.', dataRoot: '.' })).rejects.toThrow();
});

// ---- wire2: --cost / --by-project / --detail / trung mo ta qua runPrune ----
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from './cli.mjs';
import { runPrune } from './prune-cli.mjs';

test('parseArgs: --cost --by-project --detail <kind:id>', () => {
  const o = parseArgs(['scan', '--kind', 'deprecate', '--cost', '--by-project', '--detail', 'skill:x']);
  expect(o.cost).toBe(true); expect(o.byProject).toBe(true); expect(o.detail).toBe('skill:x');
});

test('runPrune --cost/--by-project/--detail/dupes in tu fixture', async () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pcli-'));
  const wr = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
  const proj = tmp(), tr = tmp(), data = tmp(), audit = tmp();
  const d = 'quan ly tri thuc luu tru bao cao nghien cuu';
  for (const n of ['a', 'b']) wr(path.join(proj, `.claude/skills/${n}/SKILL.md`), `---\nname: ${n}\ndescription: ${d}\n---\nbody body body`);
  const ts = new Date(Date.now() - 86400000).toISOString();
  wr(path.join(tr, 'projA', 's.jsonl'), JSON.stringify({ type: 'assistant', sessionId: 's1', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'a' } }] } }) + '\n');
  const base = { hubRoot: proj, dataRoot: data, auditDir: audit, transcriptRoots: [tr], transcriptCache: path.join(data, 'c.jsonl'), extRoots: [] };
  const c = await runPrune({ ...base, cost: true });
  expect(c.summary).toContain('chi phi ngu canh');
  expect(c.summary).toContain('skill:a');
  expect(c.summary).toContain('trung mo ta: skill:a ~ skill:b');
  const p = await runPrune({ ...base, byProject: true });
  expect(p.summary).toContain('skill:a');
  expect(p.summary).toContain('projA=1');
  const x = await runPrune({ ...base, detail: 'skill:a' });
  expect(x.summary).toContain('kenh: tool=1');
  expect(x.summary).toContain('source=project');
  expect(x.summary).toContain('action=delete_in_repo');
});
