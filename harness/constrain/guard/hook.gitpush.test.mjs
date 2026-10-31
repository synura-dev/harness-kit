// git-force-push: luat loi chan push pha huy; push thuong khong bi chan; khong ReDoS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, evaluate, decide, FALLBACK_CORE_RULES } from './hook.mjs';

const CORE = [path.join(path.dirname(fileURLToPath(import.meta.url)), 'hook.config.json')];
const mk = () => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'guardgp-')); fs.mkdirSync(path.join(h, 'config', 'guard', 'projects'), { recursive: true }); return h; };
const w = (h, rel, o) => fs.writeFileSync(path.join(h, 'config', 'guard', rel), JSON.stringify(o));
const cfg = (h = mk(), env = {}) => load(CORE, { env, hubRoot: h }).config;
const id = (c, cmd) => evaluate(cmd, c)?.id ?? null;
const BT = '\x60';

const BLOCK = [
  'git push --force origin main', 'git push -f origin main', 'git push origin main --force', 'git push --force-with-lease origin main',
  'git push --force-with-lease=main origin main', 'git push origin +main', 'git push origin HEAD:+main', 'git push --mirror', 'git push --delete origin feat',
  'git push -d origin feat', 'git push origin :feat', 'git push -uf origin feat', 'git push --del origin x', 'git push --mirr', 'git push --prune origin',
  'git push --force-if-includes --force origin main',
  'cd x && git push -f', 'git -C "E:/a b" push --force', 'git -C path push -f', 'git -c user.name=x push origin +main', 'git --no-pager push -f',
  'git --git-dir ../x push -f', 'git --work-tree /w push -f', 'git --namespace n push -f',
  'sudo git push -f', 'env VAR=1 git push --force', 'FOO=1 git push -f', 'echo hi; git push --mirror', 'git.exe push -f', 'GIT push --FORCE',
  'git fetch && git push origin +main || true',
  'sh -c "git push origin main -f"', '$(git push -f)', BT + 'git push -f' + BT, 'git push -f;echo', 'git push -f>log', 'git push -f|cat',
  'git push "--force"', "git push '-f'", 'git push \\--force', 'git push origin "+main"', "git push origin ':main'",
  'git push \\\norigin main -f', 'git push ' + BT + '\n-f', 'git push origin main \\\r\n--force',
  'git -c alias.p="push -f" p origin main', 'git -c remote.origin.push=+refs/heads/*:refs/heads/* push', 'git send-pack --force url',
  'git -c ' + '-c '.repeat(60) + '; git push --force origin main',
];
const PASS = [
  'git status', 'git push origin main', 'git push -u origin feature', 'git push origin HEAD:feature', 'git push --follow-tags', 'git push --dry-run origin main',
  'git commit -m "no --force"', 'git commit -m "x" && git log --force-like', 'git push origin main && git commit -m "--force"', 'git push origin feature-f',
  'git push --force-if-includes origin main', 'git send-pack url',
];
// Gioi han da biet (chap nhan chan nham de khong bo lot): chuoi nhac lenh nam trong echo/-m.
const KNOWN_FP = ['echo "git push --force"', 'git commit -m "doc: git push --force bi cam"'];

test('git-force-push: cac bien the bi chan', () => {
  const c = cfg();
  for (const cmd of BLOCK) assert.equal(id(c, cmd), 'git-force-push', JSON.stringify(cmd));
});
test('git-force-push: push thuong va chuoi giong khong bi chan', () => {
  const c = cfg();
  for (const cmd of PASS) assert.equal(id(c, cmd), null, cmd);
});
test('git-force-push: chan nham co chu y (uu tien khong bo lot)', () => {
  const c = cfg();
  for (const cmd of KNOWN_FP) assert.equal(id(c, cmd), 'git-force-push', cmd);
});
test('git-force-push: khong ReDoS (trung vi 3 lan <250ms/chuoi, tong <2s)', () => {
  const c = cfg();
  const bad = [
    'git' + ' -c'.repeat(60), 'git ' + '-c "a" '.repeat(40), 'git ' + '-c '.repeat(60) + '; git push --force origin main',
    'git push '.repeat(11000), 'git '.repeat(25000), 'a'.repeat(100000), 'git push ' + 'x '.repeat(50000), ('git -c x ' + 'a'.repeat(250) + ' ').repeat(400),
  ];
  // ReDoS that tang mu (giay+); nguong bat 'bung no', khong phai micro-benchmark (full suite song song gay nhieu).
  let total = 0;
  for (const s of bad) {
    const runs = []; let got;
    for (let i = 0; i < 3; i++) { const t = performance.now(); got = id(c, s); runs.push(performance.now() - t); }
    runs.sort((a, b) => a - b); const ms = runs[1]; total += ms;
    assert.ok(ms < 250, s.slice(0, 30) + ' mat ' + ms.toFixed(1) + 'ms');
    if (s.includes('push --force')) assert.equal(got, 'git-force-push');
  }
  assert.ok(total < 2000, 'tong ' + total.toFixed(0) + 'ms');
});
test('git-force-push: du an/env khong tat duoc, may tat duoc', () => {
  const h = mk();
  w(h, 'projects/p.json', { denyPatterns: [{ id: 'git-force-push', disable: true }, { id: 'git-force-push', regex: 'zzz' }] });
  const c = cfg(h, { GUARD_PROJECT: 'p', HARNESS_GUARD_DENY_PATTERNS: JSON.stringify([{ id: 'git-force-push', disable: true }]) });
  assert.equal(id(c, 'git push -f'), 'git-force-push');
  const h2 = mk();
  w(h2, 'local.json', { denyPatterns: [{ id: 'git-force-push', disable: true }] });
  assert.equal(id(cfg(h2), 'git push -f'), null);
});
test('git-force-push: luat loi du phong cung = regex trong hook.config.json', () => {
  const h = mk();
  const conf = JSON.parse(fs.readFileSync(CORE[0], 'utf8')).denyPatterns.find((r) => r.id === 'git-force-push');
  assert.equal(FALLBACK_CORE_RULES.find((r) => r.id === 'git-force-push').regex, conf.regex);
  const r = load([path.join(h, 'missing.json')], { env: {}, hubRoot: h });
  assert.ok(r.warnings.some((x) => /core-config-fallback/.test(x)));
  assert.equal(id(r.config, 'git push origin +main'), 'git-force-push');
  assert.equal(id(r.config, 'git push origin main'), null);
});
test('git-force-push: log chi co id/hash/len, khong co lenh tho; reason huong dan hoi human', () => {
  const cmd = 'git push --force origin secretbranch';
  const d = decide({ tool_name: 'Bash', tool_input: { command: cmd } }, cfg());
  assert.equal(d.entry.id, 'git-force-push');
  assert.equal(d.entry.len, cmd.length);
  assert.ok(!JSON.stringify(d.entry).includes('secretbranch'));
  assert.match(d.out.hookSpecificOutput.permissionDecisionReason, /human/i);
});
