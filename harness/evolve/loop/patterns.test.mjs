import { test, expect } from 'bun:test';
import { bashSignature, opSignature, detectCommands, detectSequences, detectInfoFetch, detectPatterns, isIgnored, DEFAULT_IGNORE, PATTERN_DEFAULTS } from './patterns.mjs';

let t = 0;
const ev = (sid, tool, target, extra = {}) => ({ event: 'PostToolUse', sid, actor: 'main', tool, target, dur_ms: 100, ts: new Date(Date.UTC(2026, 10, 1, 0, 0, t++)).toISOString(), data: {}, ...extra });
const o = { ...PATTERN_DEFAULTS, ignore: DEFAULT_IGNORE };
const streamsOf = (evs) => {
  const m = new Map();
  for (const e of evs) { if (!m.has(e.sid)) m.set(e.sid, { sid: e.sid, ops: [] }); m.get(e.sid).ops.push({ sig: opSignature(e), ts: e.ts, ms: e.dur_ms }); }
  return [...m.values()];
};

test('chu ky Bash: bo cd/timeout/doi so duong dan', () => {
  expect(bashSignature('cd "E:/x y" && timeout 60 harness obsidian put --section "A=B"')).toBe('Bash:harness obsidian put');
  expect(bashSignature('git push origin main')).toBe('Bash:git push origin');
  expect(bashSignature('bun test harness/a.test.mjs')).toBe('Bash:bun test');
  expect(bashSignature('FOO=1 git status && ls')).toBe('Bash:git status');
  expect(bashSignature('harness projects resolve abc123def456')).toBe('Bash:harness projects resolve');
  expect(bashSignature('ls -la /tmp')).toBe('Bash:ls');
});

test('chu ky: script runner giu ten file, bo van ban/subshell', () => {
  expect(bashSignature('node "E:/x/harness/cli/harness.mjs" evolve patterns')).toBe('Bash:node harness.mjs');
  expect(bashSignature('(timeout 60 bun test a.test.mjs)')).toBe('Bash:bun test');
  expect(bashSignature('Company: abc')).toBeNull();
  expect(isIgnored('Bash:sed')).toBe(true);
});

test('chu ky tool khac', () => {
  expect(opSignature({ tool: 'Edit', target: 'src/a.MJS' })).toBe('Edit:.mjs');
  expect(opSignature({ tool: 'Agent', data: { subagent_type: 'builder' } })).toBe('Agent:builder');
  expect(opSignature({ tool: 'WebFetch' })).toBe('WebFetch');
});

test('command: >=N lan va >=K phien', () => {
  const evs = [];
  for (const s of ['a', 'b', 'c']) for (let i = 0; i < 4; i++) evs.push(ev(s, 'Bash', `bun test f${i}.test.mjs`));
  expect(detectCommands(streamsOf(evs), o)).toMatchObject([{ subkind: 'command', sample: 'Bash:bun test', count: 12, sessions: 3, kind: 'pattern' }]);
  // chi 2 phien -> khong
  expect(detectCommands(streamsOf(evs.filter((e) => e.sid !== 'c')), { ...o, minCount: 5 })).toEqual([]);
});

test('bo qua thao tac nen', () => {
  const evs = [];
  for (const s of ['a', 'b', 'c']) for (let i = 0; i < 5; i++) { evs.push(ev(s, 'Read', 'x.js'), ev(s, 'Grep', 'p'), ev(s, 'Bash', 'git status'), ev(s, 'Bash', 'ls')); }
  expect(detectCommands(streamsOf(evs), o)).toEqual([]);
});

test('sequence: n-gram qua cac phien, bo chuoi con cung tan suat', () => {
  const evs = [];
  for (const s of ['a', 'b', 'c']) evs.push(ev(s, 'Edit', 'a.mjs'), ev(s, 'Bash', 'bun test x'), ev(s, 'Bash', 'git add .'), ev(s, 'Bash', 'git commit -m x'));
  const r = detectSequences(streamsOf(evs), o);
  expect(r.length).toBe(1);
  expect(r[0].sample).toBe('Edit:.mjs > Bash:bun test > Bash:git add > Bash:git commit');
  expect(r[0].sessions).toBe(3);
});

test('sequence: khong tinh chuoi lap mot thao tac', () => {
  const evs = [];
  for (const s of ['a', 'b', 'c']) for (let i = 0; i < 6; i++) evs.push(ev(s, 'Bash', 'bun test x'));
  expect(detectSequences(streamsOf(evs), o)).toEqual([]);
});

test('info_fetch: lenh doc dau phien / truoc Agent', () => {
  const evs = [];
  for (const s of ['a', 'b', 'c']) evs.push(ev(s, 'Bash', 'harness projects resolve p1'), ev(s, 'Edit', 'a.mjs'));
  const r = detectInfoFetch(streamsOf(evs), o);
  expect(r).toMatchObject([{ subkind: 'info_fetch', sessions: 3 }]);
  expect(r[0].sample).toContain('harness projects resolve');
});

test('prompt: bo qua khi chua co prompt_hash; xep hang count*cost', () => {
  const evs = [];
  for (const s of ['a', 'b', 'c']) evs.push({ event: 'UserPromptSubmit', sid: s, ts: '2026-11-01T00:00:00Z', data: {} });
  expect(detectPatterns(evs).skipped.prompt).toContain('prompt_hash');
  const withHash = ['a', 'b', 'c'].map((s) => ({ event: 'UserPromptSubmit', sid: s, ts: '2026-11-01T00:00:00Z', data: { prompt_hash: 'abc' } }));
  expect(detectPatterns(withHash).items[0]).toMatchObject({ subkind: 'prompt', count: 3 });
});

test('prompt: nguong rieng count>=3, sessions>=2; bo prompt <= 3 tu khoa', () => {
  const mkp = (n, sids, kw) => sids.map((s) => ({ event: 'UserPromptSubmit', sid: s, ts: '2026-11-01T00:00:00Z', data: { prompt_hash: 'h' + n, prompt_kw: kw } }));
  const kw5 = ['a1', 'b2', 'c3', 'd4', 'e5'];
  expect(detectPatterns(mkp(1, ['s1', 's2', 's3'], kw5)).items.length).toBe(1);
  expect(detectPatterns(mkp(1, ['s1', 's2'], kw5)).items.length).toBe(0); // count 2 < 3
  expect(detectPatterns(mkp(1, ['s1', 's1', 's1'], kw5)).items.length).toBe(0); // 1 phien < 2
  expect(detectPatterns(mkp(1, ['s1', 's2', 's3'], ['ok', 'tiep'])).items.length).toBe(0); // prompt ngan
  expect(detectPatterns(mkp(1, ['s1', 's2', 's3'], kw5), { minSessions: 3, minCount: 10 }).items.length).toBe(1); // khong dung chung nguong lenh
});
