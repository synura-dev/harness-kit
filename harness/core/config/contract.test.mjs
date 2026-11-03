import { test, expect } from 'bun:test';
import fs from 'node:fs';
import * as c from './contract.mjs';

const good = { id: 'state', kind: 'cli', layer: 'ext', entry: 'state.mjs', domain: 'state', default: 'run',
  files: { helpers: ['x.mjs'] }, tests: ['state.test.mjs'], config: { defaults: null, schema: null }, data: null, tier: 'T1' };

test('caps khop bang muc 2', () => {
  expect(c.CAPS.filesPerExtension).toBe(12);
  expect(c.CAPS.linesPerFile).toBe(500);
  expect(c.CAPS.retention).toEqual({ eventsDays: 30, digestsDays: 90, runsDays: 14, baselinesKeep: 10 });
  expect(c.LAYERS).toEqual(['core', 'ext']);
  expect(Object.isFrozen(c.CAPS)).toBe(true);
});

test('resolveCaps ghi de hop le, bo gia tri sai', () => {
  const r = c.resolveCaps({ linesPerFile: 300, filesPerExtension: -1, retention: { runsDays: 7, eventsDays: 'x' }, zzz: 1 });
  expect(r.linesPerFile).toBe(300);
  expect(r.filesPerExtension).toBe(12);
  expect(r.retention.runsDays).toBe(7);
  expect(r.retention.eventsDays).toBe(30);
  expect(c.CAPS.linesPerFile).toBe(500);
});

test('validateExtManifest', () => {
  expect(c.validateExtManifest(good)).toEqual([]);
  expect(c.validateExtManifest(null).length).toBe(1);
  expect(c.validateExtManifest({}).length).toBeGreaterThan(3);
  expect(c.validateExtManifest({ ...good, kind: 'x' }).join()).toContain('kind');
  expect(c.validateExtManifest({ ...good, domain: undefined }).join()).toContain('domain');
  expect(c.validateExtManifest({ ...good, kind: 'lib', tests: [] }).join()).toContain('test');
  expect(c.validateExtManifest({ ...good, id: 'Bad_Id' }).join()).toContain('kebab');
  expect(c.validateExtManifest({ ...good, files: { helpers: ['state.mjs'] } }).join()).toContain('trung');
  const many = Array.from({ length: 13 }, (_, i) => `h${i}.mjs`);
  expect(c.validateExtManifest({ ...good, files: { helpers: many } }).join()).toContain('12');
});

test('validateEvent', () => {
  expect(c.validateEvent({ ts: '2026-10-28T00:00:00Z', type: 'tool', tokens_in: 5, files: ['a'] })).toEqual([]);
  expect(c.validateEvent({ type: 'x' }).length).toBe(1);
  expect(c.validateEvent({ ts: 1, type: 'x', prompt: 'p' }).join()).toContain('prompt');
  expect(c.validateEvent({ ts: 1, type: 'x', verdict: 'maybe' }).length).toBe(1);
  expect(c.validateEvent({ ts: 1, type: 'x', newfield: 1 })).toEqual([]);
});

test('validateConfig va luat loi chi tat o tang may', () => {
  expect(c.validateConfig({ caps: { linesPerFile: 400 } }, 'project').errors).toEqual([]);
  expect(c.validateConfig({ caps: { linesPerFile: 'a' } }).errors.length).toBe(1);
  expect(c.validateConfig({ foo: 1 }).warnings.length).toBe(1);
  expect(c.validateConfig({ disable: ['r'] }, 'project').errors.length).toBe(1);
  expect(c.validateConfig({ disable: ['r'] }, 'machine').errors).toEqual([]);
  expect(c.canDisableCoreRule('machine')).toBe(true);
  expect(c.canDisableCoreRule('project')).toBe(false);
  expect(c.CONFIG_LAYERS).toEqual(['code', 'machine', 'project', 'env', 'flag']);
});

test('checkImport theo IMPORT_RULES', () => {
  expect(c.checkImport('harness/core/a.mjs', 'harness/core/b.mjs')).toBe('');
  expect(c.checkImport('harness/core/playbook.mjs', 'harness/cli/dispatch-worker.mjs')).not.toBe('');
  expect(c.checkImport('harness/core/agents.mjs', 'harness/tools/adapters/_util.mjs')).not.toBe('');
  expect(c.checkImport('harness/cli/doctor.mjs', 'harness/core/out.mjs')).toBe('');
  expect(c.checkImport('harness/cli/dispatch-worker.mjs', 'harness/observe/agy-local/agy-local.mjs')).not.toBe('');
  expect(c.checkImport('harness/hooks/g1/hook.mjs', 'harness/hooks/_shared/config.mjs')).toBe('');
  expect(c.checkImport('harness/hooks/g1/hook.mjs', 'harness/hooks/g2/audit.mjs')).not.toBe('');
  expect(c.checkImport('harness/hooks/g1/hook.mjs', 'harness/hooks/g1/x.mjs')).toBe('');
  expect(c.checkImport('harness/observe/a/a.mjs', 'harness/observe/b/b.mjs')).not.toBe('');
  expect(c.checkImport('harness/observe/a/a.mjs', 'harness/core/out.mjs')).toBe('');
  expect(c.zoneOf('docs/x.md')).toBe(null);
});

test('checkImport: chinh sach test (thap hon/cung bac OK, core test van bi chan)', () => {
  expect(c.checkImport('harness/hooks/_shared/a.test.mjs', 'harness/hooks/g1/hook.mjs')).toBe('');
  expect(c.checkImport('harness/observe/a/a.test.mjs', 'harness/observe/b/b.mjs')).toBe('');
  expect(c.checkImport('harness/cli/a.test.mjs', 'harness/core/x.mjs')).toBe('');
  expect(c.checkImport('harness/cli/a.test.mjs', 'harness/observe/a/a.mjs')).not.toBe('');
  expect(c.checkImport('harness/core/a.test.mjs', 'harness/cli/x.mjs')).not.toBe('');
  expect(c.checkImport('harness/core/a.test.mjs', 'harness/observe/a/a.mjs')).not.toBe('');
  expect(c.checkImport('harness/hooks/g/hook.mjs', 'harness/hooks/g2/audit.mjs')).not.toBe('');
  expect(c.checkImport('harness/tests/a.test.mjs', 'harness/observe/a/a.mjs')).toBe('');
  expect(c.checkImport('harness/observe/a/a.mjs', 'harness/tests/x.mjs')).not.toBe('');
});

test('contract.mjs khong import cli/plugins/hooks/tools', () => {
  const src = fs.readFileSync(new URL('./contract.mjs', import.meta.url), 'utf8');
  expect(/^\s*import\s/m.test(src)).toBe(false);
  expect(/from\s+['"][^'"]*\/(cli|plugins|hooks|tools)\//.test(src)).toBe(false);
});

test('S0: thu tu D3, duong dan, env, chu ky, manifest.config.tool', () => {
  expect(c.CONFIG_LAYERS).toEqual(['code', 'machine', 'project', 'env', 'flag']);
  expect(c.configPath('machine', 'guard')).toBe('config/guard/local.json');
  expect(c.configPath('project', 'guard', 'x')).toBe('config/guard/projects/x.json');
  expect(c.configPath('nope', 'a')).toBe('');
  expect(c.CONFIG_PATHS.default).toBe('config/{tool}/default.json');
  expect(c.envName('audit', 'maxMB')).toBe('HARNESS_AUDIT_MAX_MB');
  expect(c.LEGACY_WARNING).toBe('legacy-config');
  expect(c.LOAD_CONFIG_SIGNATURE.returns).toEqual(['config', 'sources', 'warnings']);
  const m = { id: 'a', kind: 'hook', layer: 'ext', entry: 'a.mjs', config: { defaults: null, schema: null, tool: 'a' } };
  expect(c.validateExtManifest(m)).toEqual([]);
  expect(c.validateExtManifest({ ...m, config: { tool: 1 } }).length).toBe(1);
});

test('vung nhom moi: TOP_DIRS + import chi core/cung nhom; skills/config khong import duoc', () => {
  for (const z of ['observe', 'constrain', 'evolve', 'build', 'skills', 'config']) expect(c.TOP_DIRS).toContain(z);
  expect(c.GROUP_ZONES).toEqual(['observe', 'constrain', 'evolve', 'build']);
  expect(c.zoneOf('harness/observe/evidence/cli.mjs')).toEqual({ zone: 'observe', group: 'evidence', sub: null });
  expect(c.checkImport('harness/observe/evidence/cli.mjs', 'harness/core/io/out.mjs')).toBe('');
  expect(c.checkImport('harness/observe/evidence/cli.mjs', 'harness/observe/evidence/evidence.mjs')).toBe('');
  expect(c.checkImport('harness/observe/evidence/cli.mjs', 'harness/observe/digest/x.mjs')).not.toBe('');
  expect(c.checkImport('harness/constrain/gate/a.mjs', 'harness/observe/evidence/x.mjs')).not.toBe('');
  expect(c.checkImport('harness/evolve/loop/a.mjs', 'harness/observe/tasks/tasks.mjs')).not.toBe('');
  expect(c.checkImport('harness/build/skills/a.mjs', 'harness/skills/x/x.mjs')).not.toBe('');
  expect(c.checkImport('harness/evolve/x/a.mjs', 'harness/cli/harness.mjs')).not.toBe('');
  expect(c.checkImport('harness/core/a.mjs', 'harness/observe/evidence/x.mjs')).not.toBe('');
  expect(c.checkImport('harness/tests/a.test.mjs', 'harness/build/skills/a.mjs')).toBe('');
  expect(c.checkImport('harness/observe/evidence/a.test.mjs', 'harness/cli/x.mjs')).toBe('');
});

test('zoneOf hieu thu muc con: core/cli/tools gom moi thu muc con, sub = thu muc cap 1', () => {
  expect(c.zoneOf('harness/core/io/paths.mjs')).toEqual({ zone: 'core', group: null, sub: 'io' });
  expect(c.zoneOf('harness/core/x.mjs')).toEqual({ zone: 'core', group: null, sub: null });
  expect(c.zoneOf('harness/cli/commands/doctor.mjs')).toEqual({ zone: 'cli', group: null, sub: 'commands' });
  expect(c.zoneOf('harness/hooks/g1/hook.mjs')).toEqual({ zone: 'hooks', group: 'g1', sub: null });
  expect(c.checkImport('harness/core/audit/a.mjs', 'harness/core/io/paths.mjs')).toBe('');
  expect(c.checkImport('harness/core/io/a.mjs', 'harness/cli/commands/doctor.mjs')).not.toBe('');
  expect(c.checkImport('harness/cli/commands/doctor.mjs', 'harness/core/io/out.mjs')).toBe('');
  expect(c.checkImport('harness/hooks/g1/hook.mjs', 'harness/core/config/config.mjs')).toBe('');
});

test('flatMax: tran phang mac dinh 8, ghi de duoc qua resolveCaps', () => {
  expect(c.DEFAULT_CAPS.flatMax).toBe(8);
  expect(c.resolveCaps({ flatMax: 5 }).flatMax).toBe(5);
  expect(c.resolveCaps({ flatMax: -1 }).flatMax).toBe(8);
  expect(c.SEVERITY.flatMax).toBe('warn');
});

test('5.0: hooks (composition root) import duoc observe/constrain; vung nhom van khong import hooks', () => {
  for (const z of ['observe', 'constrain']) expect(c.IMPORT_RULES.hooks).toContain(z);
  expect(c.checkImport('harness/hooks/dispatch/modules.mjs', 'harness/constrain/guard/hook.mjs')).toBe('');
  expect(c.checkImport('harness/hooks/dispatch/modules.mjs', 'harness/observe/audit/audit.mjs')).toBe('');
  expect(c.checkImport('harness/hooks/dispatch/modules.mjs', 'harness/build/user-shim/hook.mjs')).toBe('');
  expect(c.checkImport('harness/hooks/dispatch/modules.mjs', 'harness/evolve/loop/loop.mjs')).not.toBe('');
  expect(c.checkImport('harness/constrain/guard/hook.mjs', 'harness/hooks/dispatch/run.mjs')).not.toBe('');
  expect(c.checkImport('harness/observe/audit/audit.mjs', 'harness/hooks/_shared/config.mjs')).not.toBe('');
});

test('5.0: harness/** khong import ra ngoai harness/ (chan harness -> hub)', () => {
  expect(c.checkImport('harness/core/a.mjs', 'hub/projects/x.mjs')).toContain('ngoai harness');
  expect(c.checkImport('harness/cli/commands/doctor.mjs', 'package.json')).not.toBe('');
  expect(c.checkImport('harness/tests/a.test.mjs', 'hub/x.mjs')).not.toBe('');
  expect(c.checkImport('harness/core/a.mjs', 'harness/core/b.mjs')).toBe('');
  expect(c.checkImport('hub/projects/x.mjs', 'harness/core/config/config.mjs')).toBe(''); // hub -> harness mot chieu: OK
  expect(c.isInHarness('harness/core/a.mjs')).toBe(true);
  expect(c.isInHarness('./harness/core/a.mjs')).toBe(true);
  expect(c.isInHarness('hub/harness/a.mjs')).toBe(false);
  expect(c.isInHarness('')).toBe(false);
});

test('5.0: DECISION_ORDER va strongestDecision (deny > ask > allow)', () => {
  expect(c.DECISION_ORDER).toEqual(['deny', 'ask', 'allow']);
  expect(c.strongestDecision(['allow', 'ask'])).toBe('ask');
  expect(c.strongestDecision(['allow', 'deny', 'ask'])).toBe('deny');
  expect(c.strongestDecision([undefined, 'x'])).toBe(undefined);
  expect(c.strongestDecision(null)).toBe(undefined);
});

test('5.1: records (sink gate|audit|guard|worktree) trong ket qua handle; DUP_ALLOW co handle', () => {
  expect(c.validateHookResult({ records: [{ sink: 'gate', data: { kind: 'gate' } }, { sink: 'audit', data: {}, opts: {} }] })).toEqual([]);
  expect(c.validateHookResult({ records: 'x' }).join()).toContain('records');
  expect(c.validateHookResult({ records: [{ sink: 'zzz', data: {} }, { sink: 'gate' }, 1] }).length).toBe(3);
  expect(c.HOOK_MODULE.sinks).toEqual(['gate', 'audit', 'guard', 'worktree']);
  expect(c.DUP_ALLOW.find((x) => x.name === 'handle').files.length).toBe(10);
});

test('5.0: HOOK_MODULE hop dong module + ket qua', () => {
  const m = { id: 'guard', events: ['PreToolUse'], timeoutMs: 500, onError: 'open', handle: () => ({}) };
  expect(c.validateHookModule(m)).toEqual([]);
  expect(c.validateHookModule({ ...m, tools: /^Bash$/ })).toEqual([]);
  expect(c.validateHookModule(null).length).toBe(1);
  expect(c.validateHookModule({}).length).toBe(c.HOOK_MODULE.required.length);
  expect(c.validateHookModule({ ...m, id: 'Bad_Id' }).join()).toContain('kebab');
  expect(c.validateHookModule({ ...m, events: [] }).join()).toContain('events');
  expect(c.validateHookModule({ ...m, tools: 'Bash' }).join()).toContain('tools');
  expect(c.validateHookModule({ ...m, timeoutMs: 0 }).join()).toContain('timeoutMs');
  expect(c.validateHookModule({ ...m, onError: 'maybe' }).join()).toContain('onError');
  expect(c.validateHookModule({ ...m, handle: 1 }).join()).toContain('handle');
  expect(c.validateHookResult(undefined)).toEqual([]);
  expect(c.validateHookResult({ decision: 'ask', reason: 'r', updatedInput: { a: 1 }, block: false, extra: 1 })).toEqual([]);
  expect(c.validateHookResult({ decision: 'maybe' }).length).toBe(1);
  expect(c.validateHookResult('x').length).toBe(1);
  expect(c.validateHookResult({ reason: 1, block: 'y' }).length).toBe(2);
});

test('5.0: manifest aliases + config extRoots', () => {
  const m = { id: 'a', kind: 'cli', layer: 'ext', entry: 'a.mjs', domain: 'observe', aliases: ['audit', 'cost'], tests: [], domains: { x: { file: 'x.mjs', aliases: ['x-old'] } } };
  expect(c.validateExtManifest(m)).toEqual([]);
  expect(c.validateExtManifest({ ...m, aliases: ['Bad_Alias'] }).join()).toContain('aliases');
  expect(c.validateExtManifest({ ...m, aliases: 'audit' }).join()).toContain('aliases');
  expect(c.validateExtManifest({ ...m, domains: { x: { file: 'x.mjs', aliases: [1] } } }).join()).toContain('domains.x.aliases');
  expect(c.validateConfig({ extRoots: ['hub'] }, 'machine')).toEqual({ errors: [], warnings: [] });
  expect(c.validateConfig({ extRoots: 'hub' }).errors.length).toBe(1);
  expect(c.validateConfig({ extRoots: ['../x'] }).errors.length).toBe(1);
  expect(c.validateConfig({ extRoots: ['/abs'] }).errors.length).toBe(1);
  expect(c.validateConfig({ extRoots: ['C:/x'] }).errors.length).toBe(1);
  expect(c.validateConfig({ extRoots: ['harness/x'] }).errors.length).toBe(1);
  expect(c.validateExtRoots(undefined)).toEqual([]);
});
