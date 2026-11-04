// model-policy: dien model thieu theo vai tro, opus ngoai chinh sach -> ask, model re/hop le -> cho qua, config hong -> fail-open; chay hook that qua stdin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadModelPolicy, decideModel, roleOf, DEFAULTS } from './hook.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, 'hook.mjs');
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-cfg-'));
// Bang role = du lieu o config/models; test dung config tam (HARNESS_CONFIG_DIR / configDir), khong chep bang role trong hook.config.json.
const FIXTURE = { roles: {
  builder: { model: 'sonnet', effort: 'medium', allowOpus: false }, verifier: { model: 'haiku', effort: 'low', allowOpus: false },
  scout: { model: 'haiku', effort: 'low', allowOpus: false }, planner: { model: 'opus', effort: 'high', allowOpus: true },
  reviewer: { model: 'sonnet', effort: 'high', allowOpus: false }, 'general-purpose': { model: 'sonnet', effort: 'medium', allowOpus: false } },
  default: { model: 'sonnet', effort: 'medium' }, opusAllowed: [] };
const mkCfgDir = (obj, prefix = 'mp-cfgx-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); fs.mkdirSync(path.join(d, 'models')); fs.writeFileSync(path.join(d, 'models', 'default.json'), typeof obj === 'string' ? obj : JSON.stringify(obj)); return d; };
const FIX = mkCfgDir(FIXTURE);
const CFG = loadModelPolicy({ configDir: FIX }).config;
const call = (ti, extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: 'mp', tool_name: 'Agent', tool_input: ti, ...extra });
const dec = (ti, cfg = CFG) => decideModel(call(ti), cfg);
const hso = (d) => d.out.hookSpecificOutput;

test('thieu model: builder -> sonnet, updatedInput giu du truong', () => {
  const ti = { prompt: 'p', description: 'd', subagent_type: 'builder', effort: 'high' };
  const d = dec(ti); const h = hso(d);
  assert.equal(h.hookEventName, 'PreToolUse'); assert.equal(h.permissionDecision, 'allow');
  assert.deepEqual(h.updatedInput, { prompt: 'p', description: 'd', subagent_type: 'builder', effort: 'high', model: 'sonnet' });
  assert.equal(d.ev.rule, 'model-filled'); assert.equal(d.ev.kind, 'gate'); assert.equal(d.ev.decision, 'allow');
  assert.deepEqual(ti, { prompt: 'p', description: 'd', subagent_type: 'builder', effort: 'high' }); // khong sua dau vao
});
test('thieu model: verifier -> haiku; vai tro la/khong subagent_type -> default sonnet', () => {
  assert.equal(hso(dec({ prompt: 'p', description: 'd', subagent_type: 'verifier' })).updatedInput.model, 'haiku');
  assert.equal(hso(dec({ prompt: 'p', description: 'd', subagent_type: 'zzz-unknown' })).updatedInput.model, 'sonnet');
  assert.equal(hso(dec({ prompt: 'p', description: 'd' })).updatedInput.model, 'sonnet');
  assert.equal(hso(dec({ prompt: 'p', model: '  ' , subagent_type: 'scout' })).updatedInput.model, 'haiku');
});
test('opus cho vai tro khong allowOpus -> ask kem ly do', () => {
  const d = dec({ prompt: 'p', description: 'd', subagent_type: 'general-purpose', model: 'opus' });
  assert.equal(hso(d).permissionDecision, 'ask'); assert.match(hso(d).permissionDecisionReason, /general-purpose.*sonnet/);
  assert.equal(hso(d).updatedInput, undefined); assert.equal(d.ev.decision, 'ask');
  assert.equal(hso(dec({ prompt: 'p', subagent_type: 'builder', model: 'OPUS' })).permissionDecision, 'ask');
});
test('khong co config/models -> fallback an toan: default sonnet, khong role nao allowOpus', () => {
  const c = loadModelPolicy({ configDir: EMPTY }).config;
  assert.deepEqual(c.roles, {}); assert.deepEqual(c.opusAllowed, []);
  assert.equal(roleOf('planner', c).model, 'sonnet'); assert.equal(roleOf('planner', c).allowOpus, false);
  assert.equal(hso(dec({ prompt: 'p', subagent_type: 'verifier' }, c)).updatedInput.model, 'sonnet');
  assert.equal(hso(dec({ prompt: 'p', subagent_type: 'planner', model: 'opus' }, c)).permissionDecision, 'ask');
});
test('opusAllowed + allowOpus lay tu config/models (khong tu hook.config.json)', () => {
  const d = mkCfgDir({ roles: { reviewer: { model: 'sonnet', allowOpus: true }, fixer: { model: 'sonnet' }, builder: { model: 'sonnet' } }, opusAllowed: ['fixer'] });
  const c = loadModelPolicy({ configDir: d }).config;
  assert.equal(roleOf('reviewer', c).allowOpus, true); assert.equal(roleOf('fixer', c).allowOpus, true); assert.equal(roleOf('builder', c).allowOpus, false);
  assert.deepEqual(dec({ prompt: 'p', subagent_type: 'fixer', model: 'opus' }, c).out, {});
  assert.equal(hso(dec({ prompt: 'p', subagent_type: 'builder', model: 'opus' }, c)).permissionDecision, 'ask');
});
test('config hub that (config/models/default.json): planner opus, reviewer allowOpus, co fixer', () => {
  // hub: doc config/models/default.json that; plugin repo khong ship file do -> dung fixture mirror (planner opus, reviewer allowOpus, fixer, opusAllowed)
  const real = fs.existsSync(path.join(HERE, '..', '..', '..', 'config', 'models', 'default.json'));
  const c = loadModelPolicy(real ? {} : { configDir: mkCfgDir({ roles: { fixer: { model: 'sonnet', allowOpus: false }, reviewer: { model: 'sonnet', allowOpus: true }, planner: { model: 'opus', allowOpus: true } }, default: { model: 'sonnet', effort: 'medium' }, opusAllowed: ['planner', 'reviewer'] }) }).config;
  assert.equal(roleOf('planner', c).model, 'opus'); assert.equal(roleOf('reviewer', c).allowOpus, true);
  assert.ok(c.roles.fixer); assert.ok(c.opusAllowed.length > 0);
});
test('opus cho planner (allowOpus) / opusAllowed -> cho qua', () => {
  assert.deepEqual(dec({ prompt: 'p', subagent_type: 'planner', model: 'opus' }).out, {});
  const cfg = { ...CFG, opusAllowed: ['reviewer'] };
  assert.deepEqual(dec({ prompt: 'p', subagent_type: 'reviewer', model: 'opus' }, cfg).out, {});
});
test('model re/khac hop le -> cho qua, khong ghi vet (logAllow false)', () => {
  for (const [t, m] of [['builder', 'haiku'], ['verifier', 'sonnet'], ['builder', 'fable'], ['scout', 'haiku']]) {
    const d = dec({ prompt: 'p', subagent_type: t, model: m }); assert.deepEqual(d.out, {}); assert.equal(d.ev, null);
  }
  assert.equal(dec({ prompt: 'p', subagent_type: 'builder', model: 'haiku' }, { ...CFG, logAllow: true }).ev.rule, 'model-pass');
});
test('khong phai Agent / dau vao la -> {}', () => {
  assert.deepEqual(decideModel({ tool_name: 'Bash', tool_input: { command: 'ls' } }, CFG).out, {});
  assert.deepEqual(decideModel(null, CFG).out, {}); assert.deepEqual(decideModel({ tool_name: 'Agent' }, CFG).out, {});
});
test('mode audit: khong can thiep, chi ghi would-*', () => {
  const cfg = { ...CFG, mode: 'audit' };
  const a = dec({ prompt: 'p', subagent_type: 'builder' }, cfg); assert.deepEqual(a.out, {}); assert.match(a.ev.reason, /^would-fill/);
  const b = dec({ prompt: 'p', subagent_type: 'builder', model: 'opus' }, cfg); assert.deepEqual(b.out, {}); assert.match(b.ev.reason, /^would-ask/);
});
test('config hub ghi de mac dinh; roles hong khong lam hong', () => {
  const dir = mkCfgDir({ roles: { builder: { model: 'haiku' }, verifier: { model: 'haiku' } }, default: { model: 'opus' } }, 'mp-cfg2-');
  const c = loadModelPolicy({ configDir: dir }).config;
  assert.equal(roleOf('builder', c).model, 'haiku'); assert.equal(roleOf('verifier', c).model, 'haiku');
  assert.equal(roleOf('zzz', c).model, 'opus'); assert.equal(roleOf('zzz', c).allowOpus, true);
  assert.equal(roleOf('builder', { ...DEFAULTS, roles: { builder: 'x' }, opusAllowed: [] }).model, 'sonnet');
  const bad = loadModelPolicy({ file: path.join(dir, 'missing.json'), configDir: dir }).config; assert.ok(bad.roles);
});

function run(inp, env = {}) {
  const dir = env.CLAUDE_AUDIT_DIR;
  const r = spawnSync(process.execPath, [HOOK], { input: typeof inp === 'string' ? inp : JSON.stringify(inp), env: { ...process.env, CLAUDE_AUDIT_DIR: dir, HARNESS_CONFIG_DIR: env.HARNESS_CONFIG_DIR || FIX }, encoding: 'utf8', timeout: 10000 });
  return r;
}
test('hook that: stdin -> stdout + ghi audit type=gate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-audit-'));
  const env = { CLAUDE_AUDIT_DIR: dir };
  const a = run(call({ prompt: 'p', description: 'd', subagent_type: 'builder' }), env);
  assert.equal(a.status, 0); const h = JSON.parse(a.stdout).hookSpecificOutput;
  assert.equal(h.permissionDecision, 'allow'); assert.equal(h.updatedInput.model, 'sonnet'); assert.equal(h.updatedInput.prompt, 'p');
  assert.equal(JSON.parse(run(call({ prompt: 'p', subagent_type: 'general-purpose', model: 'opus' }), env).stdout).hookSpecificOutput.permissionDecision, 'ask');
  assert.deepEqual(JSON.parse(run(call({ prompt: 'p', subagent_type: 'planner', model: 'opus' }), env).stdout), {});
  assert.deepEqual(JSON.parse(run(call({ prompt: 'p', subagent_type: 'builder', model: 'haiku' }), env).stdout), {});
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => /type=gate.*\.jsonl$/.test(String(f).replace(/\\/g, '/')));
  assert.ok(files.length >= 1);
  const lines = files.flatMap((f) => fs.readFileSync(path.join(dir, String(f)), 'utf8').trim().split('\n')).join('\n');
  assert.match(lines, /model-filled/); assert.match(lines, /opus-not-allowed/);
});
test('fail-open: stdin hong / config hong -> {} hoac mac dinh, exit 0, ghi vet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-audit2-'));
  const bad = run('{not json', { CLAUDE_AUDIT_DIR: dir }); assert.equal(bad.status, 0); assert.deepEqual(JSON.parse(bad.stdout), {});
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-cfg3-')); fs.mkdirSync(path.join(cfgDir, 'models'));
  fs.writeFileSync(path.join(cfgDir, 'models', 'default.json'), '{ broken json');
  const r = run(call({ prompt: 'p', subagent_type: 'builder' }), { CLAUDE_AUDIT_DIR: dir, HARNESS_CONFIG_DIR: cfgDir });
  assert.equal(r.status, 0); const o = JSON.parse(r.stdout);
  assert.ok(o.hookSpecificOutput ? o.hookSpecificOutput.updatedInput.model === 'sonnet' : Object.keys(o).length === 0);
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => /type=gate.*\.jsonl$/.test(String(f).replace(/\\/g, '/')));
  const txt = files.map((f) => fs.readFileSync(path.join(dir, String(f)), 'utf8')).join('\n');
  assert.match(txt, /fail-open/);
});
