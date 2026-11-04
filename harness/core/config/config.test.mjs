import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.mjs';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
const w = (d, rel, t) => { const f = path.join(d, 'config', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof t === 'string' ? t : JSON.stringify(t)); };
const L = (d, o) => loadConfig('x', { root: d, repoDir: d, env: {}, ...o }); // repoDir=d (khong co plugin.json) -> ep hub mode
const defaults = { a: { b: 1, c: 1 }, n: 1, rules: [{ id: 'core1', on: true }, { id: 'opt' }] };
const protect = { rules: { ids: 'all-from-code' } };

test('thu tu tang code<default<machine<project<env<flag + sources', () => {
  const d = mk();
  w(d, 'x/default.json', { n: 2 });
  w(d, 'x/local.json', { a: { b: 3 }, n: 3 });
  w(d, 'x/projects/p.json', { a: { b: 4 } });
  const r = L(d, { project: 'p', defaults, env: { HARNESS_X_A_C: '7' }, flags: { n: 9 } });
  assert.deepEqual([r.config.a.b, r.config.a.c, r.config.n], [4, 7, 9]);
  assert.equal(r.sources['a.b'], 'project:p');
  assert.equal(r.sources['a.c'], 'env:HARNESS_X_A_C');
  assert.equal(r.sources.n, 'flag');
  assert.deepEqual(r.warnings, []);
});

test('project thang machine (D3), machine thang default', () => {
  const d = mk();
  w(d, 'x/default.json', { n: 2 });
  w(d, 'x/local.json', { n: 3 });
  assert.equal(L(d, { defaults }).config.n, 3);
  w(d, 'x/projects/p.json', { n: 5 });
  assert.equal(L(d, { defaults, project: 'p' }).config.n, 5);
});

test('luat loi: tat duoc o machine, khong tat o project/flag', () => {
  const d = mk();
  w(d, 'x/local.json', { rules: [{ id: 'core1', disable: true }] });
  assert.deepEqual(L(d, { defaults, protect }).config.rules.map((e) => e.id), ['opt']);
  const d2 = mk();
  w(d2, 'x/projects/p.json', { rules: [{ id: 'core1', disable: true }, { id: 'opt', disable: true }, { id: 'new' }] });
  const r = L(d2, { defaults, protect, project: 'p', flags: { rules: [{ id: 'core1', on: false }] } });
  assert.deepEqual(r.config.rules.map((e) => e.id), ['core1', 'opt', 'new']);
  assert.equal(r.config.rules[0].on, true);
  assert.equal(r.warnings.filter((x) => /duoc bao ve/.test(x)).length, 3);
});

test('project mang rong khong xoa luat loi; mang khong id bi bo; disable truthy o machine', () => {
  const d = mk();
  w(d, 'x/projects/p.json', { rules: [] });
  assert.equal(L(d, { defaults, protect, project: 'p' }).config.rules.length, 2);
  w(d, 'x/projects/p.json', { rules: ['a', 'b'] });
  const r = L(d, { defaults, protect, project: 'p' });
  assert.equal(r.config.rules.length, 2);
  assert.ok(r.warnings.some((m) => /khong id/.test(m)));
  w(d, 'x/local.json', { rules: [{ id: 'core1', disable: 1 }] });
  assert.deepEqual(L(d, { defaults, protect }).config.rules.map((e) => e.id), ['opt']);
});

test('disable mang chi o machine', () => {
  const d = mk();
  w(d, 'x/projects/p.json', { disable: ['r1'] });
  const r = L(d, { defaults: { disable: [] }, project: 'p' });
  assert.deepEqual(r.config.disable, []);
  assert.ok(r.warnings.some((x) => /^disable:/.test(x)));
  w(d, 'x/local.json', { disable: ['r1'] });
  assert.deepEqual(L(d, { defaults: { disable: [] } }).config.disable, ['r1']);
});

test('legacy: config/<tool>.local.json va <tool>/*.local.json + canh bao', () => {
  const d = mk();
  w(d, 'x.local.json', { n: 8 });
  const r = L(d, { defaults });
  assert.equal(r.config.n, 8);
  assert.equal(r.sources.n, 'machine');
  assert.ok(r.warnings.some((x) => x.startsWith('legacy-config:')));
  const d2 = mk();
  w(d2, 'x/guard.local.json', { n: 6 });
  const r2 = L(d2, { defaults });
  assert.equal(r2.config.n, 6);
  assert.ok(r2.warnings.some((x) => x.startsWith('legacy-config:')));
  // local.json moi thang legacy
  w(d, 'x/local.json', { n: 1 });
  assert.equal(L(d, { defaults }).config.n, 1);
});

test('alias env cu + canh bao, env moi thang alias', () => {
  const d = mk();
  const r = L(d, { defaults, envAliases: { OLD_N: 'n' }, env: { OLD_N: '5' } });
  assert.equal(r.config.n, 5);
  assert.ok(r.warnings.some((x) => x.startsWith('legacy-env:')));
  assert.equal(L(d, { defaults, envAliases: { OLD_N: 'n' }, env: { OLD_N: '5', HARNESS_X_N: '6' } }).config.n, 6);
});

test('thieu file/thu muc, JSON hong, khong object: khong throw', () => {
  const d = mk();
  assert.deepEqual(L(d, { defaults }).config, defaults);
  w(d, 'x/local.json', '{bad');
  w(d, 'x/projects/p.json', '[1]');
  const r = L(d, { defaults, project: 'p' });
  assert.deepEqual(r.config, defaults);
  assert.equal(r.warnings.length, 2);
});

test('tool/project ten xau + __proto__', () => {
  const d = mk();
  assert.ok(loadConfig('../x', { root: d, env: {}, defaults }).warnings.length);
  assert.ok(L(d, { defaults, project: '../p' }).warnings.some((x) => /project/.test(x)));
  w(d, 'x/local.json', '{"__proto__":{"pwn":1},"n":2}');
  const r = L(d, { defaults });
  assert.equal(({}).pwn, undefined);
  assert.equal(r.config.n, 2);
});

test('warnings khong chua gia tri nhay cam', () => {
  const d = mk();
  w(d, 'x/local.json', '{"secret":"SUPERSECRET"');
  w(d, 'x/projects/p.json', { disable: ['SUPERSECRET'], rules: [{ id: 'core1', disable: true }] });
  const r = L(d, { defaults: { ...defaults, disable: [] }, protect, project: 'p', envAliases: { OLD: 'k' }, env: { OLD: 'SUPERSECRET' } });
  assert.ok(r.warnings.length >= 2);
  assert.ok(!JSON.stringify(r.warnings).includes('SUPERSECRET'));
});

test('file qua lon bi bo', () => {
  const d = mk();
  w(d, 'x/local.json', { n: 2 });
  const r = L(d, { defaults, maxBytes: 3 });
  assert.equal(r.config.n, 1);
  assert.equal(r.warnings.length, 1);
});

test('loadConfig: ten trung tinh workspace doc config/hub (alias 2 chieu)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgalias-'));
  fs.mkdirSync(path.join(d, 'config', 'hub'), { recursive: true });
  fs.writeFileSync(path.join(d, 'config', 'hub', 'default.json'), JSON.stringify({ a: 1 }));
  assert.equal(loadConfig('workspace', { root: d, repoDir: d, env: {} }).config.a, 1);
  fs.mkdirSync(path.join(d, 'config', 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(d, 'config', 'workspace', 'default.json'), JSON.stringify({ a: 2 }));
  assert.equal(loadConfig('workspace', { root: d, repoDir: d, env: {} }).config.a, 2);
  assert.equal(loadConfig('hub', { root: d, repoDir: d, env: {} }).config.a, 1);
});
