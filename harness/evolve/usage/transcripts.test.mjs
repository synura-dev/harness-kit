import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTranscripts, compactMsg } from './transcripts.mjs';

const NOW = Date.parse('2026-11-07T00:00:00Z');
function mk() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tr-')); }
function put(root, rel, lines, mtimeMs) {
  const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  if (mtimeMs) fs.utimesSync(f, mtimeMs / 1000, mtimeMs / 1000);
  return f;
}
const skillLine = (ts, sid = 's1') => ({ sessionId: sid, timestamp: ts, cwd: '/x', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'a' } }] } });
const prompt = (ts, sid = 's1') => ({ sessionId: sid, timestamp: ts, type: 'user', message: { content: 'hi <command-name>/a</command-name>' } });
const run = (root, o = {}) => readTranscripts({ roots: [root], fromMs: NOW - 86400000, nowMs: NOW, ...o });

test('a: only files with mtime >= fromMs', async () => {
  const r = mk();
  put(r, 'p/old.jsonl', [skillLine('2026-10-01T00:00:00Z')], NOW - 10 * 86400000);
  put(r, 'p/new.jsonl', [skillLine('2026-11-06T12:00:00Z')], NOW - 3600000);
  const o = await run(r);
  assert.equal(o.files_read, 1); assert.equal(o.records.length, 1);
});
test('b: maxBytes / maxFiles', async () => {
  const r = mk();
  for (let i = 0; i < 3; i++) put(r, `p/f${i}.jsonl`, [skillLine('2026-11-06T12:00:00Z')], NOW - 1000);
  assert.equal((await run(r, { limits: { maxFiles: 1 } })).truncated, 'max_files');
  const o = await run(r, { limits: { maxBytes: 10 } });
  assert.equal(o.truncated, 'max_bytes'); assert.equal(o.files_read, 0);
});
test('c: timeout', async () => {
  const r = mk();
  const lines = []; for (let i = 0; i < 20000; i++) lines.push(skillLine('2026-11-06T12:00:00Z'));
  put(r, 'p/big.jsonl', lines, NOW - 1000);
  const o = await run(r, { limits: { timeoutMs: 1 } });
  assert.equal(o.truncated, 'timeout'); assert.ok(o.records.length < 20000);
});
test('d: bad JSON skipped; e: prefilter + record shape', async () => {
  const r = mk();
  put(r, 'proj-a/s.jsonl', ['{"Skill" broken', skillLine('2026-11-06T10:00:00Z'), { sessionId: 's1', timestamp: '2026-11-06T11:00:00Z', message: { content: 'nothing' } }], NOW - 1000);
  const o = await run(r);
  assert.equal(o.records.length, 1);
  const x = o.records[0];
  assert.equal(x.session, 's1'); assert.equal(x.project, 'proj-a'); assert.equal(x.ts, '2026-11-06T10:00:00Z');
  assert.ok(x.file.endsWith('s.jsonl')); assert.equal(x.msg.type, 'assistant');
  assert.equal(o.earliest_ts, '2026-11-06T10:00:00Z'); assert.equal(o.latest_ts, '2026-11-06T10:00:00Z');
});
test('turn key increments on real prompts only, not tool_result', async () => {
  const r = mk();
  const tr = { sessionId: 's1', timestamp: '2026-11-06T10:01:00Z', type: 'user', message: { content: [{ type: 'tool_result', content: 'SKILL.md' }] } };
  const f = put(r, 'p/s.jsonl', [prompt('2026-11-06T10:00:00Z'), skillLine('2026-11-06T10:00:30Z'), tr, prompt('2026-11-06T10:02:00Z'), skillLine('2026-11-06T10:03:00Z')], NOW - 1000);
  const o = await run(r);
  assert.deepEqual(o.records.map((x) => x.turn), [`${f}#1`, `${f}#1`, `${f}#1`, `${f}#2`, `${f}#2`]);
});
const cacheOf = () => path.join(mk(), 'c.jsonl');
const cached = (r, c, o = {}) => run(r, { cacheFile: c, ...o });
const cacheFiles = (c) => fs.readFileSync(c, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).file);

test('cache: hit not reparsed; miss on size or mtime change', async () => {
  const r = mk(); const c = cacheOf();
  const f = put(r, 'p/s.jsonl', [skillLine('2026-11-06T10:00:00Z')], NOW - 1000);
  const o1 = await cached(r, c);
  assert.equal(o1.files_parsed, 1); assert.equal(o1.cache_hits, 0); assert.ok(o1.bytes_parsed > 0);
  const o2 = await cached(r, c);
  assert.equal(o2.files_parsed, 0); assert.equal(o2.cache_hits, 1); assert.equal(o2.bytes_parsed, 0);
  assert.equal(o2.records.length, 1); assert.equal(o2.files_read, 1);
  fs.utimesSync(f, (NOW - 500) / 1000, (NOW - 500) / 1000);
  assert.equal((await cached(r, c)).files_parsed, 1);
  put(r, 'p/s.jsonl', [skillLine('2026-11-06T10:00:00Z'), skillLine('2026-11-06T10:05:00Z')], NOW - 500);
  const o4 = await cached(r, c);
  assert.equal(o4.files_parsed, 1); assert.equal(o4.records.length, 2);
});
test('cache: evicts deleted and out-of-window files', async () => {
  const r = mk(); const c = cacheOf();
  const a = put(r, 'p/a.jsonl', [skillLine('2026-11-06T10:00:00Z')], NOW - 1000);
  put(r, 'p/b.jsonl', [skillLine('2026-11-06T10:00:00Z')], NOW - 2000);
  await cached(r, c);
  assert.equal(cacheFiles(c).length, 2);
  fs.rmSync(a);
  fs.utimesSync(path.join(r, 'p/b.jsonl'), (NOW - 9 * 86400000) / 1000, (NOW - 9 * 86400000) / 1000);
  await cached(r, c);
  assert.deepEqual(cacheFiles(c), []);
});
test('cache: compact record shape', async () => {
  const r = mk(); const c = cacheOf();
  const asst = { sessionId: 's1', timestamp: '2026-11-06T10:00:00Z', type: 'assistant', uuid: 'u', message: { role: 'assistant', model: 'm', usage: { x: 1 }, content: [
    { type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'a', args: 'big' } },
    { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/x/SKILL.md', limit: 5 } },
    { type: 'text', text: 'blah' }] } };
  put(r, 'p/s.jsonl', [asst, prompt('2026-11-06T10:01:00Z')], NOW - 1000);
  const o = await cached(r, c);
  assert.deepEqual(o.records[0].msg, { type: 'assistant', uuid: 'u', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'a' } },
    { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/x/SKILL.md' } }] } });
  assert.deepEqual(o.records[1].msg.message.content, [{ type: 'text', text: '<command-name>/a</command-name>' }]);
  assert.deepEqual(Object.keys(o.records[0]).sort(), ['file', 'msg', 'project', 'session', 'ts', 'turn']);
});
test('cache: truncated run then resume finishes', async () => {
  const r = mk(); const c = cacheOf();
  for (let i = 0; i < 3; i++) put(r, `p/f${i}.jsonl`, [skillLine('2026-11-06T12:00:00Z')], NOW - 1000);
  const o1 = await cached(r, c, { limits: { maxFiles: 2 } });
  assert.equal(o1.truncated, 'max_files'); assert.equal(o1.records.length, 2);
  const o2 = await cached(r, c, { limits: { maxFiles: 2 } });
  assert.equal(o2.truncated, null); assert.equal(o2.cache_hits, 2); assert.equal(o2.files_parsed, 1); assert.equal(o2.records.length, 3);
});
test('subagents subfolder read, own turns', async () => {
  const r = mk();
  const f = put(r, 'p/sess/subagents/agent-1.jsonl', [prompt('2026-11-06T10:00:00Z')], NOW - 1000);
  const o = await run(r);
  assert.equal(o.records[0].turn, `${f}#1`);
});

// ---- fix2: per-project sessions, ts upper bound, timestamp robustness, cache version/limits ----
test('project_sessions: sessions per project folder; total_sessions same window', async () => {
  const r = mk();
  put(r, 'pa/1.jsonl', [skillLine('2026-11-06T10:00:00Z', 'a1'), skillLine('2026-11-06T11:00:00Z', 'a2')], NOW - 1000);
  put(r, 'pb/1.jsonl', [skillLine('2026-11-06T10:00:00Z', 'b1')], NOW - 1000);
  const o = await run(r);
  assert.deepEqual(o.project_sessions, { pa: 2, pb: 1 }); assert.equal(o.total_sessions, 3);
  const c = path.join(mk(), 'c.jsonl');
  await run(r, { cacheFile: c });
  assert.deepEqual((await run(r, { cacheFile: c })).project_sessions, { pa: 2, pb: 1 }); // cache hit giu dem
});
test('ts upper bound: session only in the far future is not counted', async () => {
  const r = mk();
  put(r, 'pa/1.jsonl', [skillLine('2026-11-06T10:00:00Z', 'a1'), skillLine('2030-01-01T00:00:00Z', 'fut')], NOW - 1000);
  const o = await run(r);
  assert.equal(o.total_sessions, 1); assert.deepEqual(o.project_sessions, { pa: 1 });
});
test('timestamp: top-level timestamp wins over a "timestamp" key inside tool_use input', async () => {
  const r = mk();
  const l = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'a', timestamp: '2020-01-01T00:00:00Z' } }] }, sessionId: 's1', timestamp: '2026-11-06T10:00:00Z' });
  put(r, 'pa/1.jsonl', [l], NOW - 1000);
  const o = await run(r);
  assert.equal(o.total_sessions, 1); assert.deepEqual(o.project_sessions, { pa: 1 });
});
test('cache: entries without current v are misses; cold limits when no current entries', async () => {
  const r = mk(); const c = cacheOf();
  const f = put(r, 'p/s.jsonl', [skillLine('2026-11-06T10:00:00Z')], NOW - 1000);
  const st = fs.statSync(f);
  fs.writeFileSync(c, JSON.stringify({ file: f, mtimeMs: st.mtimeMs, size: st.size, sess: { s1: '2026-11-06T10:00:00Z' }, records: [] }) + '\n');
  const o1 = await cached(r, c);
  assert.equal(o1.cold, true); assert.equal(o1.cache_hits, 0); assert.equal(o1.files_parsed, 1); assert.equal(o1.records.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(c, "utf8").trim()).v, 2);
  const o2 = await cached(r, c);
  assert.equal(o2.cold, false); assert.equal(o2.cache_hits, 1);
});
test('cache: oversized cache file -> start empty, fail-open; unwritable cache path does not throw', async () => {
  const r = mk(); const c = cacheOf();
  put(r, 'p/s.jsonl', [skillLine('2026-11-06T10:00:00Z')], NOW - 1000);
  await cached(r, c);
  const o = await cached(r, c, { limits: { cacheMaxBytes: 5 } });
  assert.equal(o.cache_hits, 0); assert.equal(o.files_parsed, 1);
  const blocker = path.join(mk(), 'file'); fs.writeFileSync(blocker, 'x');
  const o2 = await cached(r, path.join(blocker, 'sub', 'c.jsonl'));
  assert.equal(o2.records.length, 1);
});

test('compactMsg keeps uuid and isSidechain', () => {
  const c = compactMsg({ type: 'user', uuid: 'u1', isSidechain: true, message: { role: 'user', content: 'hi' } });
  assert.equal(c.uuid, 'u1'); assert.equal(c.isSidechain, true);
});

// ---- fix3 ----
test('cache over cap: save trims to cap (newest kept), reports cache_trimmed, never writes over cap', async () => {
  const r = mk(); const c = cacheOf();
  for (let i = 0; i < 4; i++) put(r, `p/f${i}.jsonl`, [skillLine('2026-11-06T10:00:00Z', `s${i}`)], NOW - (4 - i) * 1000);
  const cap = 1500;
  const o = await cached(r, c, { limits: { cacheMaxBytes: cap } });
  assert.ok(fs.statSync(c).size <= cap);
  assert.ok(o.cache_trimmed > 0 && o.cache_trimmed < 4);
  assert.ok(cacheFiles(c).some((f) => f.endsWith('f3.jsonl'))); // newest mtime kept
  const o2 = await cached(r, c, { limits: { cacheMaxBytes: cap } });
  assert.equal(o2.cold, false); assert.ok(o2.cache_hits >= 1);
});
test('timestamp: later "timestamp" inside toolUseResult is ignored', async () => {
  const r = mk();
  const l = '{"type":"assistant","uuid":"u1","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"a"}}]},"sessionId":"s1","timestamp":"2026-11-06T10:00:00Z","toolUseResult":{"timestamp":"2030-01-01T00:00:00Z"}}';
  put(r, 'pa/1.jsonl', [l], NOW - 1000);
  const o = await run(r);
  assert.equal(o.total_sessions, 1);
});

test('cacheOnly: khong parse file nao (files_parsed=0), dung entry cache, khong ghi cache', async () => {
  const r = mk(); const cf = path.join(mk(), 'c.jsonl');
  put(r, 'p/a.jsonl', [skillLine('2026-11-06T12:00:00Z')], NOW - 3600000);
  const warm = await run(r, { cacheFile: cf });
  assert.equal(warm.files_parsed, 1);
  const before = fs.readFileSync(cf, 'utf8');
  put(r, 'p/b.jsonl', [skillLine('2026-11-06T13:00:00Z')], NOW - 1000); // moi, chua co trong cache
  const o = await run(r, { cacheFile: cf, cacheOnly: true });
  assert.equal(o.files_parsed, 0); assert.equal(o.bytes_parsed, 0); assert.equal(o.records.length, 1);
  assert.equal(fs.readFileSync(cf, 'utf8'), before);
});
