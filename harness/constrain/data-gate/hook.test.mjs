import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mod, { handle } from './hook.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-'));
const data = path.join(tmp, 'data');
fs.mkdirSync(path.join(data, 'audit'), { recursive: true });
fs.writeFileSync(path.join(data, 'x.json'), '{}');
const env = { HUB_DATA_DIR: data };
const cfg = { enabled: true, allow: [] };
const call = (tool_name, tool_input, c = cfg, e = env) => handle('PreToolUse', { tool_name, tool_input, cwd: tmp }, { cfg: c, env: e });
const denied = (r) => r.decision === 'deny';

test('deny Read/Write/Edit/Glob/Grep in data', async () => {
  for (const t of ['Read', 'Write', 'Edit', 'NotebookEdit']) assert.ok(denied(await call(t, { file_path: path.join(data, 'x.json') })), t);
  assert.ok(denied(await call('Glob', { pattern: '**/*.json', path: data })));
  assert.ok(denied(await call('Glob', { pattern: path.join(data, '*.json') })));
  assert.ok(denied(await call('Grep', { pattern: 'a', path: data })));
});
test('relative, .. and backslash paths', async () => {
  assert.ok(denied(await call('Read', { file_path: 'data/x.json' })));
  assert.ok(denied(await call('Read', { file_path: 'data/audit/../x.json' })));
  assert.ok(denied(await call('Read', { file_path: 'other/../data/x.json' })));
  assert.ok(denied(await call('Read', { file_path: data.replace(/\//g, '\\') + '\\x.json' })));
  assert.ok(!denied(await call('Read', { file_path: 'docs/a.md' })));
  assert.ok(!denied(await call('Read', { file_path: path.join(tmp, 'data2', 'a') })));
});
test('symlink into data denied', async (t) => {
  const link = path.join(tmp, 'lnk');
  try { fs.symlinkSync(data, link, 'junction'); } catch { return t.skip('no symlink'); }
  assert.ok(denied(await call('Read', { file_path: path.join(link, 'x.json') })));
});
test('Bash: deny direct, allow gateway', async () => {
  for (const c of ['cat data/x.json', 'type data\\x.json', 'Get-Content ./data/x.json', 'rm -rf data/audit', 'echo hi >> data/a.log', `cp ${data}/x.json /tmp/y`, 'node -e "require(\'fs\').readFileSync(\'data/x\')"'])
    assert.ok(denied(await call('Bash', { command: c })), c);
  for (const c of ['node harness/cli/harness.mjs data ls', 'cd x && node harness/cli/harness.mjs observe data/x', 'node "harness/tools/sync.mjs" --check', 'git status', 'cat harness/data/x.txt', 'cat docs/data-notes.md'])
    assert.ok(!denied(await call('Bash', { command: c })), c);
});
test('Bash: false positives allowed, cwd-aware', async () => {
  for (const c of ['node --test harness/observe/storage/data.test.mjs', 'bun test harness/observe/storage/data.test.mjs', 'node harness/observe/storage/data.mjs', 'ls harness/observe/storage/', 'grep -n foo harness/observe/storage/data.mjs', 'cat data.mjs'])
    assert.ok(!denied(await call('Bash', { command: c })), c);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-other-'));
  const r = await handle('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls data/' }, cwd: other }, { cfg, env });
  assert.ok(!denied(r), 'data/ cua du an khac');
  const sub = path.join(data, 'audit');
  assert.ok(denied(await handle('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls ../audit | head' }, cwd: sub }, { cfg, env })));
  assert.ok(denied(await handle('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'cat x.json' }, cwd: data }, { cfg, env })));
  assert.ok(denied(await call('Bash', { command: 'ls ../data/' })) === false); // ../data tu tmp = ngoai dataDir
});
test('Bash: bien the cong harness duoc phep, doc data van chan', async () => {
  for (const c of ['timeout 120 node harness/cli/harness.mjs data scan | head -n 60', 'cd "E:/my ws" && node harness/cli/harness.mjs data clean', 'node "E:/my ws/harness/cli/harness.mjs" data stat', 'node E:\\x\\harness\\cli\\harness.mjs data ls | head', 'timeout 60 node harness/cli/harness.mjs data ls 2>&1 | tail -5'])
    assert.ok(!denied(await call('Bash', { command: c })), c);
  for (const c of ['node harness/cli/harness.mjs data ls x && cat data/x', 'timeout 5 cat data/x.json', 'node -e "require(\'fs\').readFileSync(\'data/x\')" harness/', 'cd x && cat data/x.json | head'])
    assert.ok(denied(await call('Bash', { command: c })), c);
});
test('Bash: ten data-*, quote git/echo, grep pattern khong bi chan', async () => {
  for (const c of ['ls harness/data-registry.mjs', 'rm data-scan.json', 'ls data-check/', 'cat docs/my-data.md', 'cat x.data', 'git add harness/x/data-registry.mjs', 'git commit -m "fix | cat data/x"', 'git commit -m "a; rm -rf data/x" -- f.mjs', 'git log --grep="data/" | head', 'echo "cat data/x.json"', "printf 'rm data/x'", 'git status docs/', 'git diff -- harness/a.mjs', 'grep -rn "data/foo" harness', 'grep -e "data/x" -r harness', 'ls $H/data', 'rm $m/data'])
    assert.ok(!denied(await call('Bash', { command: c })), c);
  for (const c of ['git commit -m "ok" && cat data/x.json', 'echo hi | cat data/x.json', 'grep -rn foo data/', 'grep "data/x" data/x.json', 'ls data-check/ ; rm data/x.json', 'git commit -m "a | b" && rm data/x.json', 'cat data/x.json > o.txt'])
    assert.ok(denied(await call('Bash', { command: c })), c);
});
test('Bash: git thao tac duong dan trong data', async () => {
  const d = data.replace(/\\/g, '/');
  for (const c of [`git add ${d}/x.json`, `git add -A ${d}`, `git rm ${d}/x.json`, `git mv ${d}/a ${d}/b`, `git checkout -- ${d}/x`, `git restore ${d}/x`, `git clean -fd ${d}`, `git stash push ${d}/x`, `git status ${d}/`, `git diff -- ${d}/x.json`, `git log -- ${d}/x`, `git show HEAD:${d}/x`, `git reset -- ${d}/x`, `git update-index --assume-unchanged ${d}/x`, `git -C . add "${d}/x.json"`])
    assert.ok(denied(await call('Bash', { command: c })), c);
  assert.ok(denied(await handle('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git add .' }, cwd: data }, { cfg, env })));
  for (const c of ['git add harness/x.mjs', 'git add -A', 'git commit -m "x data/y" -F msg.txt', 'git status', 'git diff -- docs/a.md', 'git stash', 'git checkout main'])
    assert.ok(!denied(await call('Bash', { command: c })), c);
});
test('allowlist', async () => {
  const c = { enabled: true, allow: ['public'] };
  assert.ok(!denied(await call('Read', { file_path: path.join(data, 'public', 'a') }, c)));
  assert.ok(denied(await call('Read', { file_path: path.join(data, 'x.json') }, c)));
});
test('HARNESS_GATEWAY=1, disabled, fail-open', async () => {
  assert.deepEqual(await call('Read', { file_path: path.join(data, 'x.json') }, cfg, { ...env, HARNESS_GATEWAY: '1' }), {});
  assert.deepEqual(await call('Read', { file_path: path.join(data, 'x.json') }, { enabled: false, allow: [] }), {});
  assert.deepEqual(await handle('PreToolUse', { tool_name: 'Read', tool_input: { file_path: {} } }, { cfg: { allow: 5 }, env }), {});
  assert.deepEqual(await handle('PreToolUse', null, { cfg, env }), {});
  assert.deepEqual(await handle('PreToolUse', { tool_name: 'Read' }, { cfg: null === 1, env }), {});
});
test('Bash: cong plugin (harness, bin/harness) duoc qua, doc thang data van chan', async () => {
  for (const c of ['harness data', 'harness data ls', 'harness data ls | head -20', 'timeout 60 harness data ls 2>&1 | tail -5', 'harness.cmd data stat', 'node bin/harness.mjs data', 'node bin/harness.mjs data ls', 'bun bin/harness.mjs data ls', 'node "E:/06. Projects/harness-kit/bin/harness" data ls', 'node E:/kit/bin/harness data ls', 'node ${CLAUDE_PLUGIN_ROOT}/bin/harness data ls', 'node "${CLAUDE_PLUGIN_ROOT}/bin/harness" data scan', 'node harness/cli/harness.mjs data ls', 'cd x && harness data ls'])
    assert.ok(!denied(await call('Bash', { command: c })), c);
  for (const c of ['cat data/x.json', 'ls data/', 'rg foo data/', 'rm data/x.json', 'mv data/x.json y', 'harness data ls && cat data/x.json', 'node bin/harness.mjs data ls; rm data/x.json', 'harness data $(cat data/x.json)', 'node bin/harness.mjs data > data/x.json', 'node bin/other.mjs data/x.json', 'node bin/harness-evil.mjs data/x.json', 'harnessx data/x.json; cat data/x.json'])
    assert.ok(denied(await call('Bash', { command: c })), c);
});
test('Bash: cat data/x.json theo che do (enabled chan, disabled qua)', async () => {
  assert.ok(denied(await call('Bash', { command: 'cat data/x.json' })));
  assert.deepEqual(await call('Bash', { command: 'cat data/x.json' }, { enabled: false, allow: [] }), {});
});
test('thong diep theo ngu canh: plugin mode (.harness/data, harness) va hub co launcher (data/, node bin/harness.mjs)', async () => {
  const pw = fs.mkdtempSync(path.join(os.tmpdir(), 'dgp-'));
  fs.mkdirSync(path.join(pw, '.harness', 'data'), { recursive: true });
  const pe = { CLAUDE_PROJECT_DIR: pw, CLAUDE_PLUGIN_ROOT: '/kit' };
  const rp = await handle('PreToolUse', { tool_name: 'Read', tool_input: { file_path: path.join(pw, '.harness', 'data', 'x.json') }, cwd: pw }, { cfg, env: pe });
  assert.ok(denied(rp));
  assert.match(rp.reason, /\.harness\/data\//);
  assert.match(rp.reason, /Dung cong: harness data/);
  assert.doesNotMatch(rp.reason, /bin\/harness\.mjs/);
  const hw = fs.mkdtempSync(path.join(os.tmpdir(), 'dgh-'));
  fs.mkdirSync(path.join(hw, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(hw, 'bin', 'harness.mjs'), '');
  const he = { HUB_DIR: hw };
  const rh = await handle('PreToolUse', { tool_name: 'Read', tool_input: { file_path: path.join(hw, 'data', 'x.json') }, cwd: hw }, { cfg, env: he });
  assert.ok(denied(rh));
  assert.match(rh.reason, /thang data\//);
  assert.match(rh.reason, /node bin\/harness\.mjs data/);
  assert.doesNotMatch(rh.reason, /\.harness\/data/);
});
test('module shape', () => { assert.equal(mod.id, 'data-gate'); assert.deepEqual(mod.events, ['PreToolUse']); });
test('real dispatcher end-to-end', () => {
  const run = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'dispatch', 'run.mjs');
  const go = (ti) => spawnSync(process.execPath, [run, 'PreToolUse'], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'dgtest', tool_name: 'Read', tool_input: ti, cwd: tmp }), encoding: 'utf8', timeout: 8000, env: { ...process.env, HUB_DATA_DIR: data, CLAUDE_AUDIT_DIR: path.join(tmp, 'audit-zz'), HARNESS_GATEWAY: '' } });
  assert.match(go({ file_path: path.join(data, 'x.json') }).stdout, /data-gate/);
  assert.doesNotMatch(go({ file_path: path.join(tmp, 'ok.md') }).stdout, /data-gate/);
});
test('Bash: wrapper, $(...), backtick, dau cach, cd, exemption chat', async () => {
  const d = data.replace(/\\/g, '/');
  for (const c of ['echo "$(cat data/audit/x)"', 'git commit -m "$(cat data/x)"', 'bash -c "cat data/x"', "sh -c 'cat data/x'", 'powershell -Command "Get-Content data/x"', 'pwsh -c "gc data/x"', 'cmd /c type data\\x', `cat "${d}/audit/x"`, `cat "${data}\\audit\\x"`, `cat ${data.replace(/ /g, '\\ ')}\\audit\\x`, 'node a.js data/x harness/', 'node harness/x.mjs $(cat data/x)', 'echo `cat data/x`', 'bash -c "bash -c \'cat data/x\'"', 'cd data && cat x', 'pushd data; type x'])
    assert.ok(denied(await call('Bash', { command: c })), c);
  for (const c of ['bash -c "cat harness/x"', 'cd harness && cat x', 'timeout 20 node harness/cli/harness.mjs data ls', 'bash -c "node harness/cli/harness.mjs data ls"'])
    assert.ok(!denied(await call('Bash', { command: c })), c);
});
