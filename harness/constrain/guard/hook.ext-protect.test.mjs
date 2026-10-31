// Guard bao ve dang ky extension (lop may): Edit/Write/Bash cham config/ext/local.json hoac ext register/approve => deny. Mo phong stdin qua spawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hook.mjs');
const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-ext-')), 'g.jsonl');
function run(input) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', timeout: 20000, env: { ...process.env, GUARD_LOG_FILE: log, GUARD_MODE: 'enforce' } });
  try { return JSON.parse(r.stdout || '{}'); } catch { return {}; }
}
const denied = (o) => o.hookSpecificOutput?.permissionDecision === 'deny' && /ext-config-protect/.test(o.hookSpecificOutput.permissionDecisionReason);
const FILE = 'C:\\Users\\u\\.claude\\plugins\\data\\x-kit\\config\\ext\\local.json';

test('Write/Edit/MultiEdit vao file dang ky lop may bi chan (ca duong dan / va \\)', () => {
  for (const tool_name of ['Write', 'Edit', 'MultiEdit']) {
    assert.ok(denied(run({ tool_name, tool_input: { file_path: FILE } })), tool_name);
    assert.ok(denied(run({ tool_name, tool_input: { file_path: '/home/u/hub/config/ext/local.json' } })), tool_name);
  }
});

test('Edit file khac khong bi chan', () => {
  assert.deepEqual(run({ tool_name: 'Edit', tool_input: { file_path: 'E:/hub/harness/cli/harness.mjs' } }), {});
  assert.deepEqual(run({ tool_name: 'Write', tool_input: { file_path: 'E:/hub/config/guard/local.json' } }), {});
});

test('Bash: sua file dang ky hoac ext register/approve bi chan', () => {
  for (const command of [
    'echo {} > config/ext/local.json',
    'powershell -c "Set-Content C:\\\\x\\\\config\\\\ext\\\\local.json x"',
    'node harness/cli/harness.mjs ext register ext/demo',
    'node harness/cli/harness.mjs ext approve demo',
    'node harness/cli/commands/ext-cmd.mjs register x',
  ]) assert.ok(denied(run({ tool_name: 'Bash', tool_input: { command } })), command);
});

test('Bash: ext list/verify va lenh thuong khong bi chan', () => {
  for (const command of ['node harness/cli/harness.mjs ext list', 'node harness/cli/harness.mjs ext verify', 'git status'])
    assert.deepEqual(run({ tool_name: 'Bash', tool_input: { command } }), {}, command);
});

const CMDF = 'harness/cli/commands/ext-cmd.mjs', REGF = 'harness/cli/commands/ext-registry.mjs';
test('Bash: lenh chi doc file ext-cmd/ext-registry KHONG bi chan (ke ca co chu approve)', () => {
  for (const command of [
    `git diff -- ${CMDF}`, `git log -p -- ${REGF}`, `git show HEAD:${CMDF}`, `cat ${CMDF}`,
    `rg -n approve ${CMDF}`, `grep -n "register" ${REGF}`, `git show HEAD:${REGF} | grep -n approve`,
    'bun test harness/cli/commands/ext-registry.test.mjs', 'node --test harness/cli/commands/ext-registry.test.mjs',
  ]) assert.deepEqual(run({ tool_name: 'Bash', tool_input: { command } }), {}, command);
});

test('Bash: lenh ghi/chay approve van bi chan (ca khi tron voi lenh doc)', () => {
  for (const command of [
    `node ${CMDF} approve demo`, `node ${CMDF}`, `bun ${CMDF} list`,
    `node -e "import('./${REGF}').then(m=>m.approve('x',{confirm:()=>true}))"`,
    `sed -i s/a/b/ ${CMDF}`, `echo x > ${REGF}`, `cp evil.mjs ${CMDF}`, `git checkout -- ${REGF}`,
    `cat ${CMDF}; node harness/cli/harness.mjs ext approve demo`,
    `cat ${CMDF} | node ${CMDF} register x`,
    `grep approve ${CMDF} && node ${CMDF} approve x`,
  ]) assert.ok(denied(run({ tool_name: 'Bash', tool_input: { command } })), command);
});

test('audit chi ghi id luat + hash lenh (khong lo duong dan)', () => {
  const t = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => l.includes('ext-config-protect')).join(' ');
  assert.match(t, /ext-config-protect/);
  assert.ok(!t.includes('local.json'));
});
