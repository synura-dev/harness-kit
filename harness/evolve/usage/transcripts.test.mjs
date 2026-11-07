import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTranscripts } from './transcripts.mjs';

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
test('subagents subfolder read, own turns', async () => {
  const r = mk();
  const f = put(r, 'p/sess/subagents/agent-1.jsonl', [prompt('2026-11-06T10:00:00Z')], NOW - 1000);
  const o = await run(r);
  assert.equal(o.records[0].turn, `${f}#1`);
});
