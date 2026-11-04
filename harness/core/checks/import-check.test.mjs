import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractImports, resolveSpec, checkImports, scanTree } from './import-check.mjs';

test('extractImports: static, multi-line, dynamic, bo comment', () => {
  const src = [
    "import a from './a.mjs';",
    'import {',
    '  x,',
    "} from '../cli/b.mjs';",
    "export * from './c.mjs';",
    "import './d.mjs';",
    "// import z from './no.mjs';",
    "const m = await import('./e.mjs');",
    "/* import q from './q.mjs' */",
    "export const k = 'from';",
  ].join('\n');
  const r = extractImports(src);
  expect(r.map((i) => i.spec)).toEqual(['./a.mjs', '../cli/b.mjs', './c.mjs', './d.mjs', './e.mjs']);
  expect(r[1].line).toBe(2);
  expect(r[4].kind).toBe('dynamic');
});

test('resolveSpec', () => {
  expect(resolveSpec('harness/core/a.mjs', '../cli/b.mjs')).toBe('harness/cli/b.mjs');
  expect(resolveSpec('harness/core/a.mjs', 'node:fs')).toBeNull();
});

test('checkImports: fixture vi pham + thieu file', () => {
  const files = [
    { path: 'harness/core/playbook.mjs', content: "import { x } from '../cli/dispatch-worker.mjs';\n" },
    { path: 'harness/cli/dispatch-worker.mjs', content: "import './ok.mjs';\nawait import('./smoke-roles.mjs');\nimport '../observe/p/p.mjs';\n" },
    { path: 'harness/cli/ok.mjs', content: "import fs from 'node:fs';\nimport '../core/playbook.mjs';\n" },
    { path: 'harness/observe/p/p.mjs', content: "import '../q/q.mjs';\nimport './p2.mjs';\n" },
    { path: 'harness/observe/p/p2.mjs', content: '' },
    { path: 'harness/observe/q/q.mjs', content: '' },
    { path: 'harness/tools/t.mjs', content: "import '../hooks/demo/a.mjs';\n" },
    { path: 'harness/hooks/demo/a.mjs', content: '' },
  ];
  const r = checkImports(files);
  const v = r.violations.map((x) => `${x.file}:${x.line} ${x.from.split('/')[1]}->${x.to.split('/')[1]}`);
  expect(v).toContain('harness/core/playbook.mjs:1 core->cli');
  expect(v).toContain('harness/cli/dispatch-worker.mjs:3 cli->observe');
  expect(v).toContain('harness/observe/p/p.mjs:1 observe->observe');
  expect(v).toContain('harness/tools/t.mjs:1 tools->hooks');
  expect(r.violations.length).toBe(4);
  expect(r.violations[0].rule).toContain('bi cam');
  expect(r.missing).toEqual([{ file: 'harness/cli/dispatch-worker.mjs', line: 2, spec: './smoke-roles.mjs', to: 'harness/cli/smoke-roles.mjs' }]);
  expect(r.truncated).toBe(false);
});

test('checkImports: truncated theo limit va timeout', () => {
  const files = Array.from({ length: 5 }, (_, i) => ({ path: `harness/core/f${i}.mjs`, content: "import '../cli/x.mjs';\n" }));
  expect(checkImports(files, { limit: 2 }).truncated).toBe('limit');
  let t = 0;
  expect(checkImports(files, { timeoutMs: 5, now: () => (t += 10) }).truncated).toBe('timeout');
});

test('import-check.mjs khong import cli/plugins/hooks/tools', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(here, 'import-check.mjs'), 'utf8');
  for (const i of extractImports(src)) expect(i.spec).toMatch(/^\.\.?\/|^node:/);
  expect(checkImports([{ path: 'harness/core/checks/import-check.mjs', content: src }]).violations).toEqual([]);
});

test('chay thu tren cay that (chi in so luong)', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const r = scanTree(root, { timeoutMs: 20000 });
  console.log(`real tree: scanned=${r.scanned} violations=${r.violations.length} missing=${r.missing.length} truncated=${r.truncated}`);
  expect(r.scanned).toBeGreaterThan(0);
});
