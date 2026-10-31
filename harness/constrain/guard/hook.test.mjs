import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, load, evaluate, configFiles } from './hook.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hook.mjs');
const CORE = [path.join(path.dirname(HOOK), 'hook.config.json')]; // bo qua hook.config.local.json cua may
const emptyHub = fs.mkdtempSync(path.join(os.tmpdir(), 'guardempty-'));
const cfg = load(CORE, { env: {}, hubRoot: emptyHub }).config; // chi lop chung (khong lop may/du an cua hub that)
const ev = (c) => evaluate(c, cfg)?.id ?? null;
const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'guardhub-'));
fs.mkdirSync(path.join(hub, 'config', 'guard'), { recursive: true });
fs.writeFileSync(path.join(hub, 'config', 'guard', 'demo.json'), JSON.stringify({
  remoteHostAliases: ['my-host'],
  sensitiveFileNames: ['app.js', 'ecosystem.config.js', 'config.json', 'config.js', 'config.ts'],
  denyPatterns: [{ id: 'demo-rule', pattern: 'forbiddenword', reason: 'demo' }, { id: 'mongo-uri', disable: true }, { id: 'mongo-cli', pattern: 'zzz', reason: 'x' }],
  weird: 1,
}));
const pk = load(CORE, { env: { GUARD_PROJECT: 'demo' }, hubRoot: hub });
const pcfg = pk.config;
const pev = (c) => evaluate(c, pcfg)?.id ?? null;

// [command, expected id or null]
const TABLE = [
  ['mongosh "x"', 'mongo-cli'],
  ["ssh my-host 'mongosh --eval \"db.users.find()\"'", 'mongo-cli'],
  ['ssh other-host "mongodump --out /tmp/x"', 'mongo-cli'],
  ['MONGOEXPORT --db a', 'mongo-cli'],
  ['mongoimport --file a.json && echo ok', 'mongo-cli'],
  ['mongorestore dump/', 'mongo-cli'],
  ['mongostat 1', 'mongo-cli'],
  ['mongo --quiet', 'mongo-cli'],
  ['echo mongodb://u:p@host/db', 'mongo-uri'],
  ["node -e \"require('x')('mongodb+srv://a')\"", 'mongo-uri'],
  ["ssh third-host 'node -e \"mongoose.connect(process.env.X)\"'", 'mongo-driver'],
  ["bash -c 'node -e \"new MongoClient(u)\"'", 'mongo-driver'],
  ['node --eval "mongoose.createConnection(a)"', 'mongo-driver'],
  ["ssh fourth-host 'psql -c \"select 1\"'", 'db-cli-remote'],
  ['ssh my-host "mysql -e \'show databases\'"', 'db-cli-remote'],
  ['ssh my-host redis-cli keys "*"', 'db-cli-remote'],
  ["ssh other-host 'cat /var/log/syslog'", 'remote-cat'],
  ['ssh my-host "cat a.txt && cat b.txt"', 'remote-cat'],
  ["ssh my-host 'node app.js'", 'remote-node-run'],
  ["ssh my-host 'cd /srv && bun server.ts'", 'remote-node-run'],
  ['ssh fourth-host "node /srv/x/seed.js"', 'remote-node-run'],
  ["ssh my-host <<'EOF'\nnode seed.js\nEOF", 'remote-node-run'],
  ['ssh my-host "pm2 list" && ssh my-host "node run.mjs"', 'remote-node-run'],
  ['ssh my-host "mongosh" ; echo done', 'mongo-cli'],

  ['git status', null],
  ['git diff --stat', null],
  ['git log --oneline -5', null],
  ['git apply --check a.patch', null],
  ["ssh my-host 'cd /srv/app && git diff --stat'", null],
  ["ssh my-host 'sha256sum /srv/app/app.js'", null],
  ["ssh my-host 'cat /srv/app/app.js | sha256sum'", null],
  ["ssh my-host 'cat /srv/app/ecosystem.config.js | wc -c'", null],
  ["ssh my-host 'stat -c %s /srv/app/app.js'", null],
  ["ssh my-host 'ls -la /srv/app | head -20'", null],
  ["ssh my-host 'grep -n listen /srv/app/app.js | head -5'", null],
  ["ssh my-host 'tail -n 20 /var/log/x.log'", null],
  ["ssh my-host 'pm2 list'", null],
  ["ssh my-host 'pm2 describe api'", null],
  ["ssh my-host 'pm2 logs api --nostream --lines 20'", null],
  ["ssh my-host 'pm2 reload api'", null],
  ["ssh my-host 'sleep 3 && echo ok'", null],
  ["ssh my-host 'echo hello'", null],
  ["ssh my-host 'node --check /srv/app/app.js'", null],
  ["ssh my-host 'node -v'", null],
  ["ssh my-host 'node -e \"JSON.parse(1)\"'", null],
  ['curl --max-time 5 http://localhost:3000/health', null],
  ['curl --max-time 5 -s http://127.0.0.1:8080/', null],
  ['node harness/tools/port/port.mjs plan --host my-host', null],
  ['node harness/tools/port/port.mjs apply', null],
  ['node --test harness/constrain/guard/hook.test.mjs', null],
  ['node harness/cli/harness.mjs projects resolve my-project', null],
  ['rg -n foo src | head -20', null],
  ['PowerShell -Command "Get-ChildItem | Select -First 5"', null],
  ['', null],
];

for (const [cmd, id] of TABLE) {
  test(`${id ? 'deny ' + id : 'allow'}: ${cmd.slice(0, 50).replace(/\n/g, ' ')}`, () => {
    assert.equal(ev(cmd), id);
  });
}

test('core khong chua du lieu du an', () => {
  assert.deepEqual(cfg.remoteHostAliases, []);
  assert.ok(!/app\\\.js/.test(cfg.denyPatterns.find((p) => p.id === 'config-dump')?.regex || '')); // config-dump chi co mac dinh, khong ten du an
  assert.ok(!/my-host|fourth-host|third-host|other-host|app\.js/.test(fs.readFileSync(path.join(path.dirname(HOOK), 'hook.config.json'), 'utf8')));
});

test('du an sach (khong cau hinh): config-dump mac dinh trong code van chan .env/khoa/credential', () => {
  for (const c of ['cat .env', 'cat ./.env', 'type .env.local', 'head -5 config/.env.production', 'cat ~/.ssh/id_rsa', 'cat server.key', 'less certs/tls.pem', 'cat ~/.aws/credentials', 'cat .npmrc', 'Get-Content "C:\\x\\.env"', "bash -c 'cat .env'"]) assert.equal(ev(c), 'config-dump', c);
  for (const c of ['cat .env.example', 'cat .env.sample', 'cat ./config/.env.template', 'cat README.md', 'cat .envrc', 'cat src/keyboard.js', 'cat .env | sha256sum', 'wc -c .env', 'cat docs/credentials-guide.md', 'git diff .env.example']) assert.equal(ev(c), null, c);
});

test('goi du an: config-dump + luat rieng + disable + khoa la canh bao', () => {
  for (const c of ['cat .env', 'cat id_rsa', 'cat .env.sample']) assert.equal(pev(c), c === 'cat .env.sample' ? null : 'config-dump', c); // mac dinh van con khi co ten rieng
  for (const c of ['cat app.js', "ssh my-host 'cat /srv/app/ecosystem.config.js'", 'type .env', 'Get-Content ./config.json', "ssh my-host \"sed -n '1,40p' app.js\"", 'less /srv/x/.env.production']) assert.equal(pev(c), 'config-dump', c);
  for (const c of ["ssh my-host 'cat /srv/app/app.js | sha256sum'", "ssh my-host 'cat /srv/app/ecosystem.config.js | wc -c'", "ssh my-host 'grep -n listen /srv/app/app.js | head -5'"]) assert.equal(pev(c), null, c);
  assert.equal(pev('cat config.js'), 'config-dump');
  assert.equal(pev('type src/config.ts'), 'config-dump');
  assert.equal(pev('echo forbiddenword'), 'demo-rule');
  assert.equal(ev('echo forbiddenword'), null);
  assert.equal(pev('mongosh'), 'mongo-cli'); // luat chung van con
  assert.equal(pev('echo mongodb://u@h/db'), 'mongo-uri'); // goi KHONG tat duoc loi
  assert.ok(pk.warnings.some((w) => /mongo-uri/.test(w)));
  assert.ok(pk.warnings.some((w) => /weird/.test(w)));
  assert.deepEqual(pcfg.remoteHostAliases, ['my-host']);
});

test('local tat duoc loi, local cao hon goi', () => {
  const lf = path.join(hub, 'local.json');
  fs.writeFileSync(lf, JSON.stringify({ denyPatterns: [{ id: 'mongo-uri', disable: true }, { id: 'demo-rule', disable: true }] }));
  const c = load([CORE[0], lf], { env: { GUARD_PROJECT: 'demo' }, hubRoot: hub }).config;
  assert.equal(evaluate('echo mongodb://u@h/db', c)?.id ?? null, null);
  assert.equal(evaluate('echo forbiddenword', c)?.id ?? null, null);
  assert.equal(evaluate('mongosh', c)?.id, 'mongo-cli');
});

test('goi thieu/hong -> luat chung van ap + canh bao, khong throw', () => {
  const r = load(undefined, { env: { GUARD_PROJECT: 'nope' }, hubRoot: hub });
  assert.ok(r.warnings.some((w) => /thieu/.test(w)));
  assert.equal(evaluate('mongosh', r.config)?.id, 'mongo-cli');
  fs.writeFileSync(path.join(hub, 'config', 'guard', 'bad.json'), '{oops');
  const b = load(undefined, { env: { GUARD_PROJECT: 'bad' }, hubRoot: hub });
  assert.ok(b.warnings.length > 0);
  assert.equal(evaluate('mongosh', b.config)?.id, 'mongo-cli');
  assert.ok(load(undefined, { env: { GUARD_PROJECT: '../x' }, hubRoot: hub }).warnings.some((w) => /khong hop le/.test(w)));
});

test('local o vi tri moi duoc nap; fallback cu canh bao; thieu ca hai van chay loi', () => {
  const h2 = fs.mkdtempSync(path.join(os.tmpdir(), 'guardhub2-'));
  const nf = configFiles(h2);
  assert.equal(nf[1], path.join(h2, 'config', 'guard', 'guard.local.json'));
  assert.ok(!load(nf, { env: {}, hubRoot: h2 }).warnings.some((w) => /legacy-local-config/.test(w)));
  assert.equal(evaluate('mongo' + 'sh', load(nf, { env: {}, hubRoot: h2 }).config)?.id, 'mongo-cli');
  fs.mkdirSync(path.join(h2, 'config', 'guard'), { recursive: true });
  fs.writeFileSync(nf[1], JSON.stringify({ denyPatterns: [{ id: 'local-x', pattern: 'localxword', reason: 'x' }] }));
  const c = load(configFiles(h2), { env: {}, hubRoot: h2 }).config;
  assert.equal(evaluate('echo localxword', c)?.id, 'local-x');
  const legacy = path.join(path.dirname(HOOK), 'hook.config.local.json');
  const r = load([CORE[0], legacy], { env: {}, hubRoot: h2 });
  assert.ok(r.warnings.some((w) => /legacy-local-config/.test(w)));
});

test('table has >= 40 rows', () => assert.ok(TABLE.length >= 40));

test('PowerShell tool is checked and Claude deny schema is exact', () => {
  const d = decide({ tool_name: 'PowerShell', tool_input: { command: 'mongosh' } }, cfg);
  assert.deepEqual(Object.keys(d.out), ['hookSpecificOutput']);
  assert.equal(d.out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(d.out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(d.out.hookSpecificOutput.permissionDecisionReason, /^guard\[mongo-cli\]: Cam .* \/ /);
});

test('allow -> {} for Claude, other tools ignored', () => {
  assert.deepEqual(decide({ tool_name: 'Bash', tool_input: { command: 'git status' } }, cfg).out, {});
  assert.deepEqual(decide({ tool_name: 'Read', tool_input: { command: 'mongosh' } }, cfg).out, {});
});

test('agy schema: deny and allow', () => {
  const a = { toolCall: { name: 'run_command', args: { CommandLine: 'mongosh' } } };
  assert.equal(decide(a, cfg).out.decision, 'deny');
  assert.deepEqual(decide({ toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } }, cfg).out, { decision: 'allow' });
});

test('audit mode never blocks but records would-block', () => {
  const d = decide({ tool_name: 'Bash', tool_input: { command: 'mongosh' } }, { ...cfg, mode: 'audit' });
  assert.deepEqual(d.out, {});
  assert.equal(d.entry.action, 'would-block');
  assert.ok(d.entry.hash.length === 16);
});

test('fail-open on garbage input / empty command; huge command denied', () => {
  for (const i of [null, 'x', 5, [], {}, { tool_name: 'Bash' }, { tool_name: 'Bash', tool_input: { command: 7 } }]) assert.deepEqual(decide(i, cfg).out, {});
  const huge = 'mongosh ' + 'a'.repeat(200000);
  const dh = decide({ tool_name: 'Bash', tool_input: { command: huge } }, cfg);
  assert.equal(dh.out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(dh.out.hookSpecificOutput.permissionDecisionReason, /command-too-long/);
});

function run(input, env = {}, timeout = 5000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const logFile = path.join(dir, 'g.jsonl');
  const r = spawnSync('node', [HOOK], { input, encoding: 'utf8', timeout, env: { ...process.env, GUARD_LOG_FILE: logFile, ...env } });
  return { r, log: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '' };
}

test('process: deny exits 0 with JSON, logs hash not secrets', () => {
  const { r, log } = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo mongodb://u:SECRETPW@h/db' } }));
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(log, /mongo-uri/);
  const dl = log.split('\n').filter((l) => l && !l.includes('config-warning')).join('\n'); // loai canh bao legacy-config cua may
  assert.ok(!dl.includes('SECRETPW')); // chat: khong co noi dung lenh trong log (thay cho heuristic do dai cu)
  assert.match(log, /"hash":"[0-9a-f]{16}"/);
});

test('process: deny log never contains command content (secrets) in any field', () => {
  const tok = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0';
  const pw = 'Zx9' + 'PwSecretQ';
  const cmd = `echo ${tok} mongodb://admin:${pw}@db.example/x`;
  const { r, log } = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } }));
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(log, /mongo-uri/);
  assert.ok(!log.includes(tok) && !log.includes(pw) && !log.includes('admin:') && !log.includes('echo'));
  assert.match(log, /"hash":"[0-9a-f]{16}"/);
  assert.match(log, new RegExp('"len":' + cmd.length + '\\b'));
});

test('decide: entry has only id/tool/mode/action/hash/len', () => {
  const cmd = 'echo mongodb://u:' + 'Pw123456@h/db';
  const { entry } = decide({ tool_name: 'Bash', tool_input: { command: cmd } }, cfg);
  assert.deepEqual(Object.keys(entry).sort(), ['action', 'hash', 'id', 'len', 'mode', 'tool']);
  assert.ok(!JSON.stringify(entry).includes('Pw123456'));
});

test('process: garbage stdin -> {} exit 0, logged fail-open', () => {
  const { r, log } = run('not json{{');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{}');
  assert.match(log, /fail-open/);
});

test('process: oversize stdin -> {} exit 0', () => {
  const { r } = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'mongosh ' + 'a'.repeat(1100000) } }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{}');
});

test('process: audit mode via env never blocks', () => {
  const { r, log } = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'mongosh' } }), { GUARD_MODE: 'audit' });
  assert.equal(r.stdout, '{}');
  assert.match(log, /would-block/);
});

test('process: stdin never closes -> exits within hard timeout with {}', async () => {
  const { spawn } = await import('node:child_process');
  const t0 = Date.now();
  const out = await new Promise((resolve) => {
    const c = spawn('node', [HOOK], { env: { ...process.env, GUARD_LOG_FILE: path.join(os.tmpdir(), 'guard-to.jsonl') } });
    let s = ''; c.stdout.on('data', (d) => (s += d));
    c.on('close', (code) => resolve({ code, s }));
  });
  assert.equal(out.code, 0);
  assert.equal(out.s, '{}');
  assert.ok(Date.now() - t0 < 4500);
});
