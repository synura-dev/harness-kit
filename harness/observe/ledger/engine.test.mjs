import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluate, evaluateAll, loadDefinitions, validateDef, matchFilter } from './engine.mjs';

const HUB = 'E:/11. Agents';
const NOW = Date.parse('2026-11-05T12:00:00Z');
const ctx = { hubDir: HUB, nowMs: NOW };
const ev = (o) => ({ ts: '2026-11-05T10:00:00Z', sid: 'claude-a', actor: 'main', tool: 'Edit', event: 'PostToolUse', ok: true, project: 'foo', cwd: 'E:/06. Projects/foo', data: { files_touched: ['a.js'] }, ...o });

test('defaults nap duoc, hop le', () => {
  const r = loadDefinitions();
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.defs.map((d) => d.id).sort(), ['main-self-edit', 'main-self-verify', 'repeated-error', 'warn-ignored']);
});

test('loc audit theo actor/scope; nhom theo project; nguong', () => {
  const [def] = loadDefinitions().defs.filter((d) => d.id === 'main-self-edit');
  const events = [ev({}), ev({}), ev({}), ev({ actor: 'sub' }), ev({ project: 'bar', cwd: 'E:/06. Projects/bar' }),
    ev({ cwd: HUB, project: 'hub', data: { files_touched: ['docs/x.md'] } }), ev({ tool: 'Read' })];
  const f = evaluate(def, { events }, ctx);
  assert.equal(f.length, 1); // foo=3 dat nguong 3; bar=1 khong; hub khong tinh; sub/Read bi loc
  assert.equal(f[0].count, 3); assert.equal(f[0].key, 'foo'); assert.match(f[0].message, /foo/);
  assert.equal(f[0].action, 'warn');
});

test('scope: sua file du an ngoai hub tu cwd hub = other; projects/<id>/repo = other', () => {
  const def = { id: 't', source: 'audit', filter: { scope: 'other' }, threshold: 1, action: 'log' };
  const hubEditOutside = ev({ cwd: HUB, project: 'hub', data: { files_touched: ['E:/06. Projects/foo/a.js'] } });
  const hubEditJunction = ev({ cwd: HUB, project: 'hub', data: { files_touched: ['projects/x/repo/a.js'] } });
  const hubOwn = ev({ cwd: HUB, project: 'hub', data: { files_touched: ['docs/a.md'] } });
  assert.equal(evaluate(def, { events: [hubEditOutside, hubEditJunction, hubOwn] }, ctx)[0].count, 2);
});

test('cua so ngay: su kien cu bi bo', () => {
  const def = { id: 't', source: 'audit', days: 1, filter: {}, threshold: 1, action: 'log' };
  assert.equal(evaluate(def, { events: [ev({ ts: '2026-11-01T00:00:00Z' })] }, ctx).length, 0);
});

test('nguon candidates: kind + nguong count, message mau', () => {
  const [def] = loadDefinitions().defs.filter((d) => d.id === 'repeated-error');
  const c = (o) => ({ id: 'i', kind: 'error', fp: 'f1', count: 3, sessions: 2, first_ts: '2026-11-02T00:00:00Z', last_ts: '2026-11-05T00:00:00Z', sample: 'boom', ...o });
  const f = evaluateAll([def], { candidates: [c({}), c({ fp: 'f2', count: 2 }), c({ fp: 'f3', kind: 'pattern' }), c({ fp: 'f4', last_ts: '2026-10-01T00:00:00Z' })] }, ctx);
  assert.equal(f.length, 1); assert.equal(f[0].fp, 'f1'); assert.match(f[0].message, /3 lan\/2 phien: boom/);
});

test('metric sessions / sum:cost_ms', () => {
  const evs = [ev({ sid: 'a', duration_ms: 400 }), ev({ sid: 'b', duration_ms: 700 })];
  assert.equal(evaluate({ id: 't', source: 'audit', filter: {}, metric: 'sessions', threshold: 2, action: 'log' }, { events: evs }, ctx).length, 1);
  assert.equal(evaluate({ id: 't', source: 'audit', filter: {}, metric: 'sum:cost_ms', threshold: 1000, action: 'log' }, { events: evs }, ctx)[0].value, 1100);
  assert.equal(evaluate({ id: 't', source: 'audit', filter: {}, metric: 'sum:cost_ms', threshold: 1200, action: 'log' }, { events: evs }, ctx).length, 0);
});

test('matchFilter: mang, not, any, gte, regex', () => {
  const get = (k) => ({ a: 'x', n: 5 })[k];
  assert.ok(matchFilter(get, { a: ['x', 'y'] }));
  assert.ok(!matchFilter(get, { a: { not: 'x' } }));
  assert.ok(matchFilter(get, { any: [{ a: 'z' }, { n: { gte: 5 } }] }));
  assert.ok(matchFilter(get, { a: { regex: '^X$' } }));
});

test('validateDef bat loi', () => {
  assert.ok(validateDef({ source: 'nope', action: 'warn', threshold: 1 }).length);
  assert.deepEqual(validateDef({ source: 'audit', action: 'warn', threshold: 1 }), []);
});

test('ghi de theo thu muc du an: cung ten thay, ten moi them, enabled:false tat; khong registry', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'));
  const dir = path.join(proj, '.harness', 'rules'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'repeated-error.json'), JSON.stringify({ source: 'candidates', filter: { kind: 'error' }, threshold: 10, action: 'log' }));
  fs.writeFileSync(path.join(dir, 'main-self-edit.json'), JSON.stringify({ enabled: false }));
  fs.writeFileSync(path.join(dir, 'custom.json'), JSON.stringify({ source: 'audit', filter: {}, threshold: 1, action: 'report' }));
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ khong phai json');
  const r = loadDefinitions({ projectDir: proj });
  const by = Object.fromEntries(r.defs.map((d) => [d.id, d]));
  assert.equal(by['repeated-error'].threshold, 10); assert.equal(by['repeated-error'].origin, 'project');
  assert.ok(!by['main-self-edit']); assert.ok(by.custom); assert.ok(by['main-self-verify']);
  assert.equal(r.errors.length, 1);
  fs.rmSync(proj, { recursive: true, force: true });
});

test('timeout nap dinh nghia -> truncated', () => {
  assert.equal(loadDefinitions({ timeoutMs: -1 }).truncated, 'timeout');
});
