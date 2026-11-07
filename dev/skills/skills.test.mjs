import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build, check, prune, renderSkill, MARKER } from './skills.mjs';
import { main } from './cli.mjs';

let root;
const w = (rel, txt) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); };
const r = (rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const ex = (rel) => fs.existsSync(path.join(root, ...rel.split('/')));
const opts = (o = {}) => ({ root, src: 'src', targets: ['t/claude', 't/agents'], ...o });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-build-'));
  w('src/alpha/SKILL.md', '---\nname: alpha\n---\nA\n{{include shared/common.md}}\nend\n');
  w('src/alpha/ref/notes.txt', 'note');
  w('src/beta/SKILL.md', '---\nname: beta\n---\nB\n');
  w('src/shared/common.md', 'SHARED-BLOCK');
  // skill cai ngoai (khong marker) o dich: khong bao gio bi dung
  w('t/claude/ai-job-search/SKILL.md', 'installed');
  w('t/agents/linkedin-search/SKILL.md', 'installed');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const snapshot = (dir) => {
  const out = {};
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); const k = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(p, k); else out[k] = fs.readFileSync(p, 'utf8'); } };
  walk(path.join(root, dir), '');
  return out;
};

test('build mac dinh dry-run khong ghi', () => {
  const res = build(opts());
  expect(res.problems).toEqual([]);
  expect(res.items.filter((i) => i.action === 'create').length).toBe(4);
  expect(ex('t/claude/alpha')).toBe(false);
});

test('build --apply: include nhung luc build, copy that, marker co source+hash', () => {
  build(opts({ apply: true }));
  expect(r('t/claude/alpha/SKILL.md')).toContain('SHARED-BLOCK');
  expect(r('t/claude/alpha/SKILL.md')).not.toContain('{{include');
  expect(r('t/agents/alpha/ref/notes.txt')).toBe('note');
  expect(fs.lstatSync(path.join(root, 't', 'claude', 'alpha')).isSymbolicLink()).toBe(false);
  const m = JSON.parse(r(`t/claude/alpha/${MARKER}`));
  expect(m.source).toBe('src/alpha');
  expect(m.hash).toBe(renderSkill(path.join(root, 'src'), 'alpha').hash);
  expect(typeof m.builtAt).toBe('string');
  expect(ex('t/claude/shared')).toBe(false);
});

test('idempotent: build 2 lan cho ket qua giong het (ke ca builtAt)', () => {
  build(opts({ apply: true }));
  const a = snapshot('t');
  const res2 = build(opts({ apply: true }));
  expect(res2.items.every((i) => i.action === 'skip')).toBe(true);
  expect(snapshot('t')).toEqual(a);
  expect(check(opts()).ok).toBe(true);
});

test('include thieu file hoac co .. -> loi, khong build', () => {
  w('src/gamma/SKILL.md', '{{include shared/missing.md}} {{include shared/../x.md}}');
  const res = build(opts({ apply: true }));
  expect(res.problems.some((p) => p.startsWith('gamma:') && p.includes('missing.md'))).toBe(true);
  expect(res.problems.some((p) => p.includes('include khong hop le'))).toBe(true);
  expect(ex('t/claude/gamma')).toBe(false);
});

test('check: unbuilt, sua tay, lech nguon, conflict; exit code != 0', () => {
  let c = check(opts());
  expect(c.ok).toBe(false);
  expect(c.issues.filter((i) => i.issue === 'unbuilt').length).toBe(4);
  build(opts({ apply: true }));
  w('t/claude/alpha/SKILL.md', 'sua tay');
  w('src/beta/SKILL.md', 'beta moi');
  c = check(opts());
  expect(c.issues).toContainEqual({ skill: 'alpha', target: 't/claude/alpha', issue: 'edited' });
  expect(c.issues).toContainEqual({ skill: 'beta', target: 't/agents/beta', issue: 'drift' });
  const lines = [];
  expect(main(['check', '--root', root, '--src', 'src', '--target', 't/claude'], { out: (s) => lines.push(s), err: () => {} })).toBe(1);
  // ban sua tay: build khong ghi de neu khong --force
  const b = build(opts({ apply: true }));
  expect(b.problems.some((p) => p.includes('t/claude/alpha') && p.includes('--force'))).toBe(true);
  expect(r('t/claude/alpha/SKILL.md')).toBe('sua tay');
  build(opts({ apply: true, force: true }));
  expect(check(opts()).ok).toBe(true);
  // trung ten skill khong marker -> conflict, build tu choi
  w('src/ai-job-search/SKILL.md', 'nguon trung ten');
  expect(check(opts()).issues).toContainEqual({ skill: 'ai-job-search', target: 't/claude/ai-job-search', issue: 'conflict' });
  build(opts({ apply: true }));
  expect(r('t/claude/ai-job-search/SKILL.md')).toBe('installed');
});

test('prune: dry-run mac dinh; --apply chi xoa dich co marker; bo qua skill khong marker', () => {
  build(opts({ apply: true }));
  fs.rmSync(path.join(root, 'src', 'beta'), { recursive: true });
  w('t/claude/manual-skill/SKILL.md', 'khong marker');
  const dry = prune(opts());
  expect(dry.items.map((i) => i.target).sort()).toEqual(['t/agents/beta', 't/claude/beta']);
  expect(ex('t/claude/beta')).toBe(true);
  expect(check(opts()).issues.filter((i) => i.issue === 'orphan').length).toBe(2);
  const res = prune(opts({ apply: true }));
  expect(res.items.every((i) => i.removed)).toBe(true);
  expect(ex('t/claude/beta')).toBe(false);
  expect(ex('t/agents/beta')).toBe(false);
  expect(r('t/claude/ai-job-search/SKILL.md')).toBe('installed');
  expect(r('t/agents/linkedin-search/SKILL.md')).toBe('installed');
  expect(r('t/claude/manual-skill/SKILL.md')).toBe('khong marker');
  expect(ex('t/claude/alpha')).toBe(true);
  expect(prune(opts({ apply: true })).items).toEqual([]);
});

test('marker hong / cua cong cu khac / source ngoai srcDir: prune --apply va build khong dung, chi canh bao', () => {
  build(opts({ apply: true }));
  w(`t/claude/broken/${MARKER}`, '{khong phai json');
  w('t/claude/broken/SKILL.md', 'x');
  w(`t/claude/other-tool/${MARKER}`, JSON.stringify({ generator: 'tool-khac', source: 'src/other-tool', hash: 'a'.repeat(64) }));
  w(`t/claude/outside/${MARKER}`, JSON.stringify({ source: '../ngoai/outside', hash: 'b'.repeat(64) }));
  w(`t/claude/nohash/${MARKER}`, JSON.stringify({ source: 'src/nohash' }));
  w(`t/agents/alpha/${MARKER}`, '"chuoi"');
  const res = prune(opts({ apply: true, force: true }));
  for (const d of ['broken', 'other-tool', 'outside', 'nohash']) {
    expect(ex(`t/claude/${d}/${MARKER}`)).toBe(true);
    expect(res.problems.some((p) => p.includes(`t/claude/${d}`) && p.includes('marker khong hop le'))).toBe(true);
  }
  expect(res.items.every((i) => !i.removed)).toBe(true);
  const b = build(opts({ apply: true, force: true }));
  expect(b.problems.some((p) => p.includes('t/agents/alpha') && p.includes('marker khong hop le'))).toBe(true);
  expect(r(`t/agents/alpha/${MARKER}`)).toBe('"chuoi"');
  expect(check(opts()).issues.filter((i) => i.issue === 'badmarker').length).toBe(5);
});

test('prune: orphan bi sua tay chi xoa khi --force', () => {
  build(opts({ apply: true }));
  fs.rmSync(path.join(root, 'src', 'beta'), { recursive: true });
  w('t/claude/beta/SKILL.md', 'sua tay');
  const res = prune(opts({ apply: true }));
  expect(res.items.find((i) => i.target === 't/claude/beta')).toMatchObject({ removed: false, skipped: 'edited' });
  expect(res.problems.some((p) => p.includes('t/claude/beta') && p.includes('--force'))).toBe(true);
  expect(ex('t/claude/beta')).toBe(true);
  expect(ex('t/agents/beta')).toBe(false); // khong sua tay -> xoa binh thuong
  const lines = [];
  expect(main(['prune', '--root', root, '--src', 'src', '--target', 't/claude', '--apply', '--force'], { out: (s) => lines.push(s), err: () => {} })).toBe(0);
  expect(ex('t/claude/beta')).toBe(false);
});

test('ghi nguyen tu: loi giua chung giu ban cu co marker, khong de thu muc rac', () => {
  build(opts({ apply: true }));
  const before = snapshot('t/claude/alpha');
  w('src/alpha/SKILL.md', 'alpha moi');
  const leftovers = () => fs.readdirSync(path.join(root, 't', 'claude')).filter((n) => n.startsWith('.'));
  // 1) loi khi ghi file vao ban dang dung
  let n = 0;
  const failWrite = { write: (f, b) => { if (++n === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); fs.writeFileSync(f, b); } };
  let res = build(opts({ apply: true, targets: ['t/claude'], fsOps: failWrite }));
  expect(res.problems.some((p) => p.includes('t/claude/alpha') && p.includes('giu ban cu'))).toBe(true);
  expect(snapshot('t/claude/alpha')).toEqual(before);
  expect(leftovers()).toEqual([]);
  // 2) rename dich cu that bai (EPERM Windows) -> giu nguyen
  const eperm = () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); };
  res = build(opts({ apply: true, targets: ['t/claude'], fsOps: { rename: eperm } }));
  expect(res.problems.some((p) => p.includes('EPERM'))).toBe(true);
  expect(snapshot('t/claude/alpha')).toEqual(before);
  expect(leftovers()).toEqual([]);
  // 3) rename ban moi vao cho that bai -> tra ban cu ve
  let k = 0;
  const failSecond = { rename: (a, b) => { if (++k === 2) throw Object.assign(new Error('boom'), { code: 'EIO' }); fs.renameSync(a, b); } };
  res = build(opts({ apply: true, targets: ['t/claude'], fsOps: failSecond }));
  expect(res.problems.some((p) => p.includes('EIO'))).toBe(true);
  expect(snapshot('t/claude/alpha')).toEqual(before);
  expect(leftovers()).toEqual([]);
  // binh thuong: thay the thanh cong, khong rac
  build(opts({ apply: true, targets: ['t/claude'] }));
  expect(r('t/claude/alpha/SKILL.md')).toBe('alpha moi');
  expect(leftovers()).toEqual([]);
});

test('gioi han: cay qua sau/qua nhieu thu muc bi chan; timeout -> truncated', () => {
  w('src/deep/SKILL.md', 'd');
  w('src/deep/a/b/c/d/x.txt', 'x');
  const res = build(opts({ limits: { maxDepth: 2 } }));
  expect(res.problems.some((p) => p.startsWith('deep:') && p.includes('do sau'))).toBe(true);
  const res2 = build(opts({ limits: { maxDirsPerSkill: 2 } }));
  expect(res2.problems.some((p) => p.startsWith('deep:') && p.includes('thu muc'))).toBe(true);
  build(opts({ apply: true }));
  fs.rmSync(path.join(root, 'src', 'beta'), { recursive: true });
  const p = prune(opts({ apply: true, timeoutS: -1 }));
  expect(p.truncated).toBe('timeout');
  expect(ex('t/claude/beta')).toBe(true);
});

test('cli: lenh sai -> 2; --json tra data; build khong --apply khong ghi', () => {
  const sink = { out: () => {}, err: () => {} };
  expect(main(['nope', '--root', root], sink)).toBe(2);
  expect(main(['build', '--target'], sink)).toBe(2);
  const got = [];
  expect(main(['build', '--root', root, '--src', 'src', '--target', 't/claude', '--json'], { out: (s) => got.push(s), err: () => {} })).toBe(0);
  expect(JSON.parse(got[0]).apply).toBe(false);
  expect(ex('t/claude/alpha')).toBe(false);
});

test('adopt: chi thay dich khong marker khi noi dung trung nguon; khac nguon thi giu', () => {
  w('t/claude/beta/SKILL.md', '---\nname: beta\n---\nB\n');
  w('t/claude/alpha/SKILL.md', 'viet tay khac nguon');
  expect(build(opts({ apply: true })).problems.some((p) => p.includes('t/claude/beta'))).toBe(true);
  expect(ex('t/claude/beta/' + MARKER)).toBe(false);
  const res = build(opts({ apply: true, adopt: true }));
  expect(ex('t/claude/beta/' + MARKER)).toBe(true);
  expect(res.items.some((i) => i.action === 'adopt' && i.target === 't/claude/beta')).toBe(true);
  expect(r('t/claude/alpha/SKILL.md')).toBe('viet tay khac nguon');
  expect(r('t/claude/ai-job-search/SKILL.md')).toBe('installed');
});

test('khong --src va nguon mac dinh khong ton tai: build/check in 1 dong giai thich, exit 0, khong ghi gi', () => {
  for (const cmd of ['check', 'build']) {
    const lines = [];
    const code = main([cmd, '--root', root, '--target', 't/claude', '--apply'], { out: (s) => lines.push(s), err: () => {} });
    expect(code).toBe(0);
    const txt = lines.join('\n');
    expect(txt).toContain('không có nguồn skill tại');
    expect(txt).toContain('--src');
    expect(txt).toContain('plugin native');
  }
  expect(ex('t/claude/alpha')).toBe(false); // khong ghi gi
});
