import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyChange, runAutopilot, queueOp, readState, readQueue, autopilotDue, apDir, CFG } from './autopilot.mjs';
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
  const c = (kind, target = 'evolve/rules/evolve-x.json') => classifyChange({ kind, target }).level;
  expect(c('rule')).toBe(1);
  expect(c('inject', 'evolve/inject/x.md')).toBe(2); // inject -> hang cho TTY
  expect(c('rule', 'evolve/rules/x.json')).toBe(2); // thieu tien to evolve-
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

test('muc 1: tu ap dung + ghi moc; 24h khong chay lai; tran moi lan', async () => {
  const r = await runAutopilot({ ...o, ledgerEntries: [entry(FP)] });
  expect(r.errors).toEqual([]);
  expect(r.applied.length).toBe(1);
  const target = path.join(o.dataBase, ...r.applied[0].target.split('/'));
  expect(JSON.parse(fs.readFileSync(target, 'utf8')).filter.fp).toBe(LB.get(FP));
  const st = readState(o);
  expect(st.applied[0]).toMatchObject({ fp: LB.get(FP), status: 'applied' });
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
  expect(a.status).toBe('applied'); expect(a.ver).toBe(r.applied[0].ver);  // gia lap crash sau khi ghi file nhung truoc khi luu 'applied': moc con 'applying'
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

// ---- do hieu qua (effect): verdict -> keep/rollback ----
const okCalls = (date, sid, n) => writeAudit(date, sid, Array.from({ length: n }, (_, i) => ({ v: 2, ts: `${date}T09:${String(i % 60).padStart(2, '0')}:00Z`, type: 'tool', event: 'PostToolUse', sid, tool: 'Bash', ok: true, status: 'ok' })));
const failN = (date, sid, n) => writeAudit(date, sid, Array.from({ length: n }, (_, i) => fail(`${date}T10:${String(i % 60).padStart(2, '0')}:00Z`, sid, FP, 'cannot find module foo')));
const AFTER = '2026-11-03';
const T8 = () => ({ ...o, nowMs: NOW + 8 * DAY, ledgerEntries: [], force: true });
const readProp = (id) => JSON.parse(fs.readFileSync(path.join(o.dataRoot, 'proposals', `${id}.json`), 'utf8'));
const logOps = () => fs.readFileSync(path.join(o.dataRoot, 'applied.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// ap luat luc NOW voi baseline 3 loi / 30 call (rate 100/1000)
async function applied() {
  okCalls('2026-10-29', 'sb', 27);
  const r = await runAutopilot({ ...o, ledgerEntries: [entry(FP)] });
  return { r, target: path.join(o.dataBase, ...r.applied[0].target.split('/')), pid: readState(o).applied[0].pid };
}

test('effect: better -> giu, ghi proposal.effect + dong op:effect', async () => {
  const { target, pid } = await applied();
  okCalls(AFTER, 'sa', 200);
  const t = await runAutopilot(T8());
  expect(t.kept.length).toBe(1); expect(t.rolledBack.length).toBe(0);
  expect(fs.existsSync(target)).toBe(true);
  expect(readProp(pid).effect).toMatchObject({ verdict: 'better', action: 'keep', metric: 'target_rate_per_1000' });
  expect(logOps().find((x) => x.op === 'effect')).toMatchObject({ id: pid, verdict: 'better', action: 'keep' });
  expect(readState(o).applied[0].status).toBe('kept');
});

test('effect: unchanged -> rollback kem ly do, ledger rolled_back', async () => {
  fs.writeFileSync(o.ledgerFile, JSON.stringify(entry(FP)) + '\n');
  okCalls('2026-10-29', 'sb', 27);
  const r = await runAutopilot(o);
  const target = path.join(o.dataBase, ...r.applied[0].target.split('/'));
  okCalls(AFTER, 'sa', 180); failN(AFTER, 'sf', 20); // 20/200 = 100/1000 = baseline
  const t = await runAutopilot(T8());
  expect(t.rolledBack.length).toBe(1); expect(t.rolledBack[0].reason).toMatch(/rate/);
  expect(fs.existsSync(target)).toBe(false);
  const pid = readState(o).applied[0].pid;
  expect(readProp(pid)).toMatchObject({ status: 'rolled_back', effect: { verdict: 'unchanged', action: 'rollback' } });
  expect(readState(o).applied[0].status).toBe('rolled_back');
  expect(logOps().some((x) => x.op === 'effect' && x.verdict === 'unchanged')).toBe(true);
  expect(logOps().some((x) => x.op === 'rollback' && x.ok)).toBe(true);
  expect(JSON.parse(fs.readFileSync(o.ledgerFile, 'utf8').split('\n')[0]).evolve.status).toBe('rolled_back');
});

test('effect: worse -> rollback', async () => {
  const { target, pid } = await applied();
  okCalls(AFTER, 'sa', 160); failN(AFTER, 'sf', 40); // 200/1000
  const t = await runAutopilot(T8());
  expect(t.rolledBack.length).toBe(1);
  expect(fs.existsSync(target)).toBe(false);
  expect(readProp(pid).effect.verdict).toBe('worse');
});

test('effect: mau nho -> insufficient, khong hanh dong; do lai lan sau', async () => {
  const { target, pid } = await applied();
  okCalls(AFTER, 'sa', 50);
  const t = await runAutopilot(T8());
  expect(t.kept.length + t.rolledBack.length).toBe(0);
  expect(fs.existsSync(target)).toBe(true);
  expect(readProp(pid).effect).toMatchObject({ verdict: 'insufficient', action: 'none' });
  expect(readState(o).applied[0].status).toBe('applied');
  okCalls(AFTER, 'sb2', 200);
  const t2 = await runAutopilot({ ...T8(), nowMs: NOW + 9 * DAY });
  expect(t2.kept.length).toBe(1);
  expect(readProp(pid).effect.verdict).toBe('better');
});

test('effect: qua 21 ngay van thieu mau -> inconclusive, giu', async () => {
  const { target, pid } = await applied();
  const t = await runAutopilot({ ...T8(), nowMs: NOW + 25 * DAY });
  expect(t.kept.length).toBe(1); expect(t.rolledBack.length).toBe(0);
  expect(fs.existsSync(target)).toBe(true);
  expect(readProp(pid).effect.verdict).toBe('inconclusive');
});

test('effect: doc audit bi cat (truncated) -> khong rollback', async () => {
  const { target, pid } = await applied();
  okCalls(AFTER, 'sa', 160); failN(AFTER, 'sf', 40);
  const t = await runAutopilot({ ...T8(), limits: { query_max_rows: 5 } });
  expect(t.rolledBack.length).toBe(0);
  expect(fs.existsSync(target)).toBe(true);
  expect(readProp(pid).effect).toMatchObject({ verdict: 'insufficient', action: 'none', truncated: 'max_rows' });
});

test('effect: hoi quy bug 7-vs-30 ngay: cung so loi tuyet doi nhung rate giam -> giu (code cu se rollback)', async () => {
  const { target, pid } = await applied();
  okCalls(AFTER, 'sa', 197); failN(AFTER, 'sf', 3); // 3 loi / 200 = 15/1000 < 100 * 0.7
  const t = await runAutopilot(T8());
  expect(t.rolledBack.length).toBe(0); expect(t.kept.length).toBe(1);
  expect(fs.existsSync(target)).toBe(true);
  expect(readProp(pid).effect.verdict).toBe('better');
});

test('effect: dry-run bao se lam gi nhung khong ghi/rollback', async () => {
  const { target, pid } = await applied();
  okCalls(AFTER, 'sa', 160); failN(AFTER, 'sf', 40);
  const before = { st: fs.readFileSync(path.join(apDir(o), 'state.json'), 'utf8'), prop: fs.readFileSync(path.join(o.dataRoot, 'proposals', `${pid}.json`), 'utf8'), log: logOps().length };
  const t = await runAutopilot({ ...T8(), dryRun: true });
  expect(t.rolledBack).toMatchObject([{ dry: true }]);
  expect(fs.existsSync(target)).toBe(true);
  expect(fs.readFileSync(path.join(apDir(o), 'state.json'), 'utf8')).toBe(before.st);
  expect(fs.readFileSync(path.join(o.dataRoot, 'proposals', `${pid}.json`), 'utf8')).toBe(before.prop);
  expect(logOps().length).toBe(before.log);
});

const propFile = (pid) => path.join(o.dataRoot, 'proposals', `${pid}.json`);
const editProp = (pid, fn) => { const j = readProp(pid); fn(j); fs.writeFileSync(propFile(pid), JSON.stringify(j)); };
const effLines = () => logOps().filter((x) => x.op === 'effect');
const worse = () => { okCalls(AFTER, 'sa', 160); failN(AFTER, 'sf', 40); };

test('effect: rollback dong thoi (status doi giua luc do) khong bi ghi de ve applied', async () => {
  const { target, pid } = await applied();
  worse();
  const raced = { ...T8(), onRead: () => editProp(pid, (j) => { j.status = 'rolled_back'; }) };
  await runAutopilot(raced);
  expect(readProp(pid).status).toBe('rolled_back');
  expect(effLines().length).toBe(0);
  expect(fs.existsSync(target)).toBe(true); // khong tu rollback theo ket qua cu
});

test('effect: truncated + baseline hoi to khong duoc luu', async () => {
  const { pid } = await applied();
  editProp(pid, (j) => { delete j.effect; });
  worse();
  await runAutopilot({ ...T8(), limits: { query_max_rows: 5 } });
  expect(readProp(pid).effect.baseline).toBe(null);
});

test('effect: manifest khong khop de xuat -> khong tu rollback, ghi log', async () => {
  const { target, pid } = await applied();
  const ver = readProp(pid).ver;
  const mf = path.join(o.dataRoot, 'versions', ver, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8')); m.id = 'khac'; fs.writeFileSync(mf, JSON.stringify(m));
  worse();
  const t = await runAutopilot(T8());
  expect(t.rolledBack.length).toBe(0); expect(t.refused.length).toBe(1);
  expect(fs.existsSync(target)).toBe(true);
  expect(logOps().some((x) => x.op === 'rollback' && x.ok === false && x.id === pid)).toBe(true);
});

test('effect: sau rollback do hieu qua khong de xuat/ap lai cung fp (2 lan chay)', async () => {
  await applied();
  worse();
  const t = await runAutopilot(T8());
  expect(t.rolledBack.length).toBe(1);
  for (const d of [9, 18]) {
    const r = await runAutopilot({ ...o, nowMs: NOW + d * DAY, ledgerEntries: [entry(FP)], force: true });
    expect(r.applied.length).toBe(0); expect(r.queued.length).toBe(0);
  }
  expect(logOps().filter((x) => x.op === 'apply' && x.ok).length).toBe(1);
});

test('effect: insufficient lap lai khong them dong log/ghi proposal moi ngay', async () => {
  const { pid } = await applied();
  okCalls(AFTER, 'sa', 50);
  await runAutopilot(T8());
  await runAutopilot({ ...T8(), nowMs: NOW + 9 * DAY });
  expect(effLines().length).toBe(1);
  expect(readProp(pid).effect.verdict).toBe('insufficient');
});

test('effect: luat muc 2 chi ghi effect, khong rollback (refused)', async () => {
  const { target, pid } = await applied();
  editProp(pid, (j) => { j.change.target = 'evolve/rules/x.json'; });
  worse();
  const t = await runAutopilot(T8());
  expect(t.rolledBack.length).toBe(0); expect(t.refused.length).toBe(1);
  expect(fs.existsSync(target)).toBe(true);
  expect(readProp(pid).effect.verdict).toBe('worse');
});

test('effect: hai lan chay lien tiep khong ghi/rollback 2 lan', async () => {
  await applied();
  worse();
  const a = await runAutopilot(T8());
  const b = await runAutopilot({ ...T8(), nowMs: NOW + 9 * DAY });
  expect(a.rolledBack.length).toBe(1); expect(b.rolledBack.length + b.kept.length).toBe(0);
  expect(effLines().length).toBe(1);
  expect(logOps().filter((x) => x.op === 'rollback' && x.ok).length).toBe(1);
});

const filler = (n) => { for (let i = 0; i < n; i++) fs.writeFileSync(propFile(`zz${String(i).padStart(3, '0')}`), JSON.stringify({ id: `zz${i}`, kind: 'skill', status: 'checked', change: { target: 'evolve/skills/x/SKILL.md' } })); };

test('effect: >20 de xuat: luat ap cu van duoc do, fp da rollback van bi loai', async () => {
  const { target } = await applied();
  filler(25);
  worse();
  const t = await runAutopilot(T8());
  expect(t.rolledBack.length).toBe(1); expect(fs.existsSync(target)).toBe(false);
  filler(25);
  const r = await runAutopilot({ ...o, nowMs: NOW + 9 * DAY, ledgerEntries: [entry(FP)], force: true });
  expect(r.applied.length).toBe(0); expect(r.queued.length).toBe(0);
});

test('effect: loai fp chi ap cho kind rule (skill cung fp van xep hang duoc)', async () => {
  await applied();
  worse();
  await runAutopilot(T8());
  const r = await runAutopilot({ ...o, nowMs: NOW + 9 * DAY, ledgerEntries: [entry(FP, { evolve_kind: 'skill' })], force: true });
  expect(r.queued.length).toBe(1);
});

test('effect: dry-run bao refused (khong phai rolledBack) khi muc 2 / manifest lech', async () => {
  const { pid } = await applied();
  editProp(pid, (j) => { j.change.target = 'evolve/rules/x.json'; });
  worse();
  const t = await runAutopilot({ ...T8(), dryRun: true });
  expect(t.rolledBack.length).toBe(0);
  expect(t.refused).toMatchObject([{ entry: pid, dry: true }]);
});

test('effect: rollback that bai -> bao loi, state rollback_failed', async () => {
  const { target } = await applied();
  fs.writeFileSync(target, 'bi sua tay'); // sha lech -> rollback tu choi
  worse();
  const t = await runAutopilot(T8());
  expect(t.rolledBack.length).toBe(0);
  expect(t.errors.join(' ')).toContain('rollback');
  expect(readState(o).applied[0].status).toBe('rollback_failed');
});

