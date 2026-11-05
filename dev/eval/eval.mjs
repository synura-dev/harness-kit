// dev/eval/eval.mjs - oracle tat dinh cho CHINH harness: bo ca co dinh (cases/*.json), moi ca spawn hook/CLI that
// voi stdin, co lap trong thu muc tam (env tro audit/config/data tam), timeout moi ca + tran tong. KHONG goi LLM.
// Ca: { id, desc, run: {kind: hook|cli|fn, entry|args|module+export}, stdin, setup: {audit, files, cli}, env, expect }.
// expect: exit, decision (ask|deny|block|inject|none), reason (regex), contains/notContains (stdout), value (fn), exists/missing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from '../../harness/core/runtime/proc.mjs';
import { fileURLToPath } from 'node:url';
import { workspaceRoot, isObj, isInside } from '../../harness/core/io/paths.mjs';
import { dataPathFor } from '../../harness/core/io/storage.mjs';
import { dataPathsFor } from '../../harness/core/registry/data-registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CASES_DIR = path.join(HERE, 'cases');
export const FN_RUNNER = path.join(HERE, 'fn-runner.mjs');
export const LIMITS = Object.freeze({ caseTimeoutMs: 20000, totalTimeoutMs: 170000, maxCases: 200, maxFileBytes: 262144, maxOutBytes: 65536, maxConfigEntries: 2000, maxConfigBytes: 16777216 });
export const SID = 'eval-sid';
const KINDS = ['hook', 'cli', 'fn'];
const EXPECT_KEYS = new Set(['exit', 'decision', 'reason', 'contains', 'notContains', 'value', 'exists', 'missing']);

export const baselineFile = () => dataPathsFor('eval', 'baseline.json')[0] || dataPathFor('eval', 'baseline.json');

function validate(c) {
  if (!isObj(c)) return 'ca khong phai object';
  if (typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(c.id)) return 'id phai kebab-case';
  if (!isObj(c.run) || !KINDS.includes(c.run.kind)) return `run.kind phai thuoc ${KINDS.join('|')}`;
  if (c.run.kind === 'hook' && typeof c.run.entry !== 'string') return 'hook can run.entry';
  if (c.run.kind === 'cli' && !Array.isArray(c.run.args)) return 'cli can run.args';
  if (c.run.kind === 'fn' && (typeof c.run.module !== 'string' || typeof c.run.export !== 'string')) return 'fn can run.module + run.export';
  if (!isObj(c.expect) || !Object.keys(c.expect).length) return 'thieu expect';
  const bad = Object.keys(c.expect).filter((k) => !EXPECT_KEYS.has(k));
  return bad.length ? `expect la: ${bad.join(',')}` : null;
}

/** Doc cases/*.json (moi file = mang ca, group = ten file). filter: khop chuoi con id hoac dung group. */
export function loadCases(dir = CASES_DIR, { filter } = {}) {
  const errors = []; const cases = []; const seen = new Set();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch (e) { errors.push(`khong doc duoc ${dir}: ${e.message}`); }
  for (const f of files) {
    let arr;
    try {
      const p = path.join(dir, f);
      if (fs.statSync(p).size > LIMITS.maxFileBytes) throw new Error(`qua ${LIMITS.maxFileBytes} byte`);
      arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) { errors.push(`${f}: ${e.message}`); continue; }
    if (!Array.isArray(arr)) { errors.push(`${f}: phai la mang ca`); continue; }
    const group = path.basename(f, '.json');
    for (const c of arr) {
      const bad = validate(c);
      if (bad) { errors.push(`${f}: ${c?.id ?? '?'}: ${bad}`); continue; }
      if (seen.has(c.id)) { errors.push(`${f}: trung id ${c.id}`); continue; }
      seen.add(c.id);
      if (filter && c.id !== filter && group !== filter && !c.id.includes(filter)) continue;
      cases.push({ group, ...c });
    }
  }
  if (cases.length > LIMITS.maxCases) errors.push(`qua ${LIMITS.maxCases} ca, cat bot`);
  return { cases: cases.slice(0, LIMITS.maxCases), errors };
}

// Thay {tmp} {hub} {today} trong moi chuoi (de quy).
function subst(v, vars) {
  if (typeof v === 'string') return v.replace(/\{(tmp|hub|today)\}/g, (_, k) => vars[k]);
  if (Array.isArray(v)) return v.map((x) => subst(x, vars));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x, vars)]));
  return v;
}

const insideTmp = (tmp, rel) => { const p = path.resolve(tmp, rel); if (!isInside(p, tmp)) throw new Error(`duong dan ngoai thu muc tam: ${rel}`); return p; };

// audit gia: {type, event, tool, target, ok, data, ago (giay truoc bay gio)} -> <tmp>/audit/date=D/type=T/claude-<SID>.jsonl
function writeAudit(tmp, events, now) {
  for (const e of events) {
    const { ago = 0, type = 'tool', ...rest } = e;
    const ts = new Date(now - Number(ago) * 1000).toISOString();
    const dir = path.join(tmp, 'audit', `date=${ts.slice(0, 10)}`, `type=${type}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `claude-${SID}.jsonl`), JSON.stringify({ v: 2, ts, sid: `claude-${SID}`, agent_id: null, ok: true, data: {}, ...rest, type }) + '\n');
  }
}

function spawn(hub, args, { input, env, cwd, timeout }) {
  const r = spawnSync(process.execPath, args, { input, env, cwd, timeout, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const cut = (s) => String(s || '').slice(0, LIMITS.maxOutBytes);
  return { status: r.status, stdout: cut(r.stdout), stderr: cut(r.stderr), timedOut: r.error?.code === 'ETIMEDOUT' || (r.signal != null && r.status == null) };
}

/** Quan sat chung: quyet dinh suy tu stdout theo schema hook Claude. */
export function observe(r) {
  const stdout = r.stdout.trim();
  let json = null;
  try { json = stdout ? JSON.parse(stdout) : null; } catch { json = null; }
  const h = isObj(json) ? json.hookSpecificOutput : null;
  let decision = 'none';
  if (isObj(h) && h.permissionDecision) decision = h.permissionDecision;
  else if (isObj(json) && json.decision) decision = json.decision;
  else if (isObj(h) && h.additionalContext) decision = 'inject';
  const reason = (isObj(h) && h.permissionDecisionReason) || (isObj(json) && json.reason) || '';
  const got = { exit: r.status, decision };
  if (reason) got.reason = String(reason).slice(0, 200);
  if (isObj(json) && 'value' in json) got.value = json.value;
  if (r.timedOut) got.timedOut = true;
  return { got, stdout };
}

const asList = (v) => (Array.isArray(v) ? v : [v]);

/** So ky vong; tra danh sach lech (rong = dat). */
export function checkExpect(want, obs, tmp) {
  const { got, stdout } = obs; const miss = [];
  if ('exit' in want && got.exit !== want.exit) miss.push(`exit ${got.exit} != ${want.exit}`);
  if ('decision' in want && got.decision !== want.decision) miss.push(`decision ${got.decision} != ${want.decision}`);
  if ('reason' in want && !new RegExp(want.reason).test(got.reason || '')) miss.push(`reason khong khop /${want.reason}/`);
  if ('value' in want && JSON.stringify(got.value ?? null) !== JSON.stringify(want.value)) miss.push(`value ${JSON.stringify(got.value)} != ${JSON.stringify(want.value)}`);
  for (const s of 'contains' in want ? asList(want.contains) : []) if (!stdout.includes(s)) miss.push(`stdout thieu "${s}"`);
  for (const s of 'notContains' in want ? asList(want.notContains) : []) if (stdout.includes(s)) miss.push(`stdout co "${s}"`);
  for (const p of 'exists' in want ? asList(want.exists) : []) if (!fs.existsSync(insideTmp(tmp, p))) miss.push(`khong ton tai ${p}`);
  for (const p of 'missing' in want ? asList(want.missing) : []) if (fs.existsSync(insideTmp(tmp, p))) miss.push(`van ton tai ${p}`);
  return miss;
}

// Env toi thieu cho tien trinh con (oracle tat dinh): chi bien he thong can de chay node/bun; KHONG mang HARNESS_*, HOOK_*, CLAUDE_*, HOME that...
const ENV_ALLOW = Object.freeze(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'BUN_INSTALL', 'BUN_RUNTIME_TRANSPILER_CACHE_PATH']);
export function baseEnv(src = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(src)) if (ENV_ALLOW.includes(k.toUpperCase()) && typeof v === 'string') out[k] = v;
  return out;
}

/** Kiem thu muc config hub de xuat (--hub-config-dir): ton tai, la thu muc, khong qua lon. Tra duong dan tuyet doi. */
function checkConfigDir(dir) {
  const abs = path.resolve(dir);
  let st; try { st = fs.statSync(abs); } catch { throw new Error(`--hub-config-dir khong ton tai: ${abs}`); }
  if (!st.isDirectory()) throw new Error(`--hub-config-dir khong phai thu muc: ${abs}`);
  let n = 0, bytes = 0;
  for (const f of fs.readdirSync(abs, { recursive: true, withFileTypes: true })) {
    if (++n > LIMITS.maxConfigEntries) throw new Error(`--hub-config-dir qua ${LIMITS.maxConfigEntries} muc`);
    if (f.isFile()) { bytes += fs.statSync(path.join(f.parentPath ?? f.path, f.name)).size; if (bytes > LIMITS.maxConfigBytes) throw new Error(`--hub-config-dir qua ${LIMITS.maxConfigBytes} byte`); }
  }
  return abs;
}

/** Chay mot ca trong thu muc tam rieng; luon don thu muc tam. configDir: chep vao <tmp>/config truoc khi chay (ban sao, ca khong sua duoc goc). */
function runCase(c, { hub = workspaceRoot(), timeoutMs = LIMITS.caseTimeoutMs, now = Date.now(), configDir = null } = {}) {
  const t0 = Date.now();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'heval-')));
  const vars = { tmp, hub, today: new Date(now).toISOString().slice(0, 10) };
  const want = c.expect;
  try {
    const cc = subst(c, vars);
    if (configDir) fs.cpSync(configDir, path.join(tmp, 'config'), { recursive: true, dereference: false });
    for (const d of ['audit', 'config', 'data', 'home']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
    const cfg = path.join(tmp, 'config'); const home = path.join(tmp, 'home');
    const env = { ...baseEnv(), HUB_DIR: hub, HOME: home, USERPROFILE: home, CLAUDE_AUDIT_DIR: path.join(tmp, 'audit'), HUB_CONFIG_DIR: cfg, HARNESS_CONFIG_DIR: cfg,
      HUB_DATA_DIR: path.join(tmp, 'data'), GUARD_LOG_FILE: path.join(tmp, 'guard.log'), ...(cc.env || {}) };
    const deadline = t0 + timeoutMs;
    const left = () => Math.max(1000, deadline - Date.now());
    const harness = path.join(hub, 'harness', 'cli', 'harness.mjs');
    const s = cc.setup || {};
    for (const [rel, txt] of Object.entries(s.files || {})) { const p = insideTmp(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, String(txt)); }
    if (s.audit) writeAudit(tmp, s.audit, now);
    for (const args of s.cli || []) {
      const r = spawn(hub, [harness, ...args], { env, cwd: tmp, timeout: left() });
      if (r.status !== 0) throw new Error(`setup that bai (${args.slice(0, 2).join(' ')}): exit ${r.status} ${r.stderr.slice(0, 200)}`);
    }
    const input = cc.stdin === undefined ? '' : typeof cc.stdin === 'string' ? cc.stdin : JSON.stringify(cc.stdin);
    const run = cc.run;
    const args = run.kind === 'hook' ? [insideHub(hub, run.entry), ...(run.args || [])]
      : run.kind === 'cli' ? [harness, ...run.args]
        : [FN_RUNNER, run.module, run.export];
    const fnInput = run.kind === 'fn' ? JSON.stringify(cc.args || []) : input;
    const obs = observe(spawn(hub, args, { input: fnInput, env, cwd: tmp, timeout: left() }));
    const miss = checkExpect(subst(want, vars), obs, tmp);
    if (obs.got.timedOut) miss.unshift('timeout');
    return { id: c.id, group: c.group, ok: miss.length === 0, got: miss.length ? { ...obs.got, miss } : obs.got, want, ms: Date.now() - t0 };
  } catch (e) {
    return { id: c.id, group: c.group, ok: false, got: { error: e.message }, want, ms: Date.now() - t0 };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 2 }); } catch { /* thu muc tam, bo qua */ }
  }
}

function insideHub(hub, rel) { const p = path.resolve(hub, rel); if (!(isInside(p, path.join(hub, 'harness')) || isInside(p, path.join(hub, 'dev')))) throw new Error(`entry ngoai harness/: ${rel}`); return p; }

/** Chay tat ca ca; tran tong -> ca con lai ok:false + truncated 'timeout'. */
export function runAll({ dir = CASES_DIR, filter, caseTimeoutMs = LIMITS.caseTimeoutMs, totalTimeoutMs = LIMITS.totalTimeoutMs, hub, hubConfigDir = null } = {}) {
  const t0 = Date.now();
  const configDir = hubConfigDir ? checkConfigDir(hubConfigDir) : null;
  const { cases, errors } = loadCases(dir, { filter });
  const out = []; let truncated = null;
  for (const c of cases) {
    const left = totalTimeoutMs - (Date.now() - t0);
    if (left <= 0) { truncated = 'timeout'; out.push({ id: c.id, group: c.group, ok: false, got: { error: 'bo qua: het tran tong' }, want: c.expect, ms: 0 }); continue; }
    out.push(runCase(c, { hub, timeoutMs: Math.min(caseTimeoutMs, left), configDir }));
  }
  const pass = out.filter((c) => c.ok).length;
  return { pass, fail: out.length - pass, total: out.length, config: configDir || 'default', errors, truncated, ms: Date.now() - t0, at: new Date().toISOString(), cases: out };
}

/** Luu baseline; tu choi khi run co ca truot/loi (khong ha chuan) tru khi force. */
export function saveBaseline(result, file = baselineFile(), { force = false } = {}) {
  if (!force && (result.fail || result.errors?.length)) throw new Error(`khong ghi baseline khi co ${result.fail} ca truot / ${result.errors?.length || 0} loi ca (can --force)`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const slim = { at: result.at, config: result.config || 'default', pass: result.pass, fail: result.fail, cases: result.cases.map(({ id, group, ok }) => ({ id, group, ok })) };
  fs.writeFileSync(file, JSON.stringify(slim, null, 2) + '\n');
  return file;
}

export function readBaseline(file = baselineFile()) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j?.cases) ? j : null; } catch { return null; }
}

/** So voi baseline: newFail (truoc dat/khong co, nay truot), newPass (truoc truot, nay dat), added, removed. */
export function compare(cur, base) {
  const b = new Map(base.cases.map((c) => [c.id, !!c.ok]));
  const ids = new Set(cur.cases.map((c) => c.id));
  const newFail = []; const newPass = []; const added = [];
  for (const c of cur.cases) {
    if (!b.has(c.id)) { added.push(c.id); if (!c.ok) newFail.push(c.id); continue; }
    if (b.get(c.id) && !c.ok) newFail.push(c.id);
    if (!b.get(c.id) && c.ok) newPass.push(c.id);
  }
  const removed = [...b.keys()].filter((id) => !ids.has(id));
  return { regressed: newFail.length > 0, newFail, newPass, added, removed, pass: cur.pass, fail: cur.fail, basePass: base.pass, baseFail: base.fail, baseAt: base.at };
}
