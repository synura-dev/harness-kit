// Tu don theo han luu tru DA KHAI BAO: an toan (khong dong muc khong khai bao / knowledge / external / workspaces, khong theo symlink), tran + lam tiep, audit gon.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanAuto, autoRetention, run } from './data.mjs';
import { isStdRootFile } from './std-root.mjs';
import { clutterOf, DEFAULTS } from '../data-check/hook.mjs';
import { scanZones } from './data.mjs';

const DAY = 86400000;
const mkRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ar-'));
const put = (root, rel, ageDays, size = 10) => {
  const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'.repeat(size));
  const t = new Date(Date.now() - ageDays * DAY); fs.utimesSync(p, t, t); return p;
};

test('autoRetention: khai bao ro > 0 moi dong knowledge/external/workspaces; system dung them mac dinh class', () => {
  assert.equal(autoRetention('k', { zone: 'knowledge', class: 'log' }), null);
  assert.equal(autoRetention('k', { zone: 'knowledge', class: 'log', retentionDays: 5 }), 5);
  assert.equal(autoRetention('e', { zone: 'external', class: 'cache' }), null);
  assert.equal(autoRetention('w', { zone: 'workspaces', class: 'log' }), null);
  assert.equal(autoRetention('s', { zone: 'system', class: 'log', path: 'knowledge/x' }), null); // thu muc cap 1 knowledge
  assert.equal(autoRetention('s', { class: 'log' }), null); // khong zone
  assert.equal(autoRetention('s', { zone: 'system', class: 'log', retentionDays: 0 }), null); // 0 khong hop le -> khong xoa
  assert.equal(autoRetention('s', { zone: 'system', class: 'artifact' }), null);
});

test('qua han -> xoa; chua han -> giu; muc khong khai bao / khong dang ky -> giu', () => {
  const r = mkRoot();
  const old = put(r, 'system/play/a.log', 20); const fresh = put(r, 'system/play/b.log', 5);
  const kOld = put(r, 'knowledge/evolve/o.log', 400); // zone knowledge, khong retentionDays
  const eOld = put(r, 'external/app/o.log', 400);
  const wOld = put(r, 'workspaces/gem/tool/o.log', 400);
  const unreg = put(r, 'khongdangky/o.log', 400);
  const reg = { entries: {
    play: { zone: 'system', class: 'log', owner: 'o', retentionDays: 14, path: 'system/play' },
    evolve: { zone: 'knowledge', class: 'log', owner: 'o', path: 'knowledge/evolve' },
    app: { zone: 'external', class: 'cache', owner: 'o', path: 'external/app' },
    'workspaces/gem/tool': { zone: 'workspaces', class: 'log', owner: 'o', path: 'workspaces/gem/tool' },
  }, reserved: [] };
  const res = cleanAuto({ root: r, reg, yes: true });
  assert.equal(res.files, 1); assert.equal(res.byEntry.play, 1);
  assert.ok(!fs.existsSync(old));
  for (const p of [fresh, kOld, eOld, wOld, unreg]) assert.ok(fs.existsSync(p), p);
});

test('knowledge/workspaces CO khai bao retentionDays ro -> moi bi dong', () => {
  const r = mkRoot();
  const k = put(r, 'knowledge/tmpk/o.log', 40); const keep = put(r, 'knowledge/tmpk/n.log', 1);
  const reg = { entries: { tmpk: { zone: 'knowledge', class: 'log', owner: 'o', retentionDays: 10, path: 'knowledge/tmpk' } }, reserved: [] };
  assert.equal(cleanAuto({ root: r, reg, yes: true }).files, 1);
  assert.ok(!fs.existsSync(k)); assert.ok(fs.existsSync(keep));
});

test('symlink/junction long trong muc khong bi theo; muc tro ra ngoai root bi bo qua', () => {
  const r = mkRoot(); const out = mkRoot();
  const victim = put(out, 'sub/victim.log', 300);
  put(r, 'system/play/ok.log', 0);
  let linked = false;
  try { fs.symlinkSync(out, path.join(r, 'system', 'play', 'escape'), 'junction'); linked = true; } catch {}
  const reg = { entries: { play: { zone: 'system', class: 'log', owner: 'o', retentionDays: 1, path: 'system/play' } }, reserved: [] };
  const res = cleanAuto({ root: r, reg, yes: true });
  assert.equal(res.files, 0); assert.ok(fs.existsSync(victim), 'dich symlink phai con');
  // entry.path thoat root bang ..
  const reg2 = { entries: { x: { zone: 'system', class: 'log', owner: 'o', retentionDays: 1, path: '../' + path.basename(out) } }, reserved: [] };
  assert.equal(cleanAuto({ root: r, reg: reg2, yes: true }).files, 0); assert.ok(fs.existsSync(victim));
  // entry la junction ra ngoai (thu muc goc cua entry)
  const r2 = mkRoot(); fs.mkdirSync(path.join(r2, 'system'), { recursive: true });
  try { fs.symlinkSync(out, path.join(r2, 'system', 'play'), 'junction'); linked = linked && true; } catch { linked = false; }
  assert.equal(cleanAuto({ root: r2, reg, yes: true }).files, 0); assert.ok(fs.existsSync(victim));
  void linked;
});

test('tran file: dung em, lan sau lam tiep den het', () => {
  const r = mkRoot();
  for (let i = 0; i < 5; i++) put(r, `system/play/f${i}.log`, 60);
  const reg = { entries: { play: { zone: 'system', class: 'log', owner: 'o', retentionDays: 14, path: 'system/play' } }, reserved: [] };
  const a = cleanAuto({ root: r, reg, yes: true, maxFiles: 2 });
  assert.equal(a.files, 2); assert.match(a.truncated, /max-files 2/);
  const b = cleanAuto({ root: r, reg, yes: true, maxFiles: 2 });
  assert.equal(b.files, 2);
  const c = cleanAuto({ root: r, reg, yes: true, maxFiles: 2 });
  assert.equal(c.files, 1); assert.equal(c.truncated, null);
  assert.equal(fs.readdirSync(path.join(r, 'system', 'play')).length, 0);
});

test('CLI --auto --yes: audit gon (so file + bytes, khong liet ke duong dan); cham tran khong tien lastRun, het viec thi tien', async () => {
  const hub = mkRoot(); const dd = path.join(hub, 'dd');
  for (let i = 0; i < 4; i++) put(dd, `system/play/f${i}.log`, 60, 100);
  const rf = path.join(hub, 'registry.json');
  fs.writeFileSync(rf, JSON.stringify({ entries: { play: { zone: 'system', class: 'log', owner: 'o', retentionDays: 14, path: 'system/play' }, audit: { zone: 'system', class: 'log', owner: 'o', retentionDays: 90, path: 'system/audit' } }, reserved: [] }));
  const sf = path.join(dd, '.state', 'data-check-clean.json');
  fs.mkdirSync(path.dirname(sf), { recursive: true });
  const prevRun = Date.now() - 30 * 3600e3;
  fs.writeFileSync(sf, JSON.stringify({ lastRun: prevRun, done: true, seen: true, files: 0 }));
  const keys = ['HUB_DATA_DIR', 'HARNESS_DATA_REGISTRY', 'HARNESS_DATA_WORKSPACES', 'CLAUDE_AUDIT_DIR'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const log = console.log;
  try {
    process.env.HUB_DATA_DIR = dd; process.env.HARNESS_DATA_REGISTRY = rf; process.env.HARNESS_DATA_WORKSPACES = path.join(hub, 'ws'); process.env.CLAUDE_AUDIT_DIR = path.join(hub, 'audit');
    console.log = () => {};
    assert.equal((await run(['clean', '--auto', '--yes', '--max-files', '3'])).code, 0);
    let st = JSON.parse(fs.readFileSync(sf, 'utf8'));
    assert.equal(st.files, 3); assert.equal(st.lastRun, prevRun, 'cham tran: lastRun giu nguyen de lam tiep');
    assert.equal((await run(['clean', '--auto', '--yes', '--max-files', '3'])).code, 0);
    st = JSON.parse(fs.readFileSync(sf, 'utf8'));
    assert.equal(st.files, 1); assert.ok(st.lastRun > prevRun, 'het viec: lastRun tien');
    // audit: tim dong data-access
    const found = [];
    const walkDir = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walkDir(p); else if (e.name === 'data-cli.jsonl') found.push(p); } };
    walkDir(dd);
    assert.ok(found.length >= 1);
    const lines = found.flatMap((f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).filter((x) => x.cmd === 'clean' && x.auto && x.yes);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].files, 3); assert.equal(lines[0].bytes, 300); assert.deepEqual(lines[0].byEntry, { play: 3 });
    assert.ok(JSON.stringify(lines[0]).length < 400, 'audit gon');
    assert.ok(!JSON.stringify(lines[0]).includes('f0.log'));
  } finally {
    console.log = log;
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test('file goc chuan khong bi tinh la clutter (data scan + hook); file la van bi canh bao', () => {
  for (const n of ['README.md', 'CHANGELOG.md', 'NOTICE', 'NOTICE.txt', 'LICENSE', 'LICENSE.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'AGENTS.md', 'CLAUDE.md', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Cargo.lock']) assert.equal(isStdRootFile(n), true, n);
  for (const n of ['notes.txt', 'debug.log', 'tmp.json', 'out.csv', 'a/README.md', '']) assert.equal(isStdRootFile(n), false, n);
  const repo = mkRoot();
  for (const n of ['CHANGELOG.md', 'NOTICE', 'NOTICE.txt', 'CONTRIBUTING.md', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'package.json', 'LICENSE']) fs.writeFileSync(path.join(repo, n), 'x');
  fs.writeFileSync(path.join(repo, 'laketqua.txt'), 'x'); fs.writeFileSync(path.join(repo, 'rac.log'), 'x');
  const dd = path.join(repo, 'ddata'); fs.mkdirSync(dd);
  const s = scanZones({ root: dd, reg: { entries: { audit: { zone: 'system', class: 'log', owner: 'o' } }, reserved: [] }, repoRoot: repo, write: false, opts: { repoRootFiles: [] } });
  const clutter = s.warnings.filter((w) => w.rule === 'clutter' && w.key === 'repo-root').map((w) => w.path).sort();
  assert.deepEqual(clutter, ['laketqua.txt', 'rac.log']);
  // hook PostToolUse
  for (const n of ['NOTICE.txt', 'CHANGELOG.md', 'LICENSE.txt']) assert.equal(clutterOf(n, DEFAULTS, repo), null, n);
  assert.equal(clutterOf('laketqua.txt', DEFAULTS, repo), 'laketqua.txt');
  assert.equal(clutterOf('rac.log', DEFAULTS, repo), 'rac.log');
});

test('audit gia vuot tran walk: duyet cu nhat truoc -> van xoa duoc file qua han', () => {
  const r = mkRoot();
  const olds = [0, 1, 2].map((i) => put(r, `system/audit/date=2020-01-0${i + 1}/e.jsonl`, 500));
  const news = [];
  for (let d = 1; d <= 6; d++) for (let i = 0; i < 3; i++) news.push(put(r, `system/audit/date=2026-02-0${d}/e${i}.jsonl`, 2));
  const reg = { entries: { audit: { zone: 'system', class: 'log', owner: 'o', retentionDays: 90, path: 'system/audit' } }, reserved: [] };
  const res = cleanAuto({ root: r, reg, yes: true, walkMax: 5 });
  assert.equal(res.files, 3, 'walk bi cat o tran nho nhung van cham file qua han truoc');
  for (const p of olds) assert.ok(!fs.existsSync(p), p);
  for (const p of news) assert.ok(fs.existsSync(p), p);
});

test('file don le > maxBytes bi bo qua, khong chan muc sau', () => {
  const r = mkRoot();
  const big = put(r, 'system/a/big.log', 100, 1000);
  const small = put(r, 'system/b/small.log', 100, 10);
  const reg = { entries: {
    a: { zone: 'system', class: 'log', owner: 'o', retentionDays: 14, path: 'system/a' },
    b: { zone: 'system', class: 'log', owner: 'o', retentionDays: 14, path: 'system/b' },
  }, reserved: [] };
  const res = cleanAuto({ root: r, reg, yes: true, maxBytes: 100 });
  assert.equal(res.files, 1); assert.equal(res.byEntry.b, 1); assert.equal(res.more, false);
  assert.ok(fs.existsSync(big)); assert.ok(!fs.existsSync(small));
});

test('CLI: luot khong xoa duoc gi -> lastRun tien (khong lap vo ich)', async () => {
  const hub = mkRoot(); const dd = path.join(hub, 'dd');
  put(dd, 'system/play/fresh.log', 1); // chua han
  put(dd, 'system/play/huge.log', 100, 500); // qua han nhung > maxBytes
  const rf = path.join(hub, 'registry.json');
  fs.writeFileSync(rf, JSON.stringify({ entries: { play: { zone: 'system', class: 'log', owner: 'o', retentionDays: 14, path: 'system/play' } }, reserved: [] }));
  const sf = path.join(dd, '.state', 'data-check-clean.json'); fs.mkdirSync(path.dirname(sf), { recursive: true });
  const prevRun = Date.now() - 30 * 3600e3;
  fs.writeFileSync(sf, JSON.stringify({ lastRun: prevRun, done: true, seen: true, files: 0 }));
  const keys = ['HUB_DATA_DIR', 'HARNESS_DATA_REGISTRY', 'HARNESS_DATA_WORKSPACES', 'CLAUDE_AUDIT_DIR'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]])); const log = console.log;
  try {
    process.env.HUB_DATA_DIR = dd; process.env.HARNESS_DATA_REGISTRY = rf; process.env.HARNESS_DATA_WORKSPACES = path.join(hub, 'ws'); process.env.CLAUDE_AUDIT_DIR = path.join(hub, 'audit');
    console.log = () => {};
    assert.equal((await run(['clean', '--auto', '--yes', '--max-bytes', '100'])).code, 0);
    const st = JSON.parse(fs.readFileSync(sf, 'utf8'));
    assert.equal(st.files, 0); assert.ok(st.lastRun > prevRun, 'khong xoa duoc gi -> lastRun phai tien');
  } finally {
    console.log = log;
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});
