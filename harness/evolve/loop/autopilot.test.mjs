import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyChange, oracleRule, shouldRollback, protectiveRates, worsened, runAutopilot, queueOp, readState, readQueue, autopilotDue, apDir, CFG } from './autopilot.mjs';
import { ruleDef } from './rule-content.mjs';
import { extractErrorDetails } from '../../core/audit/signature.mjs';
import { messageFingerprint } from '../../core/audit/normalize-message.mjs';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const DAY = 86400000;
let tmp, o;
// fp candidate = khoa chinh tac theo thong diep chuan hoa (fx/capture): nhan test -> fp that qua LB.
const LB = new Map();
const fail = (ts, sid, fp, error) => { const ev = { v: 2, ts, type: 'tool', event: 'PostToolUse', sid, tool: 'Bash', ok: false, status: 'error', data: { error, error_fp: fp } }; LB.set(fp, messageFingerprint(extractErrorDetails(ev), 'Bash')); return ev; };
const writeAudit = (date, sid, recs) => {
  const d = path.join(tmp, 'audit', `date=${date}`, 'type=tool');
  fs.mkdirSync(d, { recursive: true });
  fs.appendFileSync(path.join(d, `${sid}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
};
const three = (date, sid, fp, err) => writeAudit(date, sid, [1, 2, 3].map((i) => fail(`${date}T0${i}:40:00Z`, sid, fp, err)));
const entry = (label, extra = {}) => entry0(LB.get(label) ?? label, extra);
const entry0 = (fp, extra = {}) => ({ id: `r|${fp}`, rule: 'r', fp, status: 'open', action: 'propose', count: 3, message: 'm', ...extra });
const FP = 'aaaaaaaaaa';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-ap-'));
  const hub = path.join(tmp, 'hub'); fs.mkdirSync(hub, { recursive: true });
  o = { hubRoot: hub, dataBase: path.join(tmp, 'data'), dataRoot: path.join(tmp, 'data', 'evolve'), auditDir: path.join(tmp, 'audit'), ledgerFile: path.join(tmp, 'ledger.jsonl'), nowMs: NOW };
  three('2026-10-29', 's1', FP, 'cannot find module foo');
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('phan muc tat dinh theo loai thay doi', () => {
  const c = (kind, target = 'evolve/rules/x.json') => classifyChange({ kind, target }).level;
  expect(c('rule')).toBe(1);
  expect(c('inject', 'evolve/inject/x.md')).toBe(1);
  expect(c('skill', 'evolve/skills/x/SKILL.md')).toBe(2);
  expect(c('code', 'harness/core/io/paths.mjs')).toBe(2);
  expect(c('delete', 'harness/observe/ledger/x.mjs')).toBe(2);
  expect(c('gate', 'config/x.json')).toBe(2);
  expect(c('moi-la', 'evolve/x')).toBe(2);
  expect(c('rule', 'harness/core/x.json')).toBe(2); // muc 1 nhung dich khong phai file luat/inject
});

test('cam: guard/approval/bash-guard/data-gate/model-policy, push/deploy, ngoai repo', () => {
  for (const t of ['harness/constrain/guard/hook.mjs', 'harness/constrain/approval/x.json', 'harness/constrain/bash-guard/rules.json', 'config/data-gate/x.json', 'harness/constrain/model-policy/hook.mjs', 'config/approval/a.json', 'harness/hooks/dispatch/run.mjs', 'x/guard/y.json', 'harness/foo/bash-guard.mjs'])
    for (const kind of ['rule', 'code', 'gate', 'skill', 'delete']) expect(classifyChange({ kind, target: t }).level).toBe(0);
  for (const t of ['C:/Windows/x', '/etc/passwd', '../outside/x.json', 'a/../../b', '\\\\srv\\share\\x', 'evolve/autopilot/state.json'])
    expect(classifyChange({ kind: 'rule', target: t }).level).toBe(0);
  expect(classifyChange({ kind: 'push', target: 'evolve/rules/x.json' }).level).toBe(0);
  expect(classifyChange({ kind: 'code', target: 'harness/core/x.mjs', text: 'chay git push origin main' }).level).toBe(0);
  expect(classifyChange({ kind: 'code', target: 'harness/core/x.mjs', text: 'deploy len server' }).level).toBe(0);
});

test('oracle: bat dung fp, loai luat sai/false positive', () => {
  const cand = { id: 'c1', fp: FP, count: 3, tool: 'Bash', sample: 'x', hint: 'h' };
  const def = ruleDef(cand);
  expect(oracleRule(def, FP, [cand]).ok).toBe(true);
  expect(oracleRule({ ...def, filter: { fp: 'zzz' } }, FP, [cand]).ok).toBe(false);
  expect(oracleRule({ ...def, filter: {} }, FP, [cand]).ok).toBe(false);
  expect(oracleRule({ ...def, action: 'propose' }, FP, [cand]).ok).toBe(false);
  expect(oracleRule(def, FP, [{ ...cand, fp: 'other' }]).ok).toBe(false); // khong bat duoc su kien cu
  expect(oracleRule({ ...def, message: 'x'.repeat(300) }, FP, [cand]).ok).toBe(false);
});

test('rollback theo chi so: count khong giam / verify_fail tang / giu khi tot', () => {
  const rec = { count_before: 3, rates_before: { verify_fail_rate: 0.1, correction_rate: 0.01 } };
  const ok = { verify_n: 50, n: 500, verify_fail_rate: 0.1, correction_rate: 0.01 };
  expect(shouldRollback(rec, 3, ok).rollback).toBe(true);
  expect(shouldRollback(rec, 4, ok).rollback).toBe(true);
  expect(shouldRollback(rec, 1, ok).rollback).toBe(false);
  expect(shouldRollback(rec, 1, { ...ok, verify_fail_rate: 0.3 }).rollback).toBe(true);
  expect(shouldRollback(rec, 1, { ...ok, correction_rate: 0.05 }).rollback).toBe(true);
  expect(shouldRollback(rec, 1, { ...ok, verify_n: 3, verify_fail_rate: 0.9 }).rollback).toBe(false); // it mau
  const ev = [{ kind: 'test', event: 'PostToolUseFailure', ok: false }, { kind: 'test', event: 'PostToolUse', ok: true }, { signal: 'correction' }, {}];
  const r = protectiveRates(ev);
  expect(r.verify_fail_rate).toBe(0.5); expect(r.correction_rate).toBe(0.25);
  expect(worsened({ verify_fail_rate: 0, correction_rate: 0 }, { verify_n: 20, n: 20, verify_fail_rate: 0.2, correction_rate: 0 })).toBe(true);
});

test('muc 1: tu ap dung + ghi moc; 24h khong chay lai; tran moi lan', async () => {
  const r = await runAutopilot({ ...o, ledgerEntries: [entry(FP)] });
  expect(r.errors).toEqual([]);
  expect(r.applied.length).toBe(1);
  const target = path.join(o.dataBase, ...r.applied[0].target.split('/'));
  expect(JSON.parse(fs.readFileSync(target, 'utf8')).filter.fp).toBe(LB.get(FP));
  const st = readState(o);
  expect(st.applied[0]).toMatchObject({ fp: LB.get(FP), count_before: 3, status: 'applied' });
  expect(st.lastRun).toBe(NOW);
  expect(autopilotDue(o, NOW + 3600e3)).toBe(false);
  expect(autopilotDue(o, NOW + 25 * 3600e3)).toBe(true);
  const again = await runAutopilot({ ...o, ledgerEntries: [entry(FP)], nowMs: NOW + 3600e3 });
  expect(again.skipped).toMatch(/toi han/);
});

test('dry-run khong ghi gi; tran maxProposals', async () => {
  for (const f of ['b', 'c', 'd', 'e', 'f', 'g']) three('2026-10-29', 's' + f, f.repeat(10), 'err ' + f);
  const es = [FP, ...['b', 'c', 'd', 'e', 'f', 'g'].map((f) => f.repeat(10))].map((fp) => entry(fp));
  const r = await runAutopilot({ ...o, ledgerEntries: es, dryRun: true });
  expect(r.planned.length).toBe(CFG.maxProposals);
  expect(r.applied.length).toBe(0);
  expect(fs.existsSync(path.join(o.dataRoot))).toBe(false);
  const r2 = await runAutopilot({ ...o, ledgerEntries: es, cfg: { maxProposals: 2 } });
  expect(r2.applied.length).toBe(2);
});

test('khoa chong chay trung; khoa cu het han thi di tiep', async () => {
  fs.mkdirSync(apDir(o), { recursive: true });
  fs.writeFileSync(path.join(apDir(o), 'lock.json'), JSON.stringify({ ts: NOW - 1000, pid: 1 }));
  expect((await runAutopilot({ ...o, ledgerEntries: [entry(FP)] })).skipped).toMatch(/khoa/);
  fs.writeFileSync(path.join(apDir(o), 'lock.json'), JSON.stringify({ ts: NOW - 3600e3, pid: 1 }));
  const r = await runAutopilot({ ...o, ledgerEntries: [entry(FP)] });
  expect(r.applied.length).toBe(1);
  expect(fs.existsSync(path.join(apDir(o), 'lock.json'))).toBe(false); // nha khoa
});

test('muc 2 xep hang (khong ap); cam bi tu choi kem ly do trong ledger', async () => {
  const gate = entry('gggggggggg', { evolve_kind: 'gate', evolve_target: 'harness/constrain/guard/x.json' });
  const code = entry('cccccccccc', { evolve_kind: 'code', evolve_target: 'harness/core/io/x.mjs' });
  const skill = entry(FP, { evolve_kind: 'skill' });
  const needs = entry('nnnnnnnnnn', { needs_model: true, evolve_kind: 'code', evolve_target: 'harness/core/y.mjs' });
  fs.writeFileSync(o.ledgerFile, [gate, code, skill, needs].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const r = await runAutopilot(o);
  expect(r.applied.length).toBe(0);
  expect(r.refused.map((x) => x.entry)).toEqual([gate.id]);
  expect(r.queued.length).toBe(3);
  const q = readQueue(o);
  expect(q.every((x) => x.status === 'pending' && x.level === 2)).toBe(true);
  expect(q.some((x) => x.kind === 'skill' && x.pid)).toBe(true);
  const led = fs.readFileSync(o.ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  expect(led.find((e) => e.id === gate.id).evolve).toMatchObject({ status: 'refused' });
  expect(led.find((e) => e.id === gate.id).evolve.reason).toMatch(/guard/);
  expect(led.find((e) => e.id === code.id).evolve.status).toBe('queued');
  expect(fs.existsSync(o.ledgerFile + '.lock')).toBe(false); // annotate di qua khoa chung va nha khoa
});

test('autonomy 0: moi thu vao hang, khong tu ap', async () => {
  const r = await runAutopilot({ ...o, ledgerEntries: [entry(FP)], cfg: { autonomy: 0 } });
  expect(r.applied.length).toBe(0);
  expect(r.queued.length).toBe(1);
});

test('queue: approve can TTY (khong TTY -> 2), co TTY thi ap; reject; muc cam khong duyet duoc', async () => {
  await runAutopilot({ ...o, ledgerEntries: [entry(FP, { evolve_kind: 'skill' })] });
  const id = readQueue(o)[0].id;
  expect((await queueOp({ ...o, approve: id, isTTY: false })).code).toBe(2);
  expect(readQueue(o)[0].status).toBe('pending');
  expect((await queueOp({ ...o, approve: id, confirm: () => false })).code).toBe(1);
  const ok = await queueOp({ ...o, approve: id, confirm: () => true });
  expect(ok.code).toBe(0); expect(ok.ver).toBeTruthy();
  expect(readQueue(o)[0].status).toBe('approved');
  expect((await queueOp({ ...o, approve: id, confirm: () => true })).code).toBe(1); // da duyet
  fs.writeFileSync(path.join(apDir(o), 'review-queue.json'), JSON.stringify([{ id: 'q1', kind: 'gate', target: 'harness/constrain/approval/x.json', status: 'pending' }, { id: 'q2', kind: 'code', target: 'harness/core/a.mjs', status: 'pending' }]));
  expect((await queueOp({ ...o, approve: 'q1', confirm: () => true })).code).toBe(3);
  expect((await queueOp({ ...o, reject: 'q2' })).status).toBe('rejected');
  expect((await queueOp(o)).items.length).toBe(1);
});

test('tu rollback sau 7 ngay: count fp khong giam -> khoi phuc + ghi ledger; giam -> giu', async () => {
  fs.writeFileSync(o.ledgerFile, JSON.stringify(entry(FP)) + '\n');
  const r = await runAutopilot(o);
  const target = path.join(o.dataBase, ...r.applied[0].target.split('/'));
  expect(fs.existsSync(target)).toBe(true);
  // 3 ngay sau: chua toi han rollback
  const t3 = await runAutopilot({ ...o, nowMs: NOW + 3 * DAY + 1, ledgerEntries: [], force: true });
  expect(t3.rolledBack.length + t3.kept.length).toBe(0);
  // 8 ngay sau, fp van lap 3 lan trong cua so -> rollback
  three('2026-11-07', 's9', FP, 'cannot find module foo');
  const t8 = await runAutopilot({ ...o, nowMs: NOW + 8 * DAY, ledgerEntries: [], force: true });
  expect(t8.rolledBack.length).toBe(1);
  expect(fs.existsSync(target)).toBe(false);
  expect(readState(o).applied[0].status).toBe('rolled_back');
  const led = JSON.parse(fs.readFileSync(o.ledgerFile, 'utf8').split('\n')[0]);
  expect(led.evolve.status).toBe('rolled_back');
});

test('queue: hien noi dung+sha, approve tinh lai sha, lech -> tu choi', async () => {
  await runAutopilot({ ...o, ledgerEntries: [entry(FP, { evolve_kind: 'skill' })] });
  const q = readQueue(o)[0];
  expect(q.after_sha).toMatch(/^[0-9a-f]{64}$/);
  const li = (await queueOp(o)).items[0];
  expect(li.sha).toBe(q.after_sha);
  expect(li.after_preview).toContain('name: evolve-');
  expect(li.after_preview.split('\n').length).toBeLessThanOrEqual(40);
  let shown = '';
  const pf = path.join(o.dataRoot, 'proposals', `${q.pid}.json`);
  const orig = fs.readFileSync(pf, 'utf8');
  const p = JSON.parse(orig); p.change.after += 'THEM LENH LA\n'; fs.writeFileSync(pf, JSON.stringify(p));
  const bad = await queueOp({ ...o, approve: q.id, confirm: (m) => { shown = m; return true; } });
  expect(bad.code).toBe(4); expect(shown).toBe('');
  expect(readQueue(o)[0].status).toBe('pending');
  fs.writeFileSync(pf, orig);
  const ok = await queueOp({ ...o, approve: q.id, confirm: (m) => { shown = m; return true; } });
  expect(ok.code).toBe(0); expect(shown).toContain(q.after_sha);
});

test('apply that bai giua chung: moc applying ghi truoc; lan sau hoan tat co kiem hoac bo', async () => {
  const r = await runAutopilot({ ...o, ledgerEntries: [entry(FP)] });
  const st = readState(o); const a = st.applied[0];
  expect(a.status).toBe('applied'); expect(a.ver).toBe(r.applied[0].ver); expect(a.count_before).toBe(3);
  // gia lap crash sau khi ghi file nhung truoc khi luu 'applied': moc con 'applying'
  a.status = 'applying'; a.ver = null;
  fs.writeFileSync(path.join(apDir(o), 'state.json'), JSON.stringify(st));
  const r2 = await runAutopilot({ ...o, ledgerEntries: [], force: true });
  expect(r2.errors.join(' ')).toContain('hoan tat co kiem');
  const s2 = readState(o).applied[0];
  expect(s2.status).toBe('applied'); expect(s2.ver).toBe(a.ver ?? r.applied[0].ver);
  // moc mo coi ma dich khong phai after -> bo
  const target = path.join(o.dataBase, ...r.applied[0].target.split('/'));
  const st3 = readState(o); st3.applied[0].status = 'applying'; st3.applied[0].ver = null;
  fs.writeFileSync(path.join(apDir(o), 'state.json'), JSON.stringify(st3));
  fs.writeFileSync(target, 'khac');
  await runAutopilot({ ...o, ledgerEntries: [], force: true, nowMs: NOW + 2 * DAY });
  expect(readState(o).applied[0].status).toBe('abandoned');
});

test('giu khi fp giam (khong con lap)', async () => {
  const r = await runAutopilot({ ...o, ledgerEntries: [entry(FP)] });
  const target = path.join(o.dataBase, ...r.applied[0].target.split('/'));
  const t8 = await runAutopilot({ ...o, nowMs: NOW + 8 * DAY, ledgerEntries: [], force: true });
  expect(t8.kept.length).toBe(1);
  expect(fs.existsSync(target)).toBe(true);
});

test('protectiveRates bo HookRun khoi mau so', () => {
  const ev = [{ kind: 'test', ok: true }, { type: 'hook', event: 'HookRun' }, { event: 'HookRun' }, { signal: 'correction' }];
  const r = protectiveRates(ev);
  expect(r.n).toBe(2); expect(r.correction_rate).toBe(0.5);
});

test('shouldRollback: khong do duoc -> khong giu, khong rollback', () => {
  const d = shouldRollback({ count_before: 3, rates_before: {} }, 0, { verify_n: 0, n: 0, verify_fail_rate: 0, correction_rate: 0 }, undefined, { measurable: false });
  expect(d.rollback).toBe(false); expect(d.unmeasurable).toBe(true);
});

test('moc fp cu khac dinh dang: unmeasurable + ghi ledger; fp = error_fp goc khop nguoc qua legacy_fps', async () => {
  fs.writeFileSync(o.ledgerFile, JSON.stringify(entry(FP)) + '\n');
  await runAutopilot(o);
  const st = readState(o);
  expect(st.applied[0].legacy_fps).toContain(FP);
  const sp = path.join(apDir(o), 'state.json');
  const bad = JSON.parse(JSON.stringify(st)); bad.applied[0].fp = 'oldformat0'; bad.applied[0].legacy_fps = []; bad.lastRun = 0;
  fs.writeFileSync(sp, JSON.stringify(bad));
  const t8 = await runAutopilot({ ...o, nowMs: NOW + 8 * DAY, ledgerEntries: [], force: true });
  expect(t8.unmeasured.length).toBe(1); expect(t8.kept.length + t8.rolledBack.length).toBe(0);
  expect(readState(o).applied[0].status).toBe('unmeasurable');
  const led = JSON.parse(fs.readFileSync(o.ledgerFile, 'utf8').split('\n')[0]);
  expect(led.evolve.status).toBe('unmeasurable');
  const good = JSON.parse(JSON.stringify(st)); good.applied[0].fp = FP; good.applied[0].legacy_fps = []; good.lastRun = 0;
  fs.writeFileSync(sp, JSON.stringify(good));
  const g8 = await runAutopilot({ ...o, nowMs: NOW + 8 * DAY, ledgerEntries: [], force: true });
  expect(g8.unmeasured.length).toBe(0); expect(g8.kept.length).toBe(1);
});
