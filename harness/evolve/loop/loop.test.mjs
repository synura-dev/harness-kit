import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findCandidates, propose, check, apply, rollback, readLog, classifyTarget, redact, redactPattern } from './loop.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-10-29T12:00:00Z');
let tmp, hub, o;
const fail = (ts, sid, fp, error) => ({ v: 2, ts, type: 'tool', event: 'PostToolUse', sid, tool: 'Bash', ok: false, status: 'error', data: { error, error_fp: fp } });
const writeAudit = (date, sid, recs) => {
  const d = path.join(tmp, 'audit', `date=${date}`, 'type=tool');
  fs.mkdirSync(d, { recursive: true });
  fs.appendFileSync(path.join(d, `${sid}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
};
// Bytes file skill co san (BOM + CRLF) de kiem rollback khoi phuc DUNG byte.
const OLD_BYTES = Buffer.from('﻿---\r\nname: pre\r\n---\r\n\r\nnoi dung cu\r\n', 'utf8');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pjson = (id) => path.join(o.dataRoot, 'proposals', `${id}.json`);
const three = (sid, fp, err) => [1, 2, 3].map((i) => fail(`2026-10-29T0${i}:40:00Z`, sid, fp, err));

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-loop-'));
  hub = path.join(tmp, 'hub');
  fs.mkdirSync(hub, { recursive: true });
  o = { hubRoot: hub, dataBase: path.join(tmp, 'data'), dataRoot: path.join(tmp, 'data', 'evolve'), auditDir: path.join(tmp, 'audit'), nowMs: NOW };
  // fpA: 3 lan / 2 phien trong 7 ngay -> candidate
  writeAudit('2026-10-27', 's1', [fail('2026-10-27T01:00:00Z', 's1', 'aaaaaaaaaa', 'cannot find module foo token=abc123secret')]);
  writeAudit('2026-10-28', 's2', [fail('2026-10-28T01:00:00Z', 's2', 'aaaaaaaaaa', 'cannot find module foo'), fail('2026-10-28T02:00:00Z', 's2', 'aaaaaaaaaa', 'cannot find module foo')]);
  // fpB: chi 2 lan -> khong
  writeAudit('2026-10-29', 's3', [fail('2026-10-29T01:00:00Z', 's3', 'bbbbbbbbbb', 'x err'), fail('2026-10-29T02:00:00Z', 's3', 'bbbbbbbbbb', 'x err')]);
  // fpC: 3 lan nhung 1 lan ngoai 7 ngay -> khong
  writeAudit('2026-10-15', 's4', [fail('2026-10-15T01:00:00Z', 's4', 'cccccccccc', 'old err')]);
  writeAudit('2026-10-29', 's4', [fail('2026-10-29T03:00:00Z', 's4', 'cccccccccc', 'old err'), fail('2026-10-29T04:00:00Z', 's4', 'cccccccccc', 'old err')]);
  // fpD, fpE: 3 lan moi loi; fpF: Bearer/Basic token
  writeAudit('2026-10-29', 's5', three('s5', 'dddddddddd', 'broke d'));
  writeAudit('2026-10-29', 's6', three('s6', 'eeeeeeeeee', 'broke e'));
  writeAudit('2026-10-29', 's7', three('s7', 'ffffffffff', 'curl failed: Authorization: Bearer abcdef123456XYZ and Basic dXNlcjpwYXNzd29yZA== bearer qqqqqq778899'));
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const candId = async (fp) => (await findCandidates(o)).items.find((x) => x.fp === fp).id;
const skillAbs = (p) => path.join(o.dataBase, ...p.change.target.split('/'));

test('nguong >= 3 lan trong 7 ngay, toan may', async () => {
  const r = await findCandidates(o);
  expect(r.items.map((x) => x.fp).sort()).toEqual(['aaaaaaaaaa', 'dddddddddd', 'eeeeeeeeee', 'ffffffffff']);
  const a = r.items.find((x) => x.fp === 'aaaaaaaaaa');
  expect(a.count).toBe(3);
  expect(a.sessions).toBe(2);
  expect((await findCandidates({ ...o, threshold: 2 })).items.map((x) => x.fp)).toContain('bbbbbbbbbb');
});

test('redact (Bearer/Basic, key=value, email) + redactPattern', () => {
  const s = redact('curl -H "Authorization: Bearer abcdef123456" token=abc123secret sk-abcdefghijk1234 me@x.com x Basic dXNlcjpwYXNzd29yZA== bearer zzzzzz998877');
  expect(s).not.toMatch(/abcdef123456|abc123secret|sk-abcdef|me@x\.com|dXNlcjpw|zzzzzz998877/);
  const pt = redactPattern('failed: Authorization: Bearer abcdef123456 and Basic dXNlcjpwYXNzd29yZA==');
  expect(pt).not.toMatch(/abcdef123456|dXNlcjpw/);
  expect(() => new RegExp(pt)).not.toThrow();
});

test('propose (mac dinh kind skill) co bang chung; Bearer token bi che khoi evidence/noi dung', async () => {
  const p = await propose(await candId('aaaaaaaaaa'), o);
  expect(p.kind).toBe('skill');
  expect(p.status).toBe('proposed');
  expect(p.evidence).toMatchObject({ fp: 'aaaaaaaaaa', count: 3, sessions: 2, window_days: 7, threshold: 3 });
  expect(p.evidence.sample).not.toContain('abc123secret');
  expect(p.change.target).toMatch(/^evolve\/skills\/evolve-[a-z0-9-]+\/SKILL\.md$/);
  expect(fs.existsSync(pjson(p.id))).toBe(true);
  await expect(propose('rep_khongco', o)).rejects.toThrow();
  await expect(propose(await candId('aaaaaaaaaa'), { ...o, kind: 'rule' })).rejects.toThrow(/kind la/);
  await expect(propose(await candId('aaaaaaaaaa'), { ...o, kind: 'hook-config' })).rejects.toThrow(/kind la/);
  const f = await propose(await candId('ffffffffff'), o);
  const raw = fs.readFileSync(pjson(f.id), 'utf8');
  expect(raw).not.toMatch(/abcdef123456|dXNlcjpw|qqqqqq778899/);
});

test('check skill: bo qua oracle (ghi ro), KHONG tao/doi file that', async () => {
  const p = await propose(await candId('dddddddddd'), o);
  const r = check(p.id, o);
  expect(r.status).toBe('checked');
  expect(r.check.ok).toBe(true);
  expect(r.check.oracle).toBe('skipped (khong co dich config de eval)');
  expect(r.check.verdict).toBe('skipped');
  expect(fs.existsSync(skillAbs(p))).toBe(false);
  expect(fs.existsSync(path.join(o.dataRoot, 'tmp')) ? fs.readdirSync(path.join(o.dataRoot, 'tmp')).filter((n) => n.startsWith('check-')) : []).toEqual([]);
});

test('check loai de xuat bi sua: after_sha lech / dich da doi tu luc propose (stale)', async () => {
  const p = await propose(await candId('eeeeeeeeee'), o);
  const j = JSON.parse(fs.readFileSync(pjson(p.id), 'utf8'));
  j.change.after += '\nevil\n';
  fs.writeFileSync(pjson(p.id), JSON.stringify(j));
  const r = check(p.id, o);
  expect(r.status).toBe('rejected');
  expect(r.check.reason).toMatch(/after_sha/);
  const q = await propose(await candId('eeeeeeeeee'), { ...o, target: 'evolve/skills/stale-x/SKILL.md' });
  fs.mkdirSync(path.dirname(skillAbs(q)), { recursive: true });
  fs.writeFileSync(skillAbs(q), 'moi xuat hien');
  const r2 = check(q.id, o);
  expect(r2.check.ok).toBe(false);
  expect(r2.check.reason).toMatch(/stale/);
  expect(apply(q.id, { ...o, approve: true }).code).toBe(4);
  expect(fs.readFileSync(skillAbs(q), 'utf8')).toBe('moi xuat hien');
});

test('apply thieu --approve bi tu choi, khong ghi file', async () => {
  const p = await propose(await candId('aaaaaaaaaa'), o);
  expect(check(p.id, o).check.ok).toBe(true);
  const r = apply(p.id, o);
  expect(r.ok).toBe(false);
  expect(r.code).toBe(2);
  expect(fs.existsSync(skillAbs(p))).toBe(false);
});

test('proposal sua tay (check.ok gia, after/target doi) bi tu choi', async () => {
  const p = await propose(await candId('aaaaaaaaaa'), o);
  expect(check(p.id, o).check.ok).toBe(true);
  const j = JSON.parse(fs.readFileSync(pjson(p.id), 'utf8'));
  const orig = JSON.stringify(j);
  // after doi, sha cu
  j.change.after += '\nevil\n';
  fs.writeFileSync(pjson(p.id), JSON.stringify(j));
  const r1 = apply(p.id, { ...o, approve: true });
  expect(r1.code).toBe(4);
  expect(r1.reason).toMatch(/after_sha/);
  // after + after_sha doi nhung check.after_sha la cu -> chua qua check cho dung after
  const h = sha(Buffer.from(j.change.after, 'utf8'));
  j.change.after_sha = h;
  fs.writeFileSync(pjson(p.id), JSON.stringify(j));
  const r2 = apply(p.id, { ...o, approve: true });
  expect(r2.code).toBe(4);
  expect(r2.reason).toMatch(/chua qua oracle/);
  // target tro sang dich cam
  const k = JSON.parse(orig);
  k.change.target = '.claude/settings.json';
  fs.writeFileSync(pjson(p.id), JSON.stringify(k));
  expect(apply(p.id, { ...o, approve: true }).code).toBe(3);
  expect(fs.existsSync(path.join(hub, '.claude'))).toBe(false);
  expect(fs.existsSync(skillAbs(p))).toBe(false);
});

test('dich cam / ngoai allowlist bi tu choi ke ca --approve (deny-by-default)', async () => {
  const cid = await candId('aaaaaaaaaa');
  const forbidden = ['harness/constrain/x.json', '.claude/settings.json', 'harness/evolve/eval/cases.json', 'config/guard/rules.json',
    'harness/hooks/dispatch/a.json', 'harness/config/bash-guard.json', 'config/approval/local.json', 'config/verify-gate/x.json',
    'config/hub/default.json', 'config/guard./x.json', 'CONFIG/Guard /x.json', 'config\\approval\\local.json',
    '.agents/hooks.json', '.git/config'];
  for (const target of forbidden) {
    expect(classifyTarget(target, 'skill', o).forbidden).toBe(true);
    const p = await propose(cid, { ...o, kind: 'skill', target });
    expect(p.status).toBe('blocked');
    expect(check(p.id, o).check.ok).toBe(false);
    const r = apply(p.id, { ...o, approve: true });
    expect(r.code).toBe(3);
    expect(r.manual).toContain(p.change.target);
  }
  for (const t of ['config/approval', 'config/guard', 'config/hub', '.claude', '.agents', '.git']) expect(fs.existsSync(path.join(hub, t))).toBe(false);
  for (const t of ['../outside.md', 'harness/core/x.md', 'config/projects.json', 'harness/config/x.json', 'C:/x.md', '/etc/x.md',
    'evolve/skills/x/a.md:ads', 'evolve/skills/x/con.md', 'evolve/skills/x/nul.md', 'evolve/skills/x/../../core/x.md', 'evolve/skills/EVO~1/x.md',
    'evolve/skills/x.md', 'evolve/skills/x/y.json', 'config/legacy/default.json', 'memory/other/x.md', '../hub/x.md',
    // dich kieu hub cu va skill that cua agent: khong con trong allowlist / cam
    'harness/skills/evolve-x/SKILL.md', 'data/memory/fact/x.md', '.claude/skills/x/SKILL.md', '.agents/skills/x/SKILL.md', 'skills/x/SKILL.md']) {
    const r = classifyTarget(t, 'skill', o);
    expect(r.ok).toBe(false);
  }
  expect(classifyTarget('.claude/skills/x/SKILL.md', 'skill', o).forbidden).toBe(true);
  expect(classifyTarget('.agents/skills/x/SKILL.md', 'skill', o).forbidden).toBe(true);
  expect(classifyTarget('evolve/skills/evolve-x/SKILL.md', 'skill', o).ok).toBe(true);
  expect(classifyTarget('evolve/skills/evolve-x/SKILL.md', 'fact', o).ok).toBe(false);
  expect(classifyTarget('memory/fact/evolve-x.md', 'skill', o).ok).toBe(false);
});

test('junction/symlink trong dich bi tu choi (realpath)', () => {
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const sk = path.join(o.dataBase, 'evolve', 'skills');
  fs.mkdirSync(sk, { recursive: true });
  fs.symlinkSync(outside, path.join(sk, 'evil'), 'junction');
  const r = classifyTarget('evolve/skills/evil/SKILL.md', 'skill', o);
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/realpath/);
  // junction tro vao CHINH goc du lieu nhung sang vung khac -> realpath lech dich
  fs.mkdirSync(path.join(o.dataBase, 'secret'), { recursive: true });
  fs.symlinkSync(path.join(o.dataBase, 'secret'), path.join(sk, 'link'), 'junction');
  expect(classifyTarget('evolve/skills/link/x.md', 'skill', o).ok).toBe(false);
  // junction tro vao .claude/skills cua workspace -> tu choi
  fs.mkdirSync(path.join(hub, '.claude', 'skills'), { recursive: true });
  fs.symlinkSync(path.join(hub, '.claude', 'skills'), path.join(sk, 'agent'), 'junction');
  expect(classifyTarget('evolve/skills/agent/x/SKILL.md', 'skill', o).ok).toBe(false);
  fs.rmSync(path.join(sk, 'agent'), { recursive: true, force: true });
  fs.rmSync(path.join(hub, '.claude'), { recursive: true, force: true });
});

test('apply + rollback (can --approve) khoi phuc dung byte (tao file moi va khoi phuc file cu)', async () => {
  const cid = await candId('aaaaaaaaaa');
  // 1) file moi: rollback xoa
  const s = await propose(cid, o);
  expect(check(s.id, o).check.ok).toBe(true);
  const rs = apply(s.id, { ...o, approve: true });
  expect(rs.ok).toBe(true);
  expect(fs.readFileSync(skillAbs(s), 'utf8')).toContain(cid);
  const m = JSON.parse(fs.readFileSync(path.join(o.dataRoot, 'versions', rs.ver, 'manifest.json'), 'utf8'));
  expect(m).toMatchObject({ ver: rs.ver, status: 'applied', existed: false, kind: 'skill' });
  expect(m.abs).toBeUndefined();
  expect(apply(s.id, { ...o, approve: true }).ok).toBe(false);
  expect(rollback(rs.ver, o).code).toBe(2);
  expect(rollback(rs.ver, { ...o, approve: true }).ok).toBe(true);
  expect(fs.existsSync(skillAbs(s))).toBe(false);
  expect(rollback(rs.ver, { ...o, approve: true }).ok).toBe(false);

  // 2) file cu (BOM + CRLF) xuat hien sau propose: sua before_sha de gia lap, rollback phai tra DUNG byte
  const p = await propose(cid, { ...o, target: 'evolve/skills/pre/SKILL.md' });
  const abs = skillAbs(p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, OLD_BYTES);
  const j = JSON.parse(fs.readFileSync(pjson(p.id), 'utf8'));
  j.change.before_sha = sha(OLD_BYTES);
  fs.writeFileSync(pjson(p.id), JSON.stringify(j));
  expect(check(p.id, o).check.ok).toBe(true);
  const r = apply(p.id, { ...o, approve: true });
  expect(r.ok).toBe(true);
  expect(Buffer.compare(fs.readFileSync(abs), OLD_BYTES)).not.toBe(0);
  const m2 = JSON.parse(fs.readFileSync(path.join(o.dataRoot, 'versions', r.ver, 'manifest.json'), 'utf8'));
  expect(m2).toMatchObject({ status: 'applied', existed: true });
  // dich bi sua sau apply: can --force
  fs.appendFileSync(abs, 'dirty');
  expect(rollback(r.ver, { ...o, approve: true }).code).toBe(4);
  expect(rollback(r.ver, { ...o, approve: true, force: true }).ok).toBe(true);
  expect(Buffer.compare(fs.readFileSync(abs), OLD_BYTES)).toBe(0);
  expect(readLog(o).items.some((x) => x.op === 'rollback' && x.ok)).toBe(true);
});

test('manifest version gia (abs tro settings.json / target cam) bi tu choi', () => {
  const settings = path.join(hub, '.claude', 'settings.json');
  const guard = path.join(o.dataBase, 'evolve', 'skills', 'fake', 'SKILL.md');
  fs.mkdirSync(path.dirname(guard), { recursive: true });
  fs.writeFileSync(guard, 'giu nguyen');
  const mk = (ver, m) => {
    const vd = path.join(o.dataRoot, 'versions', ver);
    fs.mkdirSync(vd, { recursive: true });
    const bin = Buffer.from('{"hooks":{}}');
    fs.writeFileSync(path.join(vd, 'before.bin'), bin);
    fs.writeFileSync(path.join(vd, 'manifest.json'), JSON.stringify({ ver, id: 'p_x', kind: 'skill', existed: true, before_sha: sha(bin), after_sha: sha(fs.readFileSync(guard)), status: 'applied', ...m }));
  };
  mk('vfake-1', { target: 'evolve/skills/fake/SKILL.md', abs: settings });
  const r1 = rollback('vfake-1', { ...o, approve: true, force: true });
  expect(r1.code).toBe(3);
  mk('vfake-2', { target: '.claude/settings.json' });
  expect(rollback('vfake-2', { ...o, approve: true, force: true }).code).toBe(3);
  mk('vfake-3', { target: 'config/approval/local.json' });
  expect(rollback('vfake-3', { ...o, approve: true, force: true }).code).toBe(3);
  mk('vfake-4', { target: 'config/legacy/default.json' }); // dich cu da het allowlist
  expect(rollback('vfake-4', { ...o, approve: true, force: true }).code).toBe(3);
  mk('vfake-5', { target: 'evolve/skills/fake/SKILL.md', kind: 'fact' }); // sai kind cho dich
  mk('vfake-6', { target: 'harness/skills/fake/SKILL.md' }); // dich kieu hub cu: het allowlist
  expect(rollback('vfake-6', { ...o, approve: true, force: true }).code).toBe(3);
  expect(rollback('vfake-5', { ...o, approve: true, force: true }).code).toBe(3);
  expect(rollback('../x', { ...o, approve: true }).ok).toBe(false);
  expect(fs.existsSync(settings)).toBe(false);
  expect(fs.readFileSync(guard, 'utf8')).toBe('giu nguyen');
});

test('CLI: apply khong --approve -> exit 2; khong co lenh -> usage (khong con --set/rule)', async () => {
  const p = await propose(await candId('aaaaaaaaaa'), o);
  const env = { ...process.env, HUB_DATA_DIR: path.join(tmp, 'data') };
  const r = spawnSync(process.execPath, [path.join(HERE, 'cli.mjs'), 'apply', p.id], { env, encoding: 'utf8', timeout: 30000 });
  expect(r.status).toBe(2);
  expect(r.stdout).toContain('--approve');
  const u = spawnSync(process.execPath, [path.join(HERE, 'cli.mjs')], { env, encoding: 'utf8', timeout: 30000 });
  expect(u.status).toBe(0);
  expect(u.stdout).toContain('candidates');
  expect(u.stdout).toContain('--kind skill]');
  expect(u.stdout).not.toContain('fact');
  expect(u.stdout).not.toMatch(/hook-config|--set/);
});

test('eval branch: tran con luon < tran cong (120s+5s), theo --timeout-s neu co', async () => {
  const { evalTimeoutMs, EVAL_TIMEOUT_MS } = await import('./cli.mjs');
  expect(EVAL_TIMEOUT_MS).toBeLessThan(125000);
  expect(evalTimeoutMs(['run'])).toBe(EVAL_TIMEOUT_MS);
  expect(evalTimeoutMs(['run', '--timeout-s', '30'])).toBe(30000);
  expect(evalTimeoutMs(['run', '--timeout-s=7'])).toBe(7000);
  expect(evalTimeoutMs(['run', '--timeout-s', 'x'])).toBe(EVAL_TIMEOUT_MS);
});

test('layout cau hinh: skillsDir doi duoc; cam tuong minh van thang; layout xau bi bo ve mac dinh', () => {
  const lay = { skillsDir: 'ws/skills' };
  expect(classifyTarget('ws/skills/a/SKILL.md', 'skill', { ...o, layout: lay }).ok).toBe(true);
  expect(classifyTarget('evolve/skills/a/SKILL.md', 'skill', { ...o, layout: lay }).ok).toBe(false);
  expect(classifyTarget('ws/facts/x.md', 'skill', { ...o, layout: lay }).ok).toBe(false);
  // layout tro vao vung cam: van forbidden, khong nho allowlist
  const bad = classifyTarget('harness/constrain/x.md', 'skill', { ...o, layout: { skillsDir: 'harness/constrain' } });
  expect(bad.ok).toBe(false);
  expect(bad.forbidden).toBe(true);
  // layout co .. / tuyet doi -> dung mac dinh
  expect(classifyTarget('evolve/skills/a/SKILL.md', 'skill', { ...o, layout: { skillsDir: '../x' } }).ok).toBe(true);
  // layout tro .claude/skills: khong hop SAFE_DIR -> mac dinh; dich .claude van cam
  expect(classifyTarget('.claude/skills/a/SKILL.md', 'skill', { ...o, layout: { skillsDir: '.claude/skills' } }).forbidden).toBe(true);
});

test('goc du lieu tro vao workspace/plugin root: .claude/.agents/config/ma plugin bi cam', () => {
  const ws = { ...o, dataBase: hub };
  for (const t of ['.claude/skills/a/SKILL.md', '.agents/skills/a/SKILL.md', 'config/x/a.md']) expect(classifyTarget(t, 'skill', { ...ws, layout: { skillsDir: 'config/x' } }).ok).toBe(false);
  const repo = path.resolve(HERE, '..', '..', '..');
  const pr = classifyTarget('skills/harness/SKILL.md', 'skill', { ...o, dataBase: repo, layout: { skillsDir: 'skills', factDir: 'memory/fact' } });
  expect(pr.ok).toBe(false);
  expect(pr.forbidden).toBe(true);
  expect(pr.reason).toMatch(/plugin root/);
});

test('E2E du an sach (khong harness/): CLI candidates -> propose -> check (SKIPPED) -> apply --approve -> rollback, dich trong .harness/data', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-proj-'));
  try {
    const data = path.join(proj, '.harness', 'data');
    const ad = path.join(data, 'system', 'audit', 'date=2026-10-29', 'type=tool');
    fs.mkdirSync(ad, { recursive: true });
    const recent = (i) => new Date(Date.now() - i * 3600000).toISOString();
    fs.writeFileSync(path.join(ad, 'sp.jsonl'), [1, 2, 3].map((i) => JSON.stringify(fail(recent(i), 'sp', 'pppppppppp', 'proj boom'))).join('\n') + '\n');
    // ngay audit theo hom nay de lot cua so 7 ngay
    const today = new Date().toISOString().slice(0, 10);
    if (today !== '2026-10-29') fs.renameSync(path.dirname(ad), path.join(data, 'system', 'audit', `date=${today}`));
    const env = { ...process.env, HUB_DIR: proj, HUB_DATA_DIR: data, CLAUDE_PROJECT_DIR: proj };
    const run = (...a) => spawnSync(process.execPath, [path.join(HERE, 'cli.mjs'), ...a, '--json'], { env, cwd: proj, encoding: 'utf8', timeout: 30000 });
    const js = (r) => JSON.parse(r.stdout);
    const c = run('candidates');
    expect(c.status).toBe(0);
    const cid = js(c).items.find((x) => x.fp === 'pppppppppp').id;
    const p = js(run('propose', cid));
    expect(p.status).toBe('proposed');
    expect(p.change.target).toMatch(/^evolve\/skills\/evolve-[a-z0-9-]+\/SKILL\.md$/);
    const ck = spawnSync(process.execPath, [path.join(HERE, 'cli.mjs'), 'check', p.id], { env, cwd: proj, encoding: 'utf8', timeout: 30000 });
    expect(ck.status).toBe(0);
    expect(ck.stdout).toContain('SKIPPED');
    expect(ck.stdout).not.toContain('PASS');
    expect(ck.stdout).toContain('oracle: skipped (khong co dich config de eval)');
    const ap = js(run('apply', p.id, '--approve'));
    expect(ap.ok).toBe(true);
    const abs = path.join(data, ...p.change.target.split('/'));
    expect(fs.readFileSync(abs, 'utf8')).toContain(cid);
    for (const d of ['.claude', '.agents', 'harness', 'skills']) expect(fs.existsSync(path.join(proj, d))).toBe(false);
    expect(js(run('rollback', ap.ver, '--approve')).ok).toBe(true);
    expect(fs.existsSync(abs)).toBe(false);
    // dich ngoai allowlist / .. qua CLI -> blocked, apply tu choi
    for (const t of ['../../x.md', '.claude/skills/x/SKILL.md', 'harness/skills/x/SKILL.md']) {
      const q = js(run('propose', cid, '--target', t));
      expect(q.status).toBe('blocked');
      expect(run('apply', q.id, '--approve').status).toBe(3);
    }
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

test('candidates --source loc theo nguon ext:<id>; mac dinh khong loc', async () => {
  const ev = (ts, src) => ({ ...fail(ts, 'sx', 'gggggggggg', 'ext boom'), ...(src ? { source: src } : {}) });
  writeAudit('2026-10-29', 'sx', [ev('2026-10-29T05:00:00Z', 'ext:demo'), ev('2026-10-29T05:10:00Z', 'ext:demo'), ev('2026-10-29T05:20:00Z', 'ext:demo')]);
  expect((await findCandidates(o)).items.map((x) => x.fp)).toContain('gggggggggg');
  expect((await findCandidates({ ...o, source: 'ext:demo' })).items.map((x) => x.fp)).toEqual(['gggggggggg']);
  expect((await findCandidates({ ...o, source: 'ext:other' })).items.length).toBe(0);
});
