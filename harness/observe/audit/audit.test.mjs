import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { auditRoot } from './defaults.mjs';
import { dataPathFor } from '../../core/io/storage.mjs';
import { buildEnvelope, readAuditConfig, partitionFile, writeEnvelope } from './audit.mjs';
import { compile, redact, sanitizeSession } from './redact.mjs';

const cfg = readAuditConfig();
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'audit.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'audit-t-'));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const run = (input, root) => spawnSync(process.execPath, [script], { input, env: { ...process.env, CLAUDE_AUDIT_DIR: root } });

test('redacts secrets', () => {
  const res = compile(cfg.redact);
  const s = redact('curl -H "Authorization: Bearer abc" token=xyz sk-abcdefgh12 ghp_abcdefgh1234 123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA eyJhbGciOi.eyJzdWIiOi.sig https://a.com/p?x=1', res);
  for (const bad of ['abc"', 'xyz', 'sk-abcdefgh12', 'ghp_abcdefgh1234', 'AAAAAAAAAA', 'eyJhbGciOi', 'x=1']) expect(s).not.toContain(bad);
  expect(s).toContain('https://a.com/p');
});
test('partition path', () => {
  const root = tmp();
  const env = buildEnvelope({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } }, cfg, new Date('2026-01-02T03:04:05Z'));
  writeEnvelope(env, cfg, root);
  expect(fs.existsSync(path.join(root, 'date=2026-01-02', 'type=tool', 'claude-s1.jsonl'))).toBe(true);
});
test('unknown event -> other', () => {
  expect(buildEnvelope({ hook_event_name: 'BrandNewEvent', session_id: 'x' }, cfg).type).toBe('other');
});
test('malicious session id sanitized', () => {
  expect(sanitizeSession('../../etc/passwd')).toBe('etcpasswd');
  expect(sanitizeSession('../..')).toBe('nosession');
  expect(sanitizeSession('a'.repeat(100)).length).toBe(64);
  const root = tmp();
  run(JSON.stringify({ hook_event_name: 'SessionStart', session_id: '../../evil' }), root);
  const files = walk(root);
  expect(files.length).toBe(1);
  for (const f of files) expect(f.startsWith(root)).toBe(true);
});
test('broken/empty stdin -> exit 0, no output, no files', () => {
  const root = tmp();
  for (const i of ['', '{bad', 'null', '[]']) {
    const r = run(i, root);
    expect(r.status).toBe(0);
    expect(r.stdout.length + r.stderr.length).toBe(0);
  }
  expect(walk(root).length).toBe(0);
});
test('no content written', () => {
  const root = tmp();
  run(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'c', tool_name: 'Edit', tool_input: { file_path: 'E:/x/.env', old_string: 'SECRETOLD', new_string: 'SECRETNEW' }, tool_response: 'RESP' }), root);
  run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'c', prompt: 'my private prompt' }), root);
  const all = walk(root).map((f) => fs.readFileSync(f, 'utf8')).join('');
  for (const bad of ['SECRETOLD', 'SECRETNEW', 'RESP', 'private prompt', 'E:/x']) expect(all).not.toContain(bad);
  expect(all).toContain('"target":".env"');
  expect(all).toContain('"prompt_len":17');
});
test('rotation by size', () => {
  const root = tmp();
  const env = buildEnvelope({ hook_event_name: 'PreToolUse', session_id: 'r', tool_name: 'Bash', tool_input: { command: 'ls' } }, cfg);
  const small = { ...cfg, max_file_bytes: 300 };
  for (let i = 0; i < 10; i++) writeEnvelope(env, small, root);
  const names = fs.readdirSync(path.dirname(partitionFile(root, env, 300))).sort();
  expect(names).toContain('claude-r.jsonl');
  expect(names).toContain('claude-r.1.jsonl');
});
test('concurrent writers keep lines intact', async () => {
  const root = tmp();
  const url = 'file:///' + script.replace(/\\/g, '/');
  const code = `import {buildEnvelope,readAuditConfig,writeEnvelope} from ${JSON.stringify(url)};
const c=readAuditConfig();const e=buildEnvelope({hook_event_name:'PreToolUse',session_id:'cc',tool_name:'Bash',tool_input:{command:'x'.repeat(150)}},c);
for(let i=0;i<300;i++)writeEnvelope(e,c,process.env.CLAUDE_AUDIT_DIR);`;
  const f = path.join(root, 'w.mjs');
  fs.writeFileSync(f, code);
  await Promise.all([1, 2].map(() => new Promise((r) => spawn(process.execPath, [f], { env: { ...process.env, CLAUDE_AUDIT_DIR: root } }).on('close', r))));
  const lines = walk(root).filter((x) => x.endsWith('.jsonl')).flatMap((x) => fs.readFileSync(x, 'utf8').split('\n').filter(Boolean));
  expect(lines.length).toBe(600);
  for (const l of lines) JSON.parse(l);
});

// --- config layering: must work with missing / broken / partial audit.config.json ---
import { loadAuditConfig, configFiles, DEFAULTS } from './defaults.mjs';
const evIn = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'cfgt', tool_name: 'Bash', tool_input: { command: 'echo hi' } });
function withCfg(content, fn) {
  const f = configFiles()[0];
  const had = fs.existsSync(f);
  const orig = had ? fs.readFileSync(f) : null;
  if (had) fs.rmSync(f, { force: true });
  try {
    if (content !== null) fs.writeFileSync(f, content);
    fn();
  } finally {
    fs.rmSync(f, { force: true });
    if (had && orig !== null) fs.writeFileSync(f, orig);
  }
}
for (const [name, content] of [['missing', null], ['broken', '{nope'], ['partial', '{"retention_days": 7}']]) {
  test(`audit works with config ${name}`, () => {
    withCfg(content, () => {
      const c = loadAuditConfig().config;
      expect(c.retention_days).toBe(name === 'partial' ? 7 : DEFAULTS.retention_days);
      expect(c.events.PostToolUse).toBe('tool');
      expect(c.redact.length).toBeGreaterThan(0);
      const root = tmp();
      expect(run(evIn, root).status).toBe(0);
      const line = JSON.parse(fs.readFileSync(walk(root).find((f) => f.endsWith('cfgt.jsonl')), 'utf8').trim());
      expect(line.type).toBe('tool'); expect(line.target).toBe('echo hi'); expect(line.v).toBe(2);
    });
  });
}

const withEnv = (env, fn) => {
  const keys = ['CLAUDE_AUDIT_DIR', 'HUB_DATA_DIR', 'HUB_DIR'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  try { return fn(); } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};
const hubDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('auditRoot: default is <hub>/data/audit', () => {
  withEnv({}, () => expect(auditRoot()).toBe(dataPathFor('audit', { quiet: true })));
});
test('auditRoot: CLAUDE_AUDIT_DIR overrides', () => {
  expect(withEnv({ CLAUDE_AUDIT_DIR: '/x/y', HUB_DATA_DIR: '/h' }, auditRoot)).toBe('/x/y');
});
test('auditRoot: HUB_DATA_DIR works', () => {
  expect(withEnv({ HUB_DATA_DIR: '/h/data' }, auditRoot)).toBe(path.resolve('/h/data', 'system', 'audit'));
});

test('redact: user:pass@host, JSON token/password, ghp_, sk-, Bearer, ?token=', () => {
  const res = compile(cfg.redact);
  const out = redact('postgres://admin:hunter2@db.local/x {"token": "abc123", "password":"p w"} ghp_abcdefgh1234 sk-abcdefgh12 Bearer abcdef123 https://a.com/p?token=zzz', res);
  for (const leak of ['hunter2', 'abc123', 'p w', 'ghp_abcdefgh1234', 'sk-abcdefgh12', 'abcdef123', 'token=zzz']) expect(out).not.toContain(leak);
});
test('redact: regex hong ghi canh bao stderr mot lan, khong nuot im', () => {
  const orig = process.stderr.write; let n = 0; let msg = '';
  process.stderr.write = (m) => { n++; msg += m; return true; };
  try { const r = compile(['([bad-unique-1', 'ok']); compile(['([bad-unique-1']); expect(r.length).toBe(1); } finally { process.stderr.write = orig; }
  expect(n).toBe(1); expect(msg).toContain('bad-unique-1');
});

test('buildEnvelope: HUB_RUN_ID => origin dispatch + data.run_id', async () => {
  const { buildEnvelope } = await import('./audit.mjs');
  const e = buildEnvelope({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/x' }, {}, new Date(), { env: { HUB_RUN_ID: 'claude-t-1' } });
  expect(e.origin).toBe('dispatch');
  expect(e.data.run_id).toBe('claude-t-1');
});

test('Bash: ghi has_timeout, bg, cmd_line (dong dau)', () => {
  const mk = (ti) => buildEnvelope({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: ti, session_id: 's1', cwd: '/x' }, cfg).data;
  const a = mk({ command: 'ls -la\nsecond line', timeout: 5000 });
  expect(a.has_timeout).toBe(5000);
  expect(a.bg).toBe(false);
  expect(a.cmd_line).toBe('ls -la');
  const b = mk({ command: 'sleep 1', run_in_background: true });
  expect(b.has_timeout).toBeNull();
  expect(b.bg).toBe(true);
});
