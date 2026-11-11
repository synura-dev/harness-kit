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

test('runPrune: khoa quet transcript — khoa song -> busy (khong quet/ghi); khoa cu/pid chet -> tiep tuc va nha khoa', async () => {
  const mkd = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plock-'));
  const proj = mkd(), tr = mkd(), data = mkd(), audit = mkd();
  const lock = path.join(data, 'transcripts.lock');
  const base = { hubRoot: proj, dataRoot: data, auditDir: audit, transcriptRoots: [tr], transcriptCache: path.join(data, 'c.jsonl'), extRoots: [], record: true };
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  const b = await runPrune(base);
  expect(b.summary).toContain(`busy: pid ${process.pid}`);
  expect(fs.existsSync(path.join(data, 'prune-state.json'))).toBe(false);
  expect(fs.existsSync(path.join(data, 'c.jsonl'))).toBe(false);
  expect(fs.existsSync(lock)).toBe(true);
  for (const st of [{ pid: 2147483646, ts: Date.now() }, { pid: process.pid, ts: Date.now() - 11 * 60000 }]) {
    fs.writeFileSync(lock, JSON.stringify(st));
    const o = await runPrune(base);
    expect(o.summary).not.toContain('busy');
    expect(fs.existsSync(lock)).toBe(false);
  }
});

test('evolve list co cot verdict (trong neu chua do); evolve log hien dong effect', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ecli-'));
  const wj = (f, j) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(j)); };
  const base = { kind: 'rule', change: { target: 'evolve/rules/evolve-x.json' } };
  wj(path.join(data, 'proposals', 'p1.json'), { ...base, id: 'p1', status: 'applied', ver: 'v1', effect: { verdict: 'worse', action: 'rollback' } });
  wj(path.join(data, 'proposals', 'p2.json'), { ...base, id: 'p2', status: 'checked' });
  fs.writeFileSync(path.join(data, 'applied.jsonl'), JSON.stringify({ ts: '2026-11-07T00:00:00Z', op: 'effect', id: 'p1', ver: 'v1', verdict: 'worse', action: 'rollback', reason: 'rate 1.00 -> 2.00 /1000' }) + '\n');
  const l = await render({ cmd: 'list', dataRoot: data });
  const rows = l.summary.split('\n');
  expect(rows.find((r) => r.startsWith('p1'))).toContain('verdict=worse');
  expect(rows.find((r) => r.startsWith('p2'))).not.toContain('verdict');
  expect(l.data.find((p) => p.id === 'p1').effect.verdict).toBe('worse');
  const g = await render({ cmd: 'log', dataRoot: data });
  expect(g.summary).toMatch(/effect .*worse\/rollback/);
  fs.rmSync(data, { recursive: true, force: true });
});

test('parseArgs: --manual-done, --fix-target area:path', () => {
  const o = parseArgs(['propose', 'c1', '--kind', 'fix', '--fix-target', 'brief:.claude/agents/builder.md']);
  expect(o.fixTarget).toEqual({ area: 'brief', path: '.claude/agents/builder.md' });
  expect(parseArgs(['apply', 'p1', '--manual-done']).manualDone).toBe(true);
  expect(() => parseArgs(['propose', 'c1', '--fix-target', 'khongco'])).toThrow();
});
