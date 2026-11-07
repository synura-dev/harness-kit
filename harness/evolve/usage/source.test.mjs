import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySource, actionFor, canPropose } from './source.mjs';

const o = { pluginRoots: ['C:/p/plugins/cache/mine'], projectRoots: ['C:/proj'], builtin: ['simplify', 'loop'] };

test('anthropic-skills prefix -> account', () => {
  assert.equal(classifySource({ ...o, id: 'anthropic-skills:pdf' }), 'account');
});
test('plugin prefix -> plugin only if owned', () => {
  assert.equal(classifySource({ ...o, id: 'harness-kit:play', ownedPlugins: new Set(['harness-kit']) }), 'plugin');
  assert.equal(classifySource({ ...o, id: 'superpowers:tdd' }), 'third_party');
});
test('path under plugin root -> plugin', () => {
  assert.equal(classifySource({ ...o, id: 'x', path: 'C:/p/plugins/cache/mine/skills/x/SKILL.md' }), 'plugin');
});
test('path under project .claude / .agents -> project', () => {
  assert.equal(classifySource({ ...o, id: 'x', path: 'C:/proj/.claude/skills/x/SKILL.md' }), 'project');
  assert.equal(classifySource({ ...o, id: 'x', path: 'C:\\proj\\.agents\\skills\\x\\SKILL.md' }), 'project');
});
test('local copy of builtin name classifies by path first', () => {
  assert.equal(classifySource({ ...o, id: 'simplify', path: 'C:/proj/.claude/skills/simplify/SKILL.md' }), 'project');
});
test('no path + builtin id -> builtin; else unknown', () => {
  assert.equal(classifySource({ ...o, id: 'loop' }), 'builtin');
  assert.equal(classifySource({ ...o, id: 'mystery' }), 'unknown');
});
test('actions and canPropose', () => {
  assert.equal(actionFor('project'), 'delete_in_repo');
  assert.equal(actionFor('plugin'), 'edit_plugin_repo');
  assert.equal(actionFor('account'), 'disable_on_claude_ai');
  assert.equal(actionFor('builtin'), 'report_only');
  assert.equal(actionFor('unknown'), 'report_only');
  assert.deepEqual(['project', 'plugin', 'account', 'builtin', 'unknown', 'third_party'].filter(canPropose), ['project', 'plugin']);
});

test('project needs path under projectRoots; plugins dir never project; empty roots unknown', () => {
  assert.equal(classifySource({ id: 'x', path: 'C:/other/.claude/skills/x/SKILL.md', projectRoots: ['C:/proj'] }), 'unknown');
  assert.equal(classifySource({ id: 'x', path: 'C:/proj/.claude/skills/x/SKILL.md', projectRoots: [] }), 'unknown');
  assert.equal(classifySource({ id: 'x', path: 'C:/Users/u/.claude/plugins/cache/m/p/skills/x/SKILL.md', projectRoots: ['C:/Users/u'] }), 'third_party');
  assert.equal(actionFor('third_party'), 'report_only');
});
