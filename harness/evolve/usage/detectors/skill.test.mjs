import test from 'node:test';
import assert from 'node:assert/strict';
import { detect } from './skill.mjs';

const rec = (content, role = 'assistant', extra = {}) => ({
  session: 's1', project: 'p', ts: '2026-11-01T00:00:00Z', turn: 1, file: 'x.jsonl',
  msg: { type: role, message: { role, content } }, ...extra,
});
const tu = (name, input, id = 't1') => ({ type: 'tool_use', id, name, input });

test('tool channel: Skill', () => {
  const [e] = detect(rec([tu('Skill', { skill: 'plugin-authoring' })]), {});
  assert.equal(e.kind, 'skill'); assert.equal(e.id, 'plugin-authoring');
  assert.equal(e.channel, 'tool'); assert.equal(e.callId, 't1'); assert.equal(e.origin, 'transcript');
  const [q] = detect(rec([tu('Skill', { skill: 'harness-kit:doctor' })]), {});
  assert.equal(q.id, 'doctor');
});

test('slash channel: skill vs command', () => {
  const r = rec([{ type: 'text', text: '<command-name>/harness-kit:doctor</command-name>' }], 'user');
  assert.equal(detect(r, { skillNames: new Set(['doctor']) })[0].kind, 'skill');
  assert.equal(detect(r, { skillNames: new Set(['doctor']) })[0].channel, 'slash');
  assert.equal(detect(r, {})[0].kind, 'command');
  const s = rec('<command-name>/foo</command-name>', 'user');
  assert.equal(detect(s, {})[0].id, 'foo');
});

test('read channel', () => {
  const a = detect(rec([tu('Read', { file_path: 'C:\\x\\skills\\my-skill\\skill.md' })]), {})[0];
  assert.equal(a.id, 'my-skill'); assert.equal(a.channel, 'read'); assert.equal(a.file, 'C:/x/skills/my-skill/skill.md'); assert.equal(a.callId, 't1');
  assert.equal(detect(rec([tu('Read', { file_path: '/a/b/SKILL.md' })]), {})[0].id, 'b');
});

test('read ignores non-skill', () => {
  assert.deepEqual(detect(rec([tu('Read', { file_path: '/a/README.md' })]), {}), []);
});

test('preload channel', () => {
  const ev = detect(rec([tu('Agent', { subagent_type: 'builder' }, 'a1')]), { agentSkills: { builder: ['tdd', 'verify'] } });
  assert.deepEqual(ev.map(e => [e.id, e.channel, e.callId]), [['tdd', 'preload', 'a1:tdd'], ['verify', 'preload', 'a1:verify']]);
  assert.deepEqual(detect(rec([tu('Task', { subagent_type: 'other' })]), { agentSkills: {} }), []);
});

test('malformed -> []', () => {
  for (const r of [null, {}, { msg: null }, { msg: { message: { content: 5 } } }]) assert.deepEqual(detect(r, {}), []);
});

test('regression: 32 calls -> 32 distinct events', () => {
  const evs = [];
  for (let i = 0; i < 32; i++) {
    evs.push(...detect(rec([tu('Skill', { skill: 'plugin-authoring' }, `t${i}`)], 'assistant', { ts: `2026-11-0${1 + (i % 2)}T00:00:00Z` }), {}));
  }
  assert.equal(evs.length, 32);
  assert.equal(new Set(evs.map(e => e.callId)).size, 32);
});
