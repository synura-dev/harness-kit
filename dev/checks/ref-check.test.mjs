import { test, expect } from 'bun:test';
import { checkRefs, extractRefs, scanKind, makeCoreOwned, isHistorical } from './ref-check.mjs';

const present = new Set(['harness/cli/harness.mjs', 'harness/plugins/foo/cli.mjs']);
const exists = (p) => present.has(p);

test('scanKind selects files', () => {
  expect(scanKind('.agents/playbooks/a.json')).toBe('playbook');
  expect(scanKind('docs/X.md')).toBe('text');
  expect(scanKind('src/a.md')).toBe(null);
});

test('extractRefs normalizes and skips globs', () => {
  expect(extractRefs('see ./harness/cli/a.mjs, and cli/b.mjs.').map((r) => r.path))
    .toEqual(['harness/cli/a.mjs', 'harness/cli/b.mjs']);
  expect(extractRefs('harness/hooks/*.mjs')).toEqual([]);
  expect(extractRefs('data/harness/x')).toEqual([]);
});

test('ref khong duoi hop le neu ton tai voi .mjs; marker planned bo qua', () => {
  const ex = (p) => p === 'harness/cli/dispatch-worker.mjs';
  const content = ['ok harness/cli/dispatch-worker', 'bad harness/cli/nope',
    'x harness/core/planned.mjs <!-- ref-ignore -->', 'Sẽ tạo harness/core/later.mjs',
    '<!-- ref-ignore-start -->', 'harness/core/in-block.mjs', '<!-- ref-ignore-end -->', 'bad harness/core/after.mjs'].join('\n');
  const r = checkRefs({ exists: ex, files: [{ path: 'docs/A.md', content }] });
  expect(r.errors.map((e) => e.ref)).toEqual(['harness/cli/nope', 'harness/core/after.mjs']);
});

test('reports broken refs with file:line', () => {
  const r = checkRefs({ exists, files: [
    { path: 'docs/A.md', content: 'ok harness/cli/harness.mjs\nbad harness/cli/dir-sizes.mjs\nbad harness/evals/bench' },
  ] });
  expect(r.ok).toBe(false);
  expect(r.errors).toEqual([
    { file: 'docs/A.md', line: 2, ref: 'harness/cli/dir-sizes.mjs' },
    { file: 'docs/A.md', line: 3, ref: 'harness/evals/bench' },
  ]);
});

test('playbook only checks run/command', () => {
  const content = JSON.stringify({ name: 'harness/evals/zzz', steps: [{ run: 'node harness/cli/nope.mjs' }, { command: 'node harness/cli/harness.mjs' }] }, null, 2);
  const r = checkRefs({ exists, files: [{ path: '.agents/playbooks/p.json', content }] });
  expect(r.errors.map((e) => e.ref)).toEqual(['harness/cli/nope.mjs']);
  expect(r.errors[0].line).toBeGreaterThan(1);
});

test('USAGE in cli file only', () => {
  const content = 'const x = "plugins/ignored/y";\nconst USAGE = `\n use cli/missing.mjs\n`;\n';
  const r = checkRefs({ exists, files: [{ path: 'harness/cli/t.mjs', content }] });
  expect(r.errors.map((e) => e.ref)).toEqual(['cli/missing.mjs']);
});

test('truncated on timeout and max-files', () => {
  let t = 0;
  const files = [1, 2, 3].map((i) => ({ path: `docs/${i}.md`, content: 'harness/x' }));
  const r = checkRefs({ exists, files, limits: { timeoutMs: 5 }, now: () => (t += 10) });
  expect(r.truncated).toBe('timeout');
  expect(checkRefs({ exists, files, limits: { maxFiles: 1 } }).truncated).toBe('max-files');
});

test('ref-ignore ngoai docs/ khong che ref hong va bi canh bao', () => {
  const content = 'x harness/core/gone.mjs <!-- ref-ignore -->';
  const r = checkRefs({ exists: () => false, files: [{ path: 'config/a.json', content }, { path: 'docs/A.md', content }] });
  expect(r.errors.filter((e) => e.file === 'docs/A.md')).toEqual([]);
  const cfg = r.errors.filter((e) => e.file === 'config/a.json').map((e) => e.ref);
  expect(cfg).toContain('harness/core/gone.mjs');
  expect(cfg.some((x) => x.includes('ngoai docs/'))).toBe(true);
});

test('workspace mode: ref loi plugin khong loi, ref hub hong van bao, docs lich su bo qua (fixture that)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { buildScanInput } = await import('./scan-input.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refws-'));
  try {
    const plug = path.join(tmp, 'plugin'); const ws = path.join(tmp, 'ws');
    fs.mkdirSync(path.join(plug, 'harness', 'core'), { recursive: true });
    fs.mkdirSync(path.join(plug, 'harness', 'tools', 'adapters'), { recursive: true });
    fs.writeFileSync(path.join(plug, 'harness', 'tools', 'adapters', 'claude.mjs'), '');
    fs.mkdirSync(path.join(ws, 'docs', 'plans'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'config'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'docs', 'ARCH.md'), 'loi: harness/core/x.mjs\nadapter: harness/tools/adapters/claude.mjs\nhub hong: harness/skills/foo/SKILL.md\n');
    fs.writeFileSync(path.join(ws, 'docs', 'audit-old.md'), 'cu: harness/skills/gone.md\n');
    fs.writeFileSync(path.join(ws, 'config', 'a.json'), '{"owner": "harness/release/cli.mjs"}\n');
    const si = buildScanInput(ws);
    const coreOwned = makeCoreOwned({ coreDirs: ['core', 'tools'], existsInPlugin: (p) => fs.existsSync(path.join(plug, p)) });
    const r = checkRefs({ files: si.files, exists: si.exists, coreOwned, skipHistorical: true });
    const refs = r.errors.map((e) => `${e.file}:${e.ref}`).sort();
    expect(refs).toEqual(['config/a.json:harness/release/cli.mjs', 'docs/ARCH.md:harness/skills/foo/SKILL.md']);
    // khong workspace mode (khong coreOwned): doctor khong mu, loi plugin van bao trong repo plugin
    const raw = checkRefs({ files: si.files, exists: si.exists });
    expect(raw.errors.some((e) => e.ref === 'harness/core/x.mjs')).toBe(true);
    expect(raw.errors.some((e) => e.file === 'docs/audit-old.md')).toBe(true);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('isHistorical va makeCoreOwned', () => {
  expect(isHistorical('docs/audit-x.md')).toBe(true);
  expect(isHistorical('docs/plans/p.md')).toBe(true);
  expect(isHistorical('TASKS.md')).toBe(true);
  expect(isHistorical('docs/ARCHITECTURE.md')).toBe(false);
  const own = makeCoreOwned({ coreDirs: ['core'] });
  expect(own('harness/core/x.mjs')).toBe(true);
  expect(own('harness/skills/x')).toBe(false);
  expect(own('config/x.json')).toBe(false);
});
