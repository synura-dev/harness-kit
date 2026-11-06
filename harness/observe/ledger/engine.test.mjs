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
  const r = loadDefinitions({ evolveDir: null });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.defs.map((d) => d.id).sort(), ['cap', 'deprecate', 'main-self-edit', 'main-self-verify', 'propose-fix', 'repeated-error', 'repeated-pattern', 'warn-ignored']);
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
  assert.equal(f.length, 1); assert.equal(f[0].fp, 'f1'); assert.match(f[0].message, /3 lan\/2 phien: .*boom/);
});

test('repeated-error: loi lap trong 1 phien (retry/guard chan) khong canh bao; >=2 phien van canh bao', () => {
  const [def] = loadDefinitions({ evolveDir: null }).defs.filter((d) => d.id === 'repeated-error');
  const c = (o) => ({ id: 'i', kind: 'error', fp: 'f1', count: 13, sessions: 1, first_ts: '2026-11-02T00:00:00Z', last_ts: '2026-11-05T00:00:00Z', sample: 'boom', ...o });
  assert.equal(evaluateAll([def], { candidates: [c({})] }, ctx).length, 0);
  assert.equal(evaluateAll([def], { candidates: [c({ count: 3, sessions: 2 })] }, ctx).length, 1);
});

test('metric sessions / sum:cost_ms', () => {
  const evs = [ev({ sid: 'a', duration_ms: 400 }), ev({ sid: 'b', duration_ms: 700 })];
  assert.equal(evaluate({ id: 't', source: 'audit', filter: {}, metric: 'sessions', threshold: 2, action: 'log' }, { events: evs }, ctx).length, 1);
  assert.equal(evaluate({ id: 't', source: 'audit', filter: {}, metric: 'sum:cost_ms', threshold: 1000, action: 'log' }, { events: evs }, ctx)[0].value, 1100);
  assert.equal(evaluate({ id: 't', source: 'audit', filter: {}, metric: 'sum:cost_ms', threshold: 1200, action: 'log' }, { events: evs }, ctx).length, 0);
});

test('matchFilter: bang, thuoc danh sach', () => {
  const get = (k) => ({ a: 'x', n: 5 })[k];
  assert.ok(matchFilter(get, { a: ['x', 'y'] }));
  assert.ok(!matchFilter(get, { a: ['y'] }));
});

test('validateDef bat loi', () => {
  assert.ok(validateDef({ source: 'nope', action: 'warn', threshold: 1 }).length);
  assert.deepEqual(validateDef({ source: 'audit', action: 'warn', threshold: 1 }), []);
});

test('ghi de theo thu muc du an: cung ten thay, ten moi them, enabled:false tat; khong registry', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'));
  const dir = path.join(proj, '.harness', 'rules'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'repeated-error.json'), JSON.stringify({ source: 'candidates', filter: { kind: 'error' }, threshold: 2, action: 'warn', message: 'x {count}' }));
  fs.writeFileSync(path.join(dir, 'main-self-edit.json'), JSON.stringify({ enabled: false }));
  fs.writeFileSync(path.join(dir, 'custom.json'), JSON.stringify({ source: 'audit', filter: {}, threshold: 1, action: 'report' }));
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ khong phai json');
  const r = loadDefinitions({ projectDir: proj, trusted: () => true });
  const by = Object.fromEntries(r.defs.map((d) => [d.id, d]));
  assert.equal(by['repeated-error'].threshold, 2); assert.equal(by['repeated-error'].origin, 'project');
  assert.ok(by['main-self-edit']); assert.ok(by.custom); assert.ok(by['main-self-verify']);
  assert.equal(r.errors.length, 2); // bad.json + enabled:false cua luat protected bi bo qua
  fs.rmSync(proj, { recursive: true, force: true });
});

test('timeout nap dinh nghia -> truncated', () => {
  assert.equal(loadDefinitions({ timeoutMs: -1 }).truncated, 'timeout');
});

test('luat protected: propose-fix protected; ghi de chi doi message/cooldown(>=)/siet nguong; doi filter/source/action/noi long -> bo + errors', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-prot-'));
  const dir = path.join(proj, '.harness', 'rules'); fs.mkdirSync(dir, { recursive: true });
  const base = loadDefinitions({ evolveDir: null }).defs.find((d) => d.id === 'propose-fix');
  assert.equal(base.protected, true);
  const put = (n, o) => fs.writeFileSync(path.join(dir, n), JSON.stringify(o));
  const run = () => { const r = loadDefinitions({ projectDir: proj, trusted: () => true, evolveDir: null }); return { d: r.defs.find((x) => x.id === 'propose-fix'), errors: r.errors }; };
  // hop le: doi message + cooldown lon hon + siet nguong; giu protected
  put('propose-fix.json', { message: 'moi {count}', cooldown_hours: 200, threshold: 5 });
  let r = run();
  assert.equal(r.d.message, 'moi {count}'); assert.equal(r.d.cooldown_hours, 200); assert.equal(r.d.threshold, 5); assert.equal(r.d.protected, true); assert.equal(r.d.action, 'propose'); assert.equal(r.errors.length, 0);
  // vi pham: moi cai bo override, giu mac dinh, ghi errors
  for (const bad of [{ threshold: 11 }, { cooldown_hours: 1 }, { filter: { kind: 'x' } }, { source: 'audit' }, { action: 'log' }, { protected: false }]) {
    put('propose-fix.json', { ...bad, message: 'x' });
    r = run();
    assert.equal(r.d.threshold, base.threshold, JSON.stringify(bad)); assert.equal(r.d.action, 'propose'); assert.deepEqual(r.d.filter, base.filter); assert.notEqual(r.d.message, 'x');
    assert.equal(r.errors.length, 1, JSON.stringify(bad));
  }
  fs.rmSync(proj, { recursive: true, force: true });
});
