import { describe, expect, test } from 'bun:test';
import { checkClutter, countSources, countFlat } from './clutter-check.mjs';

describe('flatMax: tran file phang moi thu muc', () => {
  const mk = (d, n) => Array.from({ length: n }, (_, i) => ({ path: `harness/${d}/m${i}.mjs`, lines: 50, bytes: 500 }));
  const ids = (r) => r.findings.map((x) => `${x.rule}:${x.path}`);
  test('countFlat khong de quy, bo test/manifest/README', () => {
    const files = [...mk('core/io', 3), { path: 'harness/core/io/a.test.mjs' }, { path: 'harness/core/io/README.md' }, { path: 'harness/core/x.mjs' }, { path: 'docs/x.mjs' }];
    expect(countFlat(files, 3)).toEqual([{ dir: 'harness/core/io', count: 3, max: 3, over: false }, { dir: 'harness/core', count: 1, max: 3, over: false }]);
  });
  test('vuot flatMax -> finding warn; ghi de qua caps', () => {
    const r = checkClutter(mk('core/io', 9), {});
    expect(ids(r)).toContain('flatMax:harness/core/io');
    expect(r.findings.find((x) => x.rule === 'flatMax').severity).toBe('warn');
    expect(ids(checkClutter(mk('core/io', 8), {})).some((x) => x.startsWith('flatMax'))).toBe(false);
    expect(ids(checkClutter(mk('core/io', 4), {}, { caps: { flatMax: 3 } }))).toContain('flatMax:harness/core/io');
  });
});

test('countSources: bo test/manifest/README/fixture, chi dem (khong tran)', () => {
  const files = ['a.mjs', 'a.test.mjs', 'manifest.json', 'README.md', 'x.fixture.json', 'sub/b.mjs'].map((n) => ({ path: `harness/cli/${n}` }));
  const r = countSources([...files, { path: 'harness/core/c.mjs' }, { path: 'docs/x.mjs' }], ['core', 'cli']);
  expect(r).toEqual([{ dir: 'core', count: 1 }, { dir: 'cli', count: 2 }]);
});

const f = (path, lines = 50, bytes = 500, content) => ({ path, lines, bytes, content });
const rules = (r) => r.findings.map((x) => `${x.rule}:${x.path}`);

const registry = {
  manifests: [{ dir: 'harness/hooks/foo', entry: 'foo.mjs', files: { helpers: ['h.mjs'] }, tests: ['foo.test.mjs'] }],
  registered: ['harness/hooks/demo/hook.mjs'],
  referenced: ['config/cli-domains.json'],
};

describe('checkClutter', () => {
  test('sach thi khong co phat hien', () => {
    const r = checkClutter([
      f('harness/hooks/foo/foo.mjs'), f('harness/hooks/foo/h.mjs'), f('harness/hooks/foo/foo.test.mjs'),
      f('harness/hooks/demo/hook.mjs'), f('config/cli-domains.json'), f('harness/README.md'),
    ], registry);
    expect(r.findings).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  test('bat cac loai rac', () => {
    const r = checkClutter([
      f('harness/junk/a.mjs'),
      f('harness/hooks/foo/stray.mjs'),
      f('harness/hooks/bar/x.mjs'),
      f('harness/core/big.mjs', 900),
      f('harness/hooks/demo/defaults.mjs', 1, 20, 'export default {}\n'),
      f('config/unused-sample.json'),
      f('harness/tools/events.jsonl'),
      f('data/ok.jsonl'),
    ], registry);
    const s = rules(r);
    expect(s).toContain('topDirs:harness/junk');
    expect(s).toContain('orphan:harness/hooks/foo/stray.mjs');
    expect(s).toContain('orphan:harness/hooks/bar/x.mjs');
    expect(s).toContain('linesPerFile:harness/core/big.mjs');
    expect(s).toContain('emptyFile:harness/hooks/demo/defaults.mjs');
    expect(s).toContain('unusedConfig:config/unused-sample.json');
    expect(s).toContain('data:harness/tools/events.jsonl');
    expect(s).not.toContain('data:data/ok.jsonl');
    const big = r.findings.find((x) => x.rule === 'linesPerFile');
    expect(big.severity).toBe('warn');
    expect(big.suggest).toBeTruthy();
  });

  test('emptyFile: config nho co khoa that khong bi bao; {} va rong bi bao', () => {
    const reg = { registered: ['harness/hooks/demo/audit.config.json', 'harness/hooks/x/a.config.json', 'harness/hooks/x/b.config.json'] };
    const r = checkClutter([
      f('harness/hooks/demo/audit.config.json', 1, 27, '{"retention_days":30}'),
      f('harness/hooks/x/a.config.json', 1, 2, '{}'),
      f('harness/hooks/x/b.config.json', 0, 0, ''),
    ], reg);
    expect(rules(r).filter((x) => x.startsWith('emptyFile'))).toEqual(['emptyFile:harness/hooks/x/a.config.json', 'emptyFile:harness/hooks/x/b.config.json']);
  });

  test('tran file/extension va override custom', () => {
    const files = [];
    for (let i = 0; i < 4; i++) files.push(f(`harness/hooks/foo/f${i}.mjs`));
    registry.manifests[0].files.helpers = ['f0.mjs', 'f1.mjs', 'f2.mjs', 'f3.mjs'];
    const base = checkClutter(files, registry);
    expect(rules(base).some((x) => x.startsWith('filesPerExtension'))).toBe(false);
    const r = checkClutter(files, registry, { caps: { filesPerExtension: 3, linesPerFile: 10 } });
    expect(rules(r)).toContain('filesPerExtension:harness/hooks/foo');
    expect(rules(r).filter((x) => x.startsWith('linesPerFile')).length).toBe(4);
    registry.manifests[0].files.helpers = ['h.mjs'];
  });

  test('limit va timeout tra truncated', () => {
    const many = Array.from({ length: 10 }, (_, i) => f(`config/c${i}.json`));
    const r = checkClutter(many, {}, { limit: 3 });
    expect(r.findings.length).toBe(3);
    expect(r.truncated).toBe(true);
    let t = 0;
    const r2 = checkClutter(many, {}, { timeoutMs: 5, now: () => (t += 10) });
    expect(r2.truncated).toBe(true);
    expect(r2.reason).toBe('timeout');
  });

  test('dung luong data vuot tran', () => {
    const r = checkClutter([f('data/big.json', 1, 600 * 1048576)], {});
    expect(rules(r)).toContain('data:data');
  });
});

describe('checkClutter: pham vi may/cuc bo', () => {
  test('*.local.* va data/ khong bi emptyFile/unusedConfig; example theo file that', () => {
    const r = checkClutter([
      f('config/agy.local.json', 1, 2, '{}'), f('data/agy-home/keep.txt', 0, 0, ''),
      f('config/used.example.json'), f('config/lonely.example.json'), f('config/used.json'),
    ], { manifests: [], registered: [], referenced: ['config/used.json'] });
    expect(rules(r)).toEqual(['unusedConfig:config/lonely.example.json']);
  });
  test('config/<tool>/*.example.json hop le theo quy uoc, khong can tham chieu', () => {
    const r = checkClutter([f('config/guard/gemsocial.example.json'), f('config/guard/other.json')], { manifests: [], registered: [], referenced: [] });
    expect(rules(r)).toEqual(['unusedConfig:config/guard/other.json']);
  });
});
