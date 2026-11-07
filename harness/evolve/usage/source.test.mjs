import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySource, actionFor, canPropose } from './source.mjs';

const o = { pluginRoots: ['C:/p/plugins/cache'], projectRoots: ['C:/proj'], builtin: ['simplify', 'loop'] };

test('anthropic-skills prefix -> account', () => {
  assert.equal(classifySource({ ...o, id: 'anthropic-skills:pdf' }), 'account');
});
test('plugin prefix -> plugin', () => {
  assert.equal(classifySource({ ...o, id: 'harness-kit:play' }), 'plugin');
});
test('path under plugin root -> plugin', () => {
  assert.equal(classifySource({ ...o, id: 'x', path: 'C:/p/plugins/cache/a/skills/x/SKILL.md' }), 'plugin');
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
  assert.deepEqual(['project', 'plugin', 'account', 'builtin', 'unknown'].filter(canPropose), ['project', 'plugin']);
});
