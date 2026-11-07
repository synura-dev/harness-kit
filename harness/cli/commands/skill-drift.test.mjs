import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skillDrift } from './skill-drift.mjs';

const put = (root, rel, txt) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); };
const fx = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-')); return { proj: path.join(d, 'p'), plug: path.join(d, 'plug') }; };
const one = (r, n) => r.findings.find((f) => f.skill === n);

test('giong nhau -> ok; CRLF-only va .generated.json bo qua -> ok', () => {
  const { proj, plug } = fx();
  put(proj, '.claude/skills/x/SKILL.md', 'a\nb\n');
  put(proj, '.agents/skills/x/SKILL.md', 'a\r\nb\r\n');
  put(proj, '.agents/skills/x/.generated.json', '{"t":1}');
  put(plug, 'x/SKILL.md', 'a\nb\n');
  const r = skillDrift({ projectDir: proj, pluginSkillsDir: plug });
  assert.equal(one(r, 'x').level, 'ok');
});
test('mot ban lech -> warn nen ten ban sao', () => {
  const { proj, plug } = fx();
  put(proj, '.claude/skills/x/SKILL.md', 'a');
  put(proj, '.agents/skills/x/SKILL.md', 'a');
  put(plug, 'x/SKILL.md', 'CHANGED');
  const f = one(skillDrift({ projectDir: proj, pluginSkillsDir: plug }), 'x');
  assert.equal(f.level, 'warn');
  assert.match(f.detail, /plugin-cache/);
});
test('thieu ban sao -> info, khong warn', () => {
  const { proj } = fx();
  put(proj, '.claude/skills/x/SKILL.md', 'a');
  const f = one(skillDrift({ projectDir: proj }), 'x');
  assert.equal(f.level, 'info');
  assert.match(f.detail, /\.agents\/skills/);
});
test('vuot maxFiles -> truncated', () => {
  const { proj } = fx();
  for (let i = 0; i < 5; i++) put(proj, `.claude/skills/x/f${i}.md`, 'a');
  assert.equal(skillDrift({ projectDir: proj, maxFiles: 3 }).truncated, 'max_files');
});
