// verify-gate theo stack: lenh test cua npm/pnpm/yarn/Python/Go/Rust/... duoc tinh la bang chung; du an khong co runner thi khong chan.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, run } from './hook.mjs';
import { decide, localKind, evidenceOf, runnerSpec } from './gate.mjs';
import { verifyKind } from '../../core/audit/fingerprint.mjs';

let n = 0;
const T = () => new Date(Date.UTC(2026, 9, 29, 9, 0, n++)).toISOString();
const cwd = 'e:/p';
const rootOf = () => 'e:/p';
const edit = (f) => ({ ts: T(), type: 'tool', event: 'PostToolUse', tool: 'Edit', target: 'E:/p/' + f, cwd, ok: true, data: { files_touched: [f] } });
// Phong envelope audit that: lenh core khong nhan -> verify_kind null, verifier_outcome none.
const sh = (c, extra = {}, data = {}) => {
  const k = verifyKind(c);
  return { ts: T(), type: 'tool', event: 'PostToolUse', tool: 'Bash', target: c, cwd, ok: true, data: { bg: false, verify_kind: k, verifier_outcome: k ? 'pass' : 'none', ...data }, ...extra };
};
const D = (evs, opts = {}) => decide(evs, DEFAULTS, { cwd, rootOf, ...opts }).decision;

const CASES = {
  'a.js': ['npm test', 'npm t', 'npm run test:unit', 'npm run test', 'pnpm -r test', 'pnpm --filter web test', 'yarn workspace x test', 'npm --prefix pkg test',
    'npm run test --workspaces', 'npx mocha', './node_modules/.bin/jest', 'deno test', 'bun test', 'cd pkg && npm t', 'CI=1 npm t', 'timeout 90 pnpm -r test'],
  'a.py': ['pytest', 'python -m pytest', 'python3.11 -m pytest', 'py -3 -m unittest', 'python -m unittest discover', 'uv run pytest', 'poetry run pytest',
    '.venv/bin/pytest', 'tox', 'nox', 'hatch run test'],
  'a.go': ['go test ./...'],
  'a.rs': ['cargo test', 'cargo +nightly test', 'cargo nextest run', 'cargo t'],
  'a.cs': ['dotnet test'], 'a.java': ['mvn test', './mvnw verify', './gradlew test', 'gradle check'], 'a.php': ['phpunit', 'php artisan test', 'composer test'],
  'a.rb': ['bundle exec rspec', 'rake test'], 'a.c': ['make test', 'make -C build check', 'ctest'],
};

test('lenh test theo stack tinh la bang chung pass sau khi sua', () => {
  for (const [f, cmds] of Object.entries(CASES))
    for (const c of cmds) expect([f, c, D([edit(f), sh(c)])]).toEqual([f, c, 'allow']);
});

test('khong co bang chung: lenh khong phai test, help/dry-run, pipe, that bai, truoc lan sua cuoi', () => {
  for (const c of ['ls', 'python main.py', 'npm install', 'npm run build:docs-test-x', 'make build', 'pytest --collect-only', 'cargo nextest run --dry-run', 'dotnet test --help',
    'npm t | tail -5', 'pytest; echo ok', 'tox || true', 'npm t &', 'mvn -v'])
    expect([c, localKind(c) === null || D([edit('a.py'), sh(c)]) === 'block']).toEqual([c, true]);
  for (const c of ['ls', 'pytest --collect-only', 'cargo nextest run --dry-run', 'dotnet test --help', 'npm t | tail -5', 'tox || true', 'npm t &'])
    expect([c, D([edit('a.py'), sh(c)])]).toEqual([c, 'block']);
  // that bai (PostToolUseFailure / exit != 0) -> block
  expect(D([edit('a.py'), { ...sh('uv run pytest'), event: 'PostToolUseFailure', ok: false }])).toBe('block');
  expect(D([edit('a.py'), sh('uv run pytest', {}, { exit_code: 1 })])).toBe('block');
  expect(D([edit('a.py'), sh('uv run pytest', {}, { bg: true })])).toBe('block');
  // test truoc lan sua cuoi
  expect(D([edit('a.py'), sh('uv run pytest'), edit('b.py')])).toBe('block');
  // thu muc khac git root khong phu
  expect(D([edit('a.py'), sh('uv run pytest', { cwd: 'e:/other' })], { rootOf: (d) => (d.startsWith('e:/p') ? 'e:/p' : 'e:/other') })).toBe('block');
});

test('audit da nhan loai (verify_kind) thi giu nguyen, khong du phong de ghi de', () => {
  // verify_kind null cua audit cho lenh core nhan (vd co pipe) van duoc tin: du phong chi them lenh core khong nhan
  expect(D([edit('a.ts'), sh('bun test', {}, { verify_kind: null, verifier_outcome: 'pass' })])).toBe('block');
  expect(evidenceOf(sh('bun test'))).toEqual({ kind: 'test', outcome: 'pass' });
  expect(evidenceOf(sh('uv run pytest'))).toEqual({ kind: 'test', outcome: 'pass' });
  expect(evidenceOf(sh('echo hi'))).toEqual({ kind: null, outcome: 'none' });
});

test('runnerSpec: JS/sh luon tinh, stack khac can manifest', () => {
  expect(runnerSpec('a.ts')).toBe(null);
  expect(runnerSpec('x.sh')).toBe(null);
  expect(runnerSpec('a.PY')).not.toBe(null);
});

test('thong diep block neu ro tep va lenh goi y theo stack', () => {
  const r = decide([edit('a.py'), edit('b.go')], DEFAULTS, { cwd, rootOf });
  expect(r.decision).toBe('block');
  expect(r.reason).toMatch(/test\/tsc/);
  expect(r.reason).toMatch(/e:\/p\/a\.py/);
  expect(r.reason).toMatch(/pytest \| go test \.\/\.\.\./);
});

// ---- hook that: du an gia co .git + manifest tren dia ----
const NOW = new Date('2026-10-29T10:00:00.000Z');
const SID = 'stk-1';
let m = 0;
const ts = () => new Date(NOW.getTime() - 600000 + (m++) * 1000).toISOString();
function put(root, type, env) {
  const dir = path.join(root, 'date=2026-10-29', `type=${type}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `claude-${SID}.jsonl`), JSON.stringify({ v: 2, sid: `claude-${SID}`, agent_id: null, ...env, type }) + '\n');
}
function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgstk-'));
  fs.mkdirSync(path.join(dir, '.git'));
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
  return dir.replace(/\\/g, '/');
}
function verdict(proj, srcFile, cmd = null) {
  const audit = fs.mkdtempSync(path.join(os.tmpdir(), 'vgaud-'));
  put(audit, 'prompt', { ts: ts(), event: 'UserPromptSubmit' });
  put(audit, 'tool', { ts: ts(), event: 'PostToolUse', tool: 'Edit', target: `${proj}/${srcFile}`, cwd: proj, ok: true, data: { files_touched: [srcFile] } });
  if (cmd) { const k = verifyKind(cmd); put(audit, 'tool', { ts: ts(), event: 'PostToolUse', tool: 'Bash', target: cmd, cwd: proj, ok: true, data: { bg: false, verify_kind: k, verifier_outcome: k ? 'pass' : 'none' } }); }
  try { return run({ hook_event_name: 'Stop', session_id: SID, stop_hook_active: false, cwd: proj }, { cfg: DEFAULTS, root: audit, now: NOW }); } finally { fs.rmSync(audit, { recursive: true, force: true }); }
}

test('hook: du an npm/pnpm/yarn, Python, Go, Rust co runner -> chan khi chua test, cho qua khi da test', () => {
  const projs = [
    [{ 'package.json': '{"scripts":{"test":"node --test"}}' }, 'src/a.js', 'npm t'],
    [{ 'package.json': '{"scripts":{"test":"vitest"}}' }, 'src/a.ts', 'pnpm -r test'],
    [{ 'pyproject.toml': '[project]\nname="x"\n' }, 'pkg/a.py', 'uv run pytest'],
    [{ 'go.mod': 'module x\n' }, 'cmd/a.go', 'go test ./...'],
    [{ 'Cargo.toml': '[package]\nname="x"\n' }, 'src/a.rs', 'cargo nextest run'],
    [{}, 'src/a.ts', 'bun test'], // JS khong manifest (bun test) van duoc gate
  ];
  const made = [];
  try {
    for (const [files, src, cmd] of projs) {
      const p = project(files); made.push(p);
      expect([src, verdict(p, src).decision]).toEqual([src, 'block']);
      expect([src, cmd, verdict(p, src, cmd).decision]).toEqual([src, cmd, 'allow']);
    }
  } finally { for (const p of made) fs.rmSync(p, { recursive: true, force: true }); }
});

test('hook: du an khong co runner nhan ra (py/go/rs khong manifest) -> khong chan', () => {
  const made = [];
  try {
    for (const src of ['a.py', 'sub/a.go', 'a.rs', 'a.java', 'a.rb']) {
      const p = project({ 'README.md': 'x' }); made.push(p);
      const r = verdict(p, src);
      expect([src, r.decision, r.code]).toEqual([src, 'allow', 'edits_ignored']);
    }
    // manifest o thu muc cha (monorepo) van tinh la co runner
    const mono = project({ 'pyproject.toml': 'x' }); made.push(mono);
    expect(verdict(mono, 'svc/deep/a.py').decision).toBe('block');
    // manifest nam NGOAI git root khong tinh
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'vgout-')); made.push(outer);
    fs.writeFileSync(path.join(outer, 'go.mod'), 'module x\n'); fs.mkdirSync(path.join(outer, 'in', '.git'), { recursive: true });
    expect(verdict(path.join(outer, 'in').replace(/\\/g, '/'), 'a.go').decision).toBe('allow');
  } finally { for (const p of made) fs.rmSync(p, { recursive: true, force: true }); }
});
