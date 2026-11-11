import { test, expect } from 'bun:test';
import { findContentDupes, blocksOf, loadKnowledge, collectSources, MIN_WORDS } from './content-dupes.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const A = '- Khi deploy server phải kiểm tra remote và PATH trước, sau đó chạy script deploy và xác nhận health';
const A2 = '- Khi deploy server phải kiểm tra remote và PATH trước, sau đó chạy script deploy và xác nhận log';
const Z = '- Mongo cổng 27018 dùng cho test thủ công khởi động detached bằng Win32_Process';
const src = (name, text, sep = ':') => ({ name, text, sep });

test('near-identical blocks (1 word changed) pair with score >= 0.6, no text in output', () => {
  const r = findContentDupes([src('a.md', `# T\n${A}\n`), src('b.md', `${Z}\n${A2}\n`)]);
  expect(r.pairs.length).toBe(1);
  expect(r.pairs[0].a).toEqual({ file: 'a.md', line: 2, loc: 'a.md:2' });
  expect(r.pairs[0].b).toEqual({ file: 'b.md', line: 2, loc: 'b.md:2' });
  expect(r.pairs[0].score).toBeGreaterThanOrEqual(0.6);
  expect(JSON.stringify(r)).not.toContain('deploy');
  expect(r.truncated).toBe(null);
});

test('diacritic-only variants are folded together', () => {
  const r = findContentDupes([src('a.md', A), src('b.md', 'Khi deploy server phai kiem tra remote va PATH truoc, sau do chay script deploy va xac nhan health')]);
  expect(r.pairs.length).toBe(1);
});

test('short blocks (ma / mà) are ignored by min size', () => {
  expect(MIN_WORDS).toBeGreaterThanOrEqual(5);
  const r = findContentDupes([src('a.md', '- ma\n- mà ma ma ma'), src('b.md', '- mà\n- ma mà ma ma')]);
  expect(r.pairs).toEqual([]);
});

test('unrelated blocks do not pair; pair order is deterministic (a<b)', () => {
  const r = findContentDupes([src('z.md', A), src('a.md', A), src('m.md', Z)]);
  expect(r.pairs.map((p) => [p.a.file, p.b.file])).toEqual([['a.md', 'z.md']]);
});

test('knowledge docs use id#line locations', () => {
  const r = findContentDupes([src('k1', `x\n${A}`, '#'), src('f.md', A)]);
  expect(r.pairs[0].a.loc).toBe('f.md:1');
  expect(r.pairs[0].b.loc).toBe('k1#2');
});

test('blocksOf splits on headings/bullets and blank lines', () => {
  const b = blocksOf('# H\n- one two three four five six seven eight\n  more words here\n\npara a b c d e f g h\n');
  expect(b.map((x) => x.line)).toEqual([1, 2, 5]);
});

test('truncated on maxBlocks, maxPairs, timeout', () => {
  const s = [src('a.md', `${A}\n${A2}`), src('b.md', A)];
  expect(findContentDupes(s, { maxBlocks: 2 }).truncated).toBe('max_blocks');
  expect(findContentDupes(s, { maxPairs: 1 }).truncated).toBe('max_pairs');
  expect(findContentDupes(s, { timeoutMs: -1 }).truncated).toBe('timeout');
});

test('loadKnowledge: injected runner, fail-open', async () => {
  const ok = await loadKnowledge({ run: async () => JSON.stringify({ docs: [{ id: 'k1', body: A }], truncated: 'max' }) });
  expect(ok.sources).toEqual([{ name: 'k1', text: A, sep: '#' }]);
  expect(ok.truncated).toBe('knowledge: max');
  for (const run of [async () => { throw new Error('x'); }, async () => 'not json', async () => '{}']) {
    const r = await loadKnowledge({ run });
    expect(r.sources).toEqual([]);
    expect(r.truncated).toBe('knowledge: no_export');
  }
});

test('collectSources reads memory/rule files with caps and adds knowledge', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'cd-'));
  mkdirSync(path.join(d, '.claude/memory'), { recursive: true });
  mkdirSync(path.join(d, '.claude/agents'), { recursive: true });
  writeFileSync(path.join(d, 'CLAUDE.md'), A);
  writeFileSync(path.join(d, '.claude/memory/m.md'), A2);
  writeFileSync(path.join(d, '.claude/agents/x.md'), Z);
  const r = await collectSources({ root: d, run: async () => JSON.stringify({ docs: [{ id: 'k', body: A }] }) });
  expect(r.sources.map((s) => s.name).sort()).toEqual(['.claude/agents/x.md', '.claude/memory/m.md', 'CLAUDE.md', 'k']);
  expect((await collectSources({ root: d, maxFiles: 1, run: async () => '{}' })).truncated).toContain('max_files');
});

test('maxBlocks cut still yields pairs, share spread across sources', () => {
  const tail = Array.from({ length: 6 }, (_, i) => `- filler number ${i} alpha beta gamma delta epsilon zeta eta theta`).join('\n');
  const r = findContentDupes([src('a.md', `${tail}\n${A}`), src('b.md', A)], { maxBlocks: 4 });
  expect(r.truncated).toBe('max_blocks');
  expect(r.pairs.length).toBe(0); // dup block of a is in the dropped tail (2 per source kept)
  const r2 = findContentDupes([src('a.md', `${A}\n${tail}`), src('b.md', `${A}\n${tail}`)], { maxBlocks: 4 });
  expect(r2.truncated).toBe('max_blocks');
  expect(r2.pairs.length).toBeGreaterThan(0);
});

test('frontmatter and boilerplate labels are ignored; structure-only memories do not pair', () => {
  const m = (x, y) => `---\nname: n\ndescription: d one two three four five six seven\ntype: feedback\n---\n**Why:** ${x}\n\n**How to apply:** ${y}\n`;
  const r = findContentDupes([
    src('m1.md', m('alpha bravo charlie delta echo foxtrot golf hotel', 'india juliet kilo lima mike november oscar papa')),
    src('m2.md', m('quebec romeo sierra tango uniform victor whiskey xray', 'yankee zulu one two three four five six')),
  ]);
  expect(r.pairs).toEqual([]);
  const idx = '- [Some title here](some-file.md) — one hook line two three four five six';
  expect(findContentDupes([src('x.md', idx), src('y.md', idx)]).pairs).toEqual([]);
  expect(blocksOf('---\na: b\n---\n- one two three four five six seven eight')[0].line).toBe(4);
});

test('pairs within the same source are not reported', () => {
  expect(findContentDupes([src('a.md', `${A}\n${A}`)]).pairs).toEqual([]);
});

test('loadKnowledge: byte overflow reported as max_bytes, not no_export', async () => {
  const run = async () => { throw Object.assign(new Error('cap'), { code: 'max_bytes' }); };
  expect((await loadKnowledge({ run })).truncated).toBe('knowledge: max_bytes');
});

test('collectSources does not follow symlinks outside root', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'cd-')), o = mkdtempSync(path.join(tmpdir(), 'cd-out-'));
  mkdirSync(path.join(d, '.claude/memory'), { recursive: true });
  writeFileSync(path.join(o, 'secret.md'), A);
  symlinkSync(path.join(o, 'secret.md'), path.join(d, '.claude/memory/s.md'));
  symlinkSync(path.join(o, 'secret.md'), path.join(d, 'CLAUDE.md'));
  const r = await collectSources({ root: d, run: async () => '{}' });
  expect(r.sources.map((s) => s.name)).toEqual([]);
});
