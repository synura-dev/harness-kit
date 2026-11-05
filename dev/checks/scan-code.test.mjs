import { describe, expect, test } from 'bun:test';
import { scanCode, exportNames, topFunctions } from './clutter-check.mjs';

const f = (path, content) => ({ path, content });
const T = 'TO' + 'DO'; // tranh tu khop marker

describe('exportNames / topFunctions', () => {
  test('nhan export khai bao, export {a as b}, bo default', () => {
    const c = 'export function a(){}\nexport const b = 1;\nexport async function c(){}\nexport { d, e as ee };\nexport default {};\n';
    expect(exportNames(c).sort()).toEqual(['a', 'b', 'c', 'd', 'ee']);
  });
  test('topFunctions: function va arrow cap cao, bo ham long nhau', () => {
    const c = 'function a(){}\nconst b = (x) => x;\nexport const c = async (x) => x;\n  function nested(){}\nconst d = 5;\n';
    expect(topFunctions(c).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('scanCode (fixture)', () => {
  const files = [
    f('harness/core/a.mjs', 'export function used(){}\nexport const unusedOne = 1;\nexport const onlyTest = 2;\n'),
    f('harness/core/b.mjs', "import { used } from './a.mjs';\nused();\nfunction helper(){}\nfunction main(){} // process.argv[1]\n"),
    f('harness/core/c.mjs', 'function helper(){}\nfunction main(){} // process.argv[1]\nfunction fine(){}\n// ' + T + ': xong\n'),
    f('harness/core/a.test.mjs', "import { onlyTest } from './a.mjs';\nfunction helper(){}\nonlyTest;\n"),
    f('docs/x.mjs', 'export const outside = 1;'),
  ];
  const r = scanCode(files);
  test('khong ai dung vs chi test dung', () => {
    expect(r.unused).toEqual([{ file: 'harness/core/a.mjs', name: 'unusedOne' }]);
    expect(r.testOnly).toEqual([{ file: 'harness/core/a.mjs', name: 'onlyTest' }]);
  });
  test('ham trung ten: bo test, bo allowlist (main)', () => {
    expect(r.dup).toEqual([{ name: 'helper', files: ['harness/core/b.mjs', 'harness/core/c.mjs'] }]);
    expect(scanCode(files, { dupAllow: ['helper', 'main'] }).dup).toEqual([]);
  });
  test('DUP_ALLOW dang {name,files,reason}: chi cho phep khi moi file trung nam trong files', () => {
    const ok = { name: 'helper', files: ['harness/core/b.mjs', 'harness/core/c.mjs'], reason: 'x' };
    expect(scanCode(files, { dupAllow: [ok, 'main'] }).dup).toEqual([]);
    expect(scanCode(files, { dupAllow: [{ ...ok, files: ['harness/core/b.mjs'] }, 'main'] }).dup.length).toBe(1);
  });
  test('main/run: bo qua khi file la entry CLI (shebang/process.argv[1]/import.meta.main), bao khi khong', () => {
    const e = (p, tail) => f(p, `function main(){}\nfunction run(){}\n${tail}\n`);
    for (const tail of ['#!/usr/bin/env node', 'if (process.argv[1]) main();', 'if (import.meta.main) main();', 'const isMain = 1;']) {
      const content = tail.startsWith('#!') ? `${tail}\nfunction main(){}\nfunction run(){}\n` : undefined;
      const fs2 = content ? [f('harness/cli/x.mjs', content), f('harness/cli/y.mjs', content)] : [e('harness/cli/x.mjs', tail), e('harness/cli/y.mjs', tail)];
      expect(scanCode(fs2, { dupAllow: [] }).dup).toEqual([]);
    }
    const plain = [e('harness/cli/x.mjs', ''), e('harness/cli/y.mjs', '')];
    expect(scanCode(plain, { dupAllow: [] }).dup.map((d) => d.name)).toEqual(['main', 'run']);
  });
  test('marker dem dong', () => {
    expect(r.todo).toEqual([{ file: 'harness/core/c.mjs', line: 4 }]);
    expect(scanCode([f('harness/x.mjs', 'const todo = 1; // file tam\n// temporary\n')]).todo.length).toBe(2);
    expect(scanCode([f('harness/x.mjs', 'const todo = 1;\n')]).todo.length).toBe(0);
  });
});
