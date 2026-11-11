import { test, expect } from 'bun:test';
import { findContentDupes, blocksOf, loadKnowledge, collectSources, MIN_WORDS } from './content-dupes.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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
  const s = [src('a.md', `${A}\n${A2}\n${A}`)];
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
