// Test luat cung launcher-protect (mo phong stdin Claude): Write/Edit/MultiEdit/NotebookEdit va Bash sua bin/harness.mjs, config/launcher.local.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, load } from './hook.mjs';

const cfg = () => load().config;
const denied = (inp) => {
  const o = decide(inp, cfg()).out;
  return o.hookSpecificOutput?.permissionDecision === 'deny' && /launcher-protect/.test(o.hookSpecificOutput.permissionDecisionReason);
};
const file = (tool, p) => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: tool === 'NotebookEdit' ? { notebook_path: p } : { file_path: p } });
const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

test('file tools: deny bin/harness.mjs va launcher.local.json (posix + windows)', () => {
  for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    assert.ok(denied(file(t, 'E:\\hub\\bin\\harness.mjs')), t);
    assert.ok(denied(file(t, '/hub/config/launcher.local.json')), t);
  }
});

test('file tools: file khac khong bi chan', () => {
  assert.equal(denied(file('Write', '/hub/bin/other.mjs')), false);
  assert.equal(denied(file('Edit', '/hub/harness/cli/harness.mjs')), false);
});

test('Bash: lenh ghi/xoa/di chuyen bi chan', () => {
  for (const c of ['echo x > bin/harness.mjs', 'sed -i s/a/b/ bin/harness.mjs', 'cp x bin\\harness.mjs', 'Set-Content config/launcher.local.json hi', 'git checkout -- bin/harness.mjs', 'cat config/launcher.local.json']) {
    assert.ok(denied(bash(c)), c);
  }
});

const PJ = 'C:\\Users\\u\\.claude\\plugins\\installed_plugins.json';
const PDIR = '/home/u/.claude/plugins/cache/mkt/agent-guard-kit/1.2.0/harness/constrain/guard/hook.mjs';
const PDIR2 = '/home/u/.claude/plugins/cache/mkt/harness-kit/1.0.0/harness/constrain/guard/hook.mjs';
test('file tools: deny installed_plugins.json, known_marketplaces.json, thu muc plugin guard', () => {
  for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    assert.ok(denied(file(t, PJ)), t);
    assert.ok(denied(file(t, '/home/u/.claude/plugins/installed_plugins.json')), t);
    assert.ok(denied(file(t, '/home/u/.claude/plugins/known_marketplaces.json')), t);
    assert.ok(denied(file(t, PDIR)), t);
    assert.ok(denied(file(t, PDIR2)), t);
    assert.ok(denied(file(t, 'C:\\Users\\u\\.claude\\plugins\\marketplaces\\harness-plugin\\bin\\x.mjs')), t);
  }
  assert.equal(denied(file('Write', '/home/u/.claude/plugins/cache/mkt/other-kit/1.0/a.mjs')), false);
  assert.equal(denied(file('Write', '/home/u/.claude/settings.json')), false);
});

test('Bash: ghi/xoa/sua installed_plugins.json va thu muc plugin guard bi chan', () => {
  for (const c of [
    'echo {} > ~/.claude/plugins/installed_plugins.json',
    'sed -i s/a/b/ "$HOME/.claude/plugins/installed_plugins.json"',
    'cp evil.json C:\\Users\\u\\.claude\\plugins\\installed_plugins.json',
    'Set-Content C:\\Users\\u\\.claude\\plugins\\known_marketplaces.json x',
    `rm -rf ${PDIR}`,
    `echo x >> ${PDIR}`,
    `node -e "require('fs').writeFileSync('/home/u/.claude/plugins/installed_plugins.json','{}')"`,
  ]) assert.ok(denied(bash(c)), c);
});

test('Bash: doc installed_plugins.json / thu muc plugin khong bi chan', () => {
  for (const c of ['cat ~/.claude/plugins/installed_plugins.json', `rg -n guard ${PDIR}`, 'ls ~/.claude/plugins/cache']) assert.equal(denied(bash(c)), false, c);
});

test('Bash: chay launcher binh thuong khong bi chan', () => {
  assert.equal(denied(bash('node bin/harness.mjs doctor')), false);
  assert.equal(denied(bash('node "bin/harness.mjs" hook PreToolUse')), false);
  assert.equal(denied(bash('git status')), false);
});
