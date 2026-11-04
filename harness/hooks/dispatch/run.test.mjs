// Golden (Dot 5.5): CUNG stdin -> stdout/exit co dinh, ghi lai tu output chuoi hook tach roi truoc 5.3 (stub da xoa) cho cung cac ca.
// `sa` = vet audit ky vong cua chuoi cu (type|event|tool, gate hook:rule:decision); vet moi phai la tap con (dispatcher gop 1 lan, cat chuoi gate sau deny).
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const NEW = path.join(ROOT, 'harness', 'hooks', 'dispatch', 'run.mjs');

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-eq-'));
  const env = { ...process.env, HUB_DATA_DIR: path.join(d, 'data'), CLAUDE_AUDIT_DIR: path.join(d, 'audit'), GUARD_LOG_FILE: path.join(d, 'guard.jsonl'), HUB_DIR: ROOT };
  // Bang role model = du lieu config/models (hub co; plugin repo khong ship) -> neu thieu, dung config tam cung bang role de ket qua golden khong doi theo mode.
  if (!fs.existsSync(path.join(ROOT, 'config', 'models', 'default.json'))) {
    const cfg = path.join(d, 'cfg', 'models'); fs.mkdirSync(cfg, { recursive: true });
    const R = (model, effort, allowOpus) => ({ model, effort, allowOpus });
    fs.writeFileSync(path.join(cfg, 'default.json'), JSON.stringify({ roles: { builder: R('sonnet', 'medium', false), fixer: R('sonnet', 'medium', false), curator: R('sonnet', 'medium', false), reviewer: R('sonnet', 'high', true), planner: R('opus', 'high', true), verifier: R('haiku', 'low', false), scout: R('haiku', 'low', false), 'general-purpose': R('sonnet', 'medium', false), claude: R('sonnet', 'medium', false), Plan: R('sonnet', 'medium', false), Explore: R('haiku', 'low', false), 'claude-code-guide': R('haiku', 'low', false) }, default: { model: 'sonnet', effort: 'medium' }, opusAllowed: ['planner', 'reviewer'], agyMap: { haiku: 'flash', sonnet: 'flash', opus: 'pro' } }));
    env.HARNESS_CONFIG_DIR = path.join(d, 'cfg');
  }
  fs.mkdirSync(env.CLAUDE_AUDIT_DIR, { recursive: true }); // goc audit luon ton tai khi chay that (verify-gate nem neu thieu)
  return { d, env };
}
const spawn = (script, args, input, env) => spawnSync(process.execPath, [script, ...args], { input, env, encoding: 'utf8', timeout: 60000 });
const runNew = (event, input, env, only) => { const r = spawn(NEW, only ? [event, only] : [event], input, env); return { stdout: r.stdout, status: r.status, stderr: r.stderr }; };

const parse = (s) => { try { return s && s.trim() ? JSON.parse(s) : {}; } catch { return { __raw: s }; } };

/** Chu ky audit: cac dong (type|event|tool|gate hook:rule:decision), khong ts/sid/noi dung. */
function signature(dir) {
  const sig = [];
  const walk = (p) => {
    for (const e of fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }) : []) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else if (f.endsWith('.jsonl')) for (const l of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
        try {
          const j = JSON.parse(l);
          const g = j.data && j.data.gate;
          sig.push(g ? `gate|${g.hook}:${g.rule}:${g.decision}` : j.hook === 'guard' ? `guard|${j.id}` : `${j.type}|${j.event}|${j.tool || ''}`);
        } catch {}
      }
    }
  };
  walk(dir);
  return sig.sort();
}
const subset = (a, b) => { const rest = [...b]; for (const x of a) { const i = rest.indexOf(x); if (i < 0) return false; rest.splice(i, 1); } return true; };

const bash = (command, extra = {}) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'eq1', cwd: ROOT, tool_name: 'Bash', tool_input: { command, ...extra } });
const agent = (ti) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'eq1', cwd: ROOT, tool_name: 'Agent', tool_input: ti });
const pre = (permissionDecision, extra = {}) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...(permissionDecision ? { permissionDecision } : {}), ...extra } });

const GUARD_PUSH = 'guard[git-force-push]: Cam git push --force/-f/--force-with-lease/--mirror/--delete/+refspec/:nhanh (ghi de/xoa lich su tu xa). Hoi human, khong tu push. / Destructive git push blocked; ask the human.';

/** Chay dispatcher cho 1 stdin; so voi golden {json, sa}. */
function check(event, input, golden, { only, seed } = {}) {
  const b = sandbox();
  if (seed) seed(b.env);
  const neu = runNew(event, input, b.env, only);
  expect(neu.status, neu.stderr).toBe(0);
  expect(parse(neu.stdout)).toEqual(golden.json);
  const sb = signature(b.env.CLAUDE_AUDIT_DIR);
  expect(subset(sb, golden.sa), `vet ${JSON.stringify(sb)} khong la tap con golden ${JSON.stringify(golden.sa)}`).toBe(true);
  return { neu, sb, env: b.env };
}
const decisionOf = (r) => parse(r.neu.stdout).hookSpecificOutput;

test('PreToolUse Bash: ls -> chen timeout (updatedInput), co vet audit', () => {
  const r = check('PreToolUse', bash('ls'), { json: pre(null, { updatedInput: { command: 'ls', timeout: 120000 } }), sa: ['tool|PreToolUse|Bash'] });
  expect(r.sb.some((x) => x.startsWith('tool|PreToolUse'))).toBe(true);
}, 60000);

test('PreToolUse Bash: da co timeout -> {} (khong y kien)', () => {
  check('PreToolUse', bash('ls', { timeout: 5000 }), { json: {}, sa: ['tool|PreToolUse|Bash'] });
}, 60000);

test('PreToolUse Bash: force push -> deny (guard); approval khong chay sau deny', () => {
  const r = check('PreToolUse', bash('git push --force origin main'), { json: pre('deny', { permissionDecisionReason: GUARD_PUSH }), sa: ['gate|approval:git-force-push:deny', 'tool|PreToolUse|Bash'] });
  expect(fs.readFileSync(r.env.GUARD_LOG_FILE, 'utf8')).toContain('git-force-push'); // nhat ky guard di qua records, ghi 1 lan
}, 60000);

test('PreToolUse Bash: git push -> ask + updatedInput timeout (approval + bash-guard)', () => {
  check('PreToolUse', bash('git push origin main'), {
    json: pre('ask', { permissionDecisionReason: 'approval[git-push]: git push can nguoi duyet. / git push needs human approval.', updatedInput: { command: 'git push origin main', timeout: 120000 } }),
    sa: ['gate|approval:git-push:ask', 'tool|PreToolUse|Bash'],
  });
}, 60000);

test('PreToolUse Bash: rm -rf thu muc -> deny (approval)', () => {
  check('PreToolUse', bash('rm -rf some-dir-that-does-not-matter'), {
    json: pre('deny', { permissionDecisionReason: 'approval[recursive-delete]: xoa thu muc/de quy (khong dem duoc so file)' }),
    sa: ['gate|approval:recursive-delete:deny', 'tool|PreToolUse|Bash'],
  });
}, 60000);

test('PreToolUse Bash: python - (heredoc) -> deny (bash-guard)', () => {
  check('PreToolUse', bash('python - <<EOF\nprint(1)\nEOF'), {
    json: pre('deny', { permissionDecisionReason: 'bash-guard: python doc stdin (python -). Write file vao scratchpad roi chay (khong dung python - / python -c nhieu dong / heredoc dai).' }),
    sa: ['tool|PreToolUse|Bash'],
  });
}, 60000);

test('PreToolUse Agent: thieu model -> allow + updatedInput model', () => {
  const r = check('PreToolUse', agent({ prompt: 'p', subagent_type: 'verifier' }), {
    json: pre('allow', { permissionDecisionReason: 'model-policy: vai tro verifier -> haiku', updatedInput: { prompt: 'p', subagent_type: 'verifier', model: 'haiku' } }),
    sa: ['gate|model-policy:model-filled:allow', 'tool|PreToolUse|Agent'],
  });
  expect(decisionOf(r).updatedInput.model).toBe('haiku');
}, 60000);

test('PreToolUse Agent: opus ngoai chinh sach -> ask; sonnet -> {}', () => {
  check('PreToolUse', agent({ prompt: 'p', subagent_type: 'verifier', model: 'opus' }), {
    json: pre('ask', { permissionDecisionReason: 'model-policy: vai tro verifier mac dinh haiku, khong phai opus' }),
    sa: ['gate|model-policy:opus-not-allowed:ask', 'tool|PreToolUse|Agent'],
  });
  check('PreToolUse', agent({ prompt: 'p', subagent_type: 'verifier', model: 'sonnet' }), { json: {}, sa: ['tool|PreToolUse|Agent'] });
}, 60000);

test('PreToolUse tool khac (Read): chi audit, {}', () => {
  const r = check('PreToolUse', JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'eq1', cwd: ROOT, tool_name: 'Read', tool_input: { file_path: 'x.txt' } }), { json: {}, sa: ['tool|PreToolUse|Read'] });
  expect(r.sb.some((x) => x.startsWith('tool|PreToolUse'))).toBe(true);
}, 60000);

test('PostToolUse Bash (test pass): {} + 1 ban ghi audit', () => {
  const input = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'eq1', cwd: ROOT, tool_name: 'Bash', tool_input: { command: 'bun test x' }, tool_response: { stdout: '1 pass\n0 fail', interrupted: false } });
  const r = check('PostToolUse', input, { json: {}, sa: ['tool|PostToolUse|Bash'] });
  expect(r.sb.length).toBe(1);
}, 60000);

const editEvent = (cwd) => JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'eqstop', cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src', 'a.js') }, tool_response: { success: true } });
const stopEvent = (cwd) => JSON.stringify({ hook_event_name: 'Stop', session_id: 'eqstop', cwd, stop_hook_active: false });

test('Stop: sua code khong test -> block (verify-gate); proc-orphans cung chay', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cwd-'));
  fs.mkdirSync(path.join(cwd, 'src')); fs.mkdirSync(path.join(cwd, '.git')); fs.writeFileSync(path.join(cwd, 'src', 'a.js'), 'x');
  const reason = 'verify-gate: Da sua code nhung chua co bang chung pass sau lan sua cuoi, chay trong thu muc/du an (git root) cua moi file da sua: chay test/tsc (hoac build/lint) roi bao ket qua.';
  check('Stop', stopEvent(cwd), { json: { decision: 'block', reason }, sa: ['gate|verify-gate:missing_code:block', 'session|Stop|', 'tool|PostToolUse|Edit'] }, {
    seed: (env) => { const s = runNew('PostToolUse', editEvent(cwd), env); expect(s.status).toBe(0); },
  });
}, 90000);

test('Stop: binh thuong (khong sua code) -> {}', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cwd-'));
  check('Stop', stopEvent(cwd), { json: {}, sa: ['session|Stop|'] });
}, 90000);

test('UserPromptSubmit: chi audit -> {}; co ghi audit prompt', () => {
  const r = check('UserPromptSubmit', JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'eq1', cwd: ROOT, prompt: 'zzqxv qqwwzz' }), { json: {}, sa: ['prompt|UserPromptSubmit|'] });
  expect(r.sb.length).toBeGreaterThan(0);
}, 60000);

/** Repo git tam (goc HUB_DIR) de SessionStart sweep / Worktree khong dong vao worktree that. */
function repoSandbox(prefix) {
  const s = sandbox();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  s.env.HUB_DIR = repo; s.env.HUB_DATA_DIR = path.join(repo, 'data');
  return { ...s, repo };
}

test('SessionStart: audit + inject + sweep an toan -> {}', () => {
  const b = repoSandbox('dispatch repo ');
  const neu = runNew('SessionStart', JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'eq1', cwd: ROOT, source: 'startup' }), b.env);
  expect(neu.status).toBe(0);
  expect(parse(neu.stdout)).toEqual({});
}, 90000);

test('WorktreeCreate/Remove: in duong dan <goc repo>/.worktrees/<name>, exit 0; thieu name -> exit 1 + stderr', () => {
  const b = repoSandbox('dispatch wt ');
  const norm = (s) => s.split(b.repo).join('<R>');
  const neu = runNew('WorktreeCreate', JSON.stringify({ hook_event_name: 'WorktreeCreate', session_id: 'eq1', name: 'agent-eq1' }), b.env);
  expect(neu.status).toBe(0);
  expect(norm(neu.stdout).replaceAll('\\', '/')).toBe('<R>/.worktrees/agent-eq1');
  expect(fs.existsSync(neu.stdout)).toBe(true);
  // remove: worktree sach (chua co commit rieng) -> exit 0, khong in gi
  const rn = runNew('WorktreeRemove', JSON.stringify({ hook_event_name: 'WorktreeRemove', worktree_path: neu.stdout }), b.env);
  expect(rn.status).toBe(0);
  expect(rn.stdout).toBe('');
  expect(fs.existsSync(neu.stdout)).toBe(false);
  // loi: thieu name
  const n2 = runNew('WorktreeCreate', JSON.stringify({ hook_event_name: 'WorktreeCreate', session_id: 'eq1' }), b.env);
  expect(n2.status).toBe(1);
  expect(n2.stdout).toBe('');
  expect(n2.stderr).toContain('worktree create loi');
}, 120000);

// ---- Loi toan cuc ----
test('JSON hong -> {} exit 0 (nhu guard/approval cu); co vet gate fail-open, khong ghi stdin', () => {
  const b = sandbox();
  const garbage = 'not json SECRET-TOKEN-123';
  const neu = runNew('PreToolUse', garbage, b.env);
  expect(neu.status).toBe(0);
  expect(parse(neu.stdout)).toEqual({});
  const text = JSON.stringify(signature(b.env.CLAUDE_AUDIT_DIR));
  expect(text).toContain('dispatch:fail-open');
  const raw = fs.existsSync(b.env.CLAUDE_AUDIT_DIR) ? fs.readdirSync(b.env.CLAUDE_AUDIT_DIR, { recursive: true }).filter((f) => f.endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(b.env.CLAUDE_AUDIT_DIR, f), 'utf8')).join('') : '';
  expect(raw).not.toContain('SECRET-TOKEN-123');
}, 60000);

test('stdin qua lon (> maxInputBytes) -> {} exit 0, vet oversize, khong treo', () => {
  const b = sandbox();
  const big = bash('echo ' + 'x'.repeat(1_200_000));
  const t0 = Date.now();
  const neu = runNew('PreToolUse', big, b.env);
  expect(neu.status).toBe(0);
  expect(parse(neu.stdout)).toEqual({});
  expect(Date.now() - t0).toBeLessThan(5000);
  expect(signature(b.env.CLAUDE_AUDIT_DIR).join()).toContain('dispatch:fail-open');
}, 60000);

test('su kien la / stdin rong -> {} exit 0', () => {
  const b = sandbox();
  expect(parse(runNew('NoSuchEvent', '{}', b.env).stdout)).toEqual({});
  expect(runNew('PreToolUse', '', b.env).status).toBe(0);
}, 60000);

test('tham so thu hai = loc module (guard rieng)', () => {
  const b = sandbox();
  const r = runNew('PreToolUse', bash('git push --force origin main'), b.env, 'guard');
  expect(parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  const r2 = runNew('PreToolUse', bash('ls'), b.env, 'guard');
  expect(parse(r2.stdout)).toEqual({});
}, 60000);


// ---- module-acted: ghi gate gon khi module co tac dung (khong ghi khi tra rong / module loi / da tu ghi gate) ----
const actedMod = (id, res, over = {}) => ({ id, events: ['PreToolUse'], timeoutMs: 200, onError: 'open', handle: async () => res, ...over });
const actedProfile = async (...mods) => { const { CLAUDE } = await import('./run.mjs'); return { ...CLAUDE, order: { PreToolUse: mods.map((m) => ({ id: m.id, gate: false, load: async () => ({ default: m }) })) } }; };
const actedRun = async (...mods) => {
  const { dispatch } = await import('./run.mjs');
  const stdin = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } });
  return dispatch({ event: 'PreToolUse', stdin, cfg: { maxInputBytes: 1000000, budgetsMs: { PreToolUse: 1500 } }, profile: await actedProfile(...mods) });
};
const actedRecs = (r) => r.records.filter((x) => x.data && x.data.rule === 'module-acted');

test('module-acted: module tra rong -> khong ghi; tra context -> ghi dung 1 ban', async () => {
  const none = await actedRun(actedMod('x-empty', {}), actedMod('x-undef', undefined));
  expect(actedRecs(none)).toEqual([]);
  const ctx = await actedRun(actedMod('x-ctx', { additionalContext: 'hi' }), actedMod('x-empty', {}));
  const recs = actedRecs(ctx);
  expect(recs.length).toBe(1);
  expect(recs[0]).toEqual({ sink: 'gate', data: { kind: 'gate', decision: 'allow', hook: 'dispatch', rule: 'module-acted', reason: 'x-ctx:PreToolUse' } });
});

test('module-acted: module loi (audit, guard...) va module da tu ghi gate -> khong ghi trung', async () => {
  const core = await actedRun(actedMod('audit', { additionalContext: 'a' }), actedMod('guard', { reason: 'r' }));
  expect(actedRecs(core)).toEqual([]);
  const self = await actedRun(actedMod('x-self', { additionalContext: 'a', records: [{ sink: 'gate', data: { kind: 'gate', decision: 'allow', hook: 'x-self' } }] }));
  expect(actedRecs(self)).toEqual([]);
});

test('module-acted: ghi that bai (goc audit la file) -> hook van ok, khong nem', async () => {
  const { writeRecords } = await import('./run.mjs');
  const r = await actedRun(actedMod('x-ctx', { additionalContext: 'hi' }));
  expect(r.code).toBe(0);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'acted-'));
  const bad = path.join(d, 'not-a-dir'); fs.writeFileSync(bad, 'x');
  const old = process.env.CLAUDE_AUDIT_DIR; process.env.CLAUDE_AUDIT_DIR = bad;
  try { await expect(writeRecords(r.records, {})).resolves.toBeUndefined(); } finally { if (old === undefined) delete process.env.CLAUDE_AUDIT_DIR; else process.env.CLAUDE_AUDIT_DIR = old; }
});
