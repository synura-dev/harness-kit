// bun test harness/observe/audit/adapters/agy.test.mjs
import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(HERE, 'adapters', 'agy.mjs');
const run = (input, root) => spawnSync(process.execPath, [script], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_AUDIT_DIR: root } });

function readAll(dir) {
  let text = '';
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) text += readAll(p);
    else if (p.endsWith('.jsonl')) text += fs.readFileSync(p, 'utf8');
  }
  return text;
}

test('adapters/agy: toolCall PascalCase -> tool_name/tool_input, stdout {}', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyad-'));
  const mk = (toolCall) => JSON.stringify({ toolCall, conversationId: 'conv-xyz', stepIdx: 3, workspacePaths: [root] });
  const r1 = run(mk({ name: 'run_command', args: { CommandLine: 'echo hello' } }), root);
  const r2 = run(mk({ name: 'write_file', args: { Path: 'notes.txt', Content: 'abc' } }), root);
  for (const r of [r1, r2]) {
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
  }
  const lines = readAll(root).trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.length).toBe(2);
  const bash = lines.find((l) => l.tool === 'Bash');
  const write = lines.find((l) => l.tool === 'Write');
  expect(bash.target).toContain('echo hello');
  expect(write.target).toContain('notes.txt');
  expect(bash.sid).toBe('agy-conv-xyz');
});

test('adapters/agy: maps view_file, call_mcp_tool, invoke_subagent, send_message', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyad-'));
  const mk = (toolCall) => JSON.stringify({ toolCall, conversationId: 'conv-map', workspacePaths: [root] });

  // view_file -> Read
  run(mk({ name: 'view_file', args: { Path: 'src/main.js' } }), root);
  // call_mcp_tool -> MCP
  run(mk({ name: 'call_mcp_tool', args: { ServerName: 'notebooklm', ToolName: 'notebook_list' } }), root);
  // invoke_subagent -> Agent
  run(mk({ name: 'invoke_subagent', args: { TypeName: 'builder', Role: 'Subagent Builder', Prompt: 'Fix code' } }), root);
  // send_message -> Agent
  run(mk({ name: 'send_message', args: { Recipient: 'parent-123', Message: 'Done task' } }), root);

  const lines = readAll(root).trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.length).toBe(4);

  const readEv = lines.find((l) => l.tool === 'Read');
  expect(readEv).toBeDefined();
  expect(readEv.target).toContain('src/main.js');

  const mcpEv = lines.find((l) => l.tool === 'MCP');
  expect(mcpEv).toBeDefined();
  expect(mcpEv.target).toBe('notebooklm/notebook_list');
  expect(mcpEv.data.server_name).toBe('notebooklm');
  expect(mcpEv.data.tool_name).toBe('notebook_list');

  const agentEv = lines.find((l) => l.tool === 'Agent' && l.target === 'builder');
  expect(agentEv).toBeDefined();
  expect(agentEv.data.prompt_len).toBe(8);

  const msgEv = lines.find((l) => l.tool === 'Agent' && l.target === 'parent-123');
  expect(msgEv).toBeDefined();
  expect(msgEv.data.prompt_len).toBe(9);
});

test('adapters/agy: captures error status and exit codes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyad-'));
  const mk = (toolCall, extra = {}) => JSON.stringify({ toolCall, conversationId: 'conv-err', workspacePaths: [root], ...extra });

  // Error via exitCode in toolResult
  run(mk({ name: 'run_command', args: { CommandLine: 'cat nonexist' } }, {
    toolResult: { exitCode: 1, output: 'cat: nonexist: No such file\nCommand exited with code 1.' },
  }), root);

  // Error via isError in toolResult
  run(mk({ name: 'view_file', args: { Path: 'bad.txt' } }, {
    toolResult: { isError: true, error: 'File not found' },
  }), root);

  // Error via top-level error string
  run(mk({ name: 'edit_file', args: { Path: 'notes.txt' } }, {
    error: 'Replacement mismatch',
  }), root);

  // False positive check: empty error string is NOT an error
  run(mk({ name: 'view_file', args: { Path: 'ok.txt' } }, {
    error: '',
  }), root);

  const lines = readAll(root).trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.length).toBe(4);

  const okRead = lines.find((l) => l.tool === 'Read' && l.target.includes('ok.txt'));
  expect(okRead.ok).toBe(true);
  expect(okRead.status).toBe('ok');

  const bashErr = lines.find((l) => l.tool === 'Bash');
  expect(bashErr.ok).toBe(false);
  expect(bashErr.status).toBe('error');
  expect(bashErr.data.exit_code).toBe(1);

  const readErr = lines.find((l) => l.tool === 'Read');
  expect(readErr.ok).toBe(false);
  expect(readErr.status).toBe('error');

  const editErr = lines.find((l) => l.tool === 'Edit');
  expect(editErr.ok).toBe(false);
  expect(editErr.status).toBe('error');
});

test('adapters/agy: handles lifecycle events SessionStart, Stop, PostInvocation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyad-'));

  // SessionStart
  run(JSON.stringify({
    hook_event_name: 'SessionStart',
    conversationId: 'sess-start',
    source: 'startup',
    workspacePaths: [root],
  }), root);

  // Stop with duration & tokens
  run(JSON.stringify({
    hook_event_name: 'Stop',
    conversationId: 'sess-stop',
    durationMs: 2500,
    usage: { input_tokens: 500, output_tokens: 150, turns: 3 },
    workspacePaths: [root],
  }), root);

  // PostInvocation with duration & tokens
  run(JSON.stringify({
    hook_event_name: 'PostInvocation',
    conversationId: 'sess-post',
    duration_ms: 1200,
    tokens_in: 800,
    tokens_out: 200,
    turns: 4,
    workspacePaths: [root],
  }), root);

  const lines = readAll(root).trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.length).toBe(3);

  const startEv = lines.find((l) => l.event === 'SessionStart');
  expect(startEv.type).toBe('session');
  expect(startEv.status).toBe('startup');

  const stopEv = lines.find((l) => l.event === 'Stop');
  expect(stopEv.type).toBe('session');
  expect(stopEv.dur_ms).toBe(2500);
  expect(stopEv.tokens_in).toBe(500);
  expect(stopEv.tokens_out).toBe(150);
  expect(stopEv.turns).toBe(3);

  const postEv = lines.find((l) => l.event === 'PostInvocation');
  expect(postEv.type).toBe('session');
  expect(postEv.dur_ms).toBe(1200);
  expect(postEv.tokens_in).toBe(800);
  expect(postEv.tokens_out).toBe(200);
  expect(postEv.turns).toBe(4);
});

test('adapters/agy: stdin rong / rac / mang van in {} exit 0', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyad-'));
  for (const input of ['', 'not json', '[]']) {
    const r = run(input, root);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
  }
});

test('adapters/agy: tu khai bao pid/ppid/argv0/payload_keys (khong ghi gia tri)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyad-'));
  run(JSON.stringify({ conversationId: 'c1', secretField: 'VALUE-XYZ', workspacePaths: [root] }), root);
  const txt = readAll(root);
  const l = JSON.parse(txt.trim().split(String.fromCharCode(10))[0]);
  expect(l.data.agy_raw_event).toBe('');
  expect(typeof l.data.pid).toBe('number');
  expect(typeof l.data.ppid).toBe('number');
  expect(l.data.argv0.length).toBeGreaterThan(0);
  expect(l.data.payload_keys).toContain('secretField');
  expect(txt).not.toContain('VALUE-XYZ');
  const r = run('{broken', root);
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({});
});

test('adapters/agy: suy luan event khi agy khong gui ten (3 payload that)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyinf-'));
  const base = { conversationId: 'conv-inf', lastUserInput: 'hi', modelName: 'm', transcriptPath: 't', workspacePaths: [root], artifactDirectoryPath: 'a' };
  const ps = [base, { ...base, invocationNum: 1, initialNumSteps: 0 }, { ...base, invocationNum: 1, initialNumSteps: 0, executionNum: 1, fullyIdle: true, terminationReason: 'x', error: '' }];
  for (const p of ps) expect(run(JSON.stringify(p), root).status).toBe(0);
  const lines = readAll(root).trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.map((l) => l.event).sort()).toEqual(['SessionStart', 'Stop', 'UserPromptSubmit']);
  for (const l of lines) expect(l.data.event_inferred).toBe(true);
});

test('adapters/agy: has_timeout bang regex (timeout 30 -> 30000, khong -> null)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyad-'));
  const mk = (cmd, step) => JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: cmd } }, conversationId: 'c-to', stepIdx: step, workspacePaths: [root] });
  run(mk('timeout 30 bun test', 1), root);
  run(mk('echo hi', 2), root);
  const lines = readAll(root).trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.find((l) => l.data.cmd_line === 'timeout 30 bun test').data.has_timeout).toBe(30000);
  expect(lines.find((l) => l.data.cmd_line === 'echo hi').data.has_timeout).toBe(null);
});

test('adapters/agy: Pre ghi marker (khong envelope), Post tinh dur_ms theo step_idx', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyad-'));
  const payload = JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'echo hi' } }, conversationId: 'c-dur', stepIdx: 7, workspacePaths: [root] });
  const pre = spawnSync(process.execPath, [script, 'pre'], { input: payload, encoding: 'utf8', env: { ...process.env, CLAUDE_AUDIT_DIR: root } });
  expect(pre.status).toBe(0);
  expect(JSON.parse(pre.stdout)).toEqual({ decision: 'allow' });
  expect(readAll(root)).toBe('');
  await new Promise((r) => setTimeout(r, 60));
  expect(run(payload, root).status).toBe(0);
  const l = JSON.parse(readAll(root).trim());
  expect(l.dur_ms).toBeGreaterThanOrEqual(50);
  expect(l.dur_ms).toBeLessThan(60000);
  // khong co Pre (step khac) -> dur_ms null
  run(payload.replace('"stepIdx":7', '"stepIdx":8'), root);
  const l2 = readAll(root).trim().split('\n').map((x) => JSON.parse(x)).find((x) => x.dur_ms == null);
  expect(l2).toBeTruthy();
});

test('adapters/agy: HUB_AGY_CAPTURE ghi stdin tho (mac dinh tat)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agycap-'));
  const cap = path.join(root, 'cap.jsonl');
  const inp = JSON.stringify({ conversationId: 'c-cap', stepIdx: 1, toolCall: { name: 'run_command', args: { CommandLine: 'echo hi' } }, workspacePaths: [root] });
  run(inp, root);
  expect(fs.existsSync(cap)).toBe(false);
  spawnSync(process.execPath, [script], { input: inp, encoding: 'utf8', env: { ...process.env, CLAUDE_AUDIT_DIR: root, HUB_AGY_CAPTURE: cap } });
  expect(JSON.parse(fs.readFileSync(cap, 'utf8').trim()).toolCall.name).toBe('run_command');
});
