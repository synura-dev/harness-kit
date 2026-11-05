// S8: guard qua core loadConfig (D3). Du an thang may; luat loi chi tat o tang may.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, evaluate } from './hook.mjs';

const CORE = [path.join(path.dirname(fileURLToPath(import.meta.url)), 'core.fixture.json')];
const mk = () => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'guardd3-')); fs.mkdirSync(path.join(h, 'config', 'guard', 'projects'), { recursive: true }); return h; };
const w = (h, rel, o) => fs.writeFileSync(path.join(h, 'config', 'guard', rel), JSON.stringify(o));
const id = (c, cmd) => evaluate(cmd, c)?.id ?? null;

test('du an (projects/<id>.json) khong tat/ghi de duoc luat loi, khong doi scalar', () => {
  const h = mk();
  w(h, 'projects/p.json', {
    mode: 'audit', maxCommandChars: 99999999, disable: ['mongo-uri'],
    denyPatterns: [{ id: 'mongo-uri', disable: true }, { id: 'mongo-cli', regex: 'zzz' }, { id: 'db-cli-remote', disable: true }, { id: 'p-rule', regex: 'pword', reason: 'x' }],
    allowlist: [{ id: 'hub-local-node', regex: 'x' }],
  });
  const r = load(CORE, { env: { GUARD_PROJECT: 'p' }, hubRoot: h });
  assert.equal(r.config.mode, 'enforce');
  assert.equal(r.config.maxCommandChars, 100000);
  assert.equal(id(r.config, 'echo mongodb://u@h/db'), 'mongo-uri');
  assert.equal(id(r.config, 'mongosh'), 'mongo-cli');
  assert.equal(id(r.config, 'ssh h "psql -c 1"'), 'db-cli-remote');
  assert.equal(evaluate('a'.repeat(100001), r.config)?.id, 'command-too-long');
  assert.equal(id(r.config, 'echo pword'), 'p-rule');
  assert.ok(r.warnings.some((x) => /mongo-uri/.test(x)) && r.warnings.some((x) => /maxCommandChars/.test(x)) && r.warnings.some((x) => /mode/.test(x)));
});

test('may (config/guard/local.json) tat duoc luat loi', () => {
  const h = mk();
  w(h, 'local.json', { denyPatterns: [{ id: 'mongo-uri', disable: true }], maxCommandChars: 50 });
  const c = load(CORE, { env: {}, hubRoot: h }).config;
  assert.equal(id(c, 'echo mongodb://u@h/db'), null);
  assert.equal(id(c, 'mongosh'), 'mongo-cli');
  assert.equal(evaluate('a'.repeat(51), c)?.id, 'command-too-long');
});

test('D3: du an thang may o luat khong loi; may tat luat du an', () => {
  const h = mk();
  w(h, 'local.json', { denyPatterns: [{ id: 'r1', regex: 'machword', reason: 'm' }, { id: 'r2', disable: true }] });
  w(h, 'projects/p.json', { denyPatterns: [{ id: 'r1', regex: 'projword', reason: 'p' }, { id: 'r2', regex: 'r2word', reason: 'p' }] });
  const c = load(CORE, { env: { GUARD_PROJECT: 'p' }, hubRoot: h }).config;
  assert.equal(id(c, 'echo projword'), 'r1');
  assert.equal(id(c, 'echo machword'), null);
  assert.equal(id(c, 'echo r2word'), null);
});

test('env khong tat duoc luat loi qua mang denyPatterns', () => {
  const h = mk();
  const c = load(CORE, { env: { HARNESS_GUARD_DENY_PATTERNS: JSON.stringify([{ id: 'mongo-uri', disable: true }]) }, hubRoot: h }).config;
  assert.equal(id(c, 'echo mongodb://u@h/db'), 'mongo-uri');
});

test('duong du an cu config/guard/<id>.json con doc duoc + canh bao legacy-config, khong lo gia tri', () => {
  const h = mk();
  w(h, 'old.json', { denyPatterns: [{ id: 'old-rule', regex: 'SECRETVALUE', reason: 'x' }], remoteHostAliases: ['SECRETHOST'] });
  const r = load(CORE, { env: { GUARD_PROJECT: 'old' }, hubRoot: h });
  assert.equal(id(r.config, 'echo SECRETVALUE'), 'old-rule');
  assert.ok(r.warnings.some((x) => /legacy-config/.test(x)));
  assert.ok(!r.warnings.some((x) => /SECRETVALUE|SECRETHOST/.test(x)));
});

// ---- Review fixes ----
const MG = 'mongo' + 'sh';
test('env HARNESS_GUARD_* / HARNESS_CONFIG_DIR khong anh huong guard', () => {
  const h = mk();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'guardother-'));
  fs.mkdirSync(path.join(other, 'guard'), { recursive: true });
  fs.writeFileSync(path.join(other, 'guard', 'local.json'), JSON.stringify({ denyPatterns: [{ id: 'mongo-uri', disable: true }] }));
  const env = {
    HARNESS_GUARD_ALLOWLIST: JSON.stringify([{ id: 'x', regex: '.' }]), HARNESS_GUARD_MODE: 'audit', HARNESS_GUARD_MAXCOMMANDCHARS: '1e9',
    HARNESS_GUARD_MAX_COMMAND_CHARS: '1000000000', HARNESS_GUARD_DENY_PATTERNS: '[]', HARNESS_CONFIG_DIR: other,
  };
  const c = load(CORE, { env, hubRoot: h }).config;
  assert.equal(c.mode, 'enforce');
  assert.equal(c.maxCommandChars, 100000);
  assert.ok(!c.allowlist.some((a) => a.id === 'x'));
  assert.equal(id(c, 'echo mongodb://u@h/db'), 'mongo-uri');
  assert.equal(id(c, MG), 'mongo-cli');
});

test('GUARD_MODE=audit env cu van hoat dong', () => {
  const c = load(CORE, { env: { GUARD_MODE: 'audit' }, hubRoot: mk() }).config;
  assert.equal(c.mode, 'audit');
});

test('allowlist du an: thieu for / for tro luat loi bi bo; for hop le giu; may giu nhu cu', () => {
  const h = mk();
  w(h, 'local.json', { allowlist: [{ id: 'm-all', regex: 'machok' }] });
  w(h, 'projects/p.json', { allowlist: [
    { id: 'a-nofor', regex: '.' },
    { id: 'a-core', regex: '.', for: ['mongo-cli'] },
    { id: 'a-mixed', regex: '.', for: ['p-rule', 'db-cli-remote'] },
    { id: 'a-ok', regex: 'okword', for: ['p-rule'] },
  ], denyPatterns: [{ id: 'p-rule', regex: 'pword' }] });
  const r = load(CORE, { env: { GUARD_PROJECT: 'p' }, hubRoot: h });
  const ids = r.config.allowlist.map((a) => a.id);
  assert.ok(ids.includes('a-ok') && ids.includes('m-all'));
  assert.ok(!ids.includes('a-nofor') && !ids.includes('a-core') && !ids.includes('a-mixed'));
  assert.equal(id(r.config, MG), 'mongo-cli');
  assert.equal(id(r.config, 'echo pword'), 'p-rule');
  assert.equal(r.warnings.filter((x) => /allowlist/.test(x)).length, 3);
});

test('local.json/guard.local.json khong nap hai lan, khong canh bao legacy gia', () => {
  const h = mk();
  w(h, 'local.json', { denyPatterns: [{ id: 'l1', regex: 'lword' }] });
  const r = load([CORE[0], path.join(h, 'config', 'guard', 'local.json')], { env: {}, hubRoot: h });
  assert.equal(r.config.denyPatterns.filter((x) => x.id === 'l1').length, 1);
  assert.ok(!r.warnings.some((x) => /legacy/.test(x)), r.warnings.join('|'));
  const r2 = load(CORE, { env: {}, hubRoot: h });
  assert.equal(r2.config.denyPatterns.filter((x) => x.id === 'l1').length, 1);
  assert.ok(!r2.warnings.some((x) => /legacy/.test(x)));
});

test('hook.config.json hong/thieu: khong nem loi, luat cung van chay', () => {
  const h = mk();
  const bad = path.join(h, 'bad.json'); fs.writeFileSync(bad, '{oops');
  for (const f of [bad, path.join(h, 'missing.json')]) {
    const r = load([f], { env: {}, hubRoot: h });
    assert.doesNotThrow(() => load([f], { env: {}, hubRoot: h }));
    assert.equal(id(r.config, 'echo hello'), null);
    assert.equal(evaluate('a'.repeat(100001), r.config)?.id, 'command-too-long');
  }
});
