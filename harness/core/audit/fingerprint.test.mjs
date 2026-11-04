import { test, expect } from 'bun:test';
import { normalizeError, fingerprint, isVerifyCommand, verifyKind, verifierOutcome, relFiles } from './fingerprint.mjs';
import { validateEvent } from '../config/contract.mjs';

test('fingerprint on dinh khi chi khac duong dan/so dong/timestamp/id/hash', () => {
  const a = 'Error at C:\\Users\\alice\\proj one\\src\\a.ts:12:5 2026-01-02T03:04:05.123Z id 550e8400-e29b-41d4-a716-446655440000 commit deadbeef1234 in /home/bob/x/y.js:99';
  const b = 'Error at D:\\work\\other\\src\\a.ts:340:17 2027-09-09T11:22:33Z id 123e4567-e89b-12d3-a456-426614174000 commit cafe0123abcd in /srv/z/y.js:7';
  expect(fingerprint(a, 'Bash')).toBe(fingerprint(b, 'Bash'));
  expect(fingerprint(a, 'Bash')).toMatch(/^[0-9a-f]{10}$/);
  expect(fingerprint(a, 'Bash')).not.toBe(fingerprint('Error: other problem', 'Bash'));
  expect(fingerprint(a, 'Bash')).not.toBe(fingerprint(a, 'Edit'));
});

test('normalizeError khong con duong dan tuyet doi', () => {
  const n = normalizeError('fail C:\\Users\\x\\a b\\f.js:3 and /usr/local/lib/n.js:5:1 at 12:34:56');
  expect(n).not.toMatch(/Users|usr|local|:\\|12:34/);
  expect(n).toContain('<path>');
});

test('fingerprint rong -> null', () => { expect(fingerprint('   ', 'Bash')).toBeNull(); });

test('isVerifyCommand: chi lenh verify that', () => {
  for (const c of ['bun test harness/core', 'cd /x && bun test', 'timeout 300 bun test a b', 'npm run build', 'tsc --noEmit', 'node harness/cli/commands/doctor.mjs', 'node harness/tools/sync.mjs --check', 'node --test test/*.js', 'FOO=1 pytest -q', 'go test ./...', 'git add . && bun test']) expect(isVerifyCommand(c)).toBe(true);
  for (const c of ['ls -la', 'git status', 'echo bun test', 'bun test | tail -5', 'bun test; true', 'bun test || true', 'cat tsc.json', 'npm install', 'rm -rf build', '']) expect(isVerifyCommand(c)).toBe(false);
});

test('verifyKind: phan loai tat dinh theo lenh', () => {
  const cases = {
    'bun test harness/core': 'test', 'cd /x && timeout 120 bun test a': 'test', 'npm run test': 'test', 'npx vitest run': 'test', 'node --test t/*.js': 'test',
    'FOO=1 pytest -q': 'test', 'go test ./...': 'test', 'cargo test': 'test',
    'tsc --noEmit': 'tsc', 'bunx tsc -p .': 'tsc', 'npm run typecheck': 'tsc',
    'npm run lint': 'lint', 'npx eslint src': 'lint', 'timeout 120 npx biome check "src/a.tsx"': 'lint', 'node harness/cli/commands/doctor.mjs': 'lint', 'node harness/tools/sync.mjs --check': 'lint', 'go vet ./...': 'lint',
    'npm run build': 'build', 'bun run build': 'build', 'cargo build --release': 'build',
    'git rev-parse HEAD': 'hash', 'sha256sum dist/app.js': 'hash', 'Get-FileHash a.zip': 'hash',
    'curl -fsS http://localhost:3000/health': 'health', 'curl -sf "https://api.x.com/healthz"': 'health', 'wget -qO- http://h/health?x=1': 'health',
    'bun run build && bun test': 'test', 'git add . && bun test': 'test',
  };
  for (const [c, k] of Object.entries(cases)) expect([c, verifyKind(c)]).toEqual([c, k]);
  for (const c of ['ls -la', 'git status', 'echo bun test', 'bun test | tail -5', 'bun test; true', 'bun test || true', 'bun test &', 'npm install', 'curl http://x/api',
    'curl http://x/healthy', 'git log -1', 'bun test\nls', '', null]) expect([c, verifyKind(c)]).toEqual([c, null]);
});

test('co help/version/list/no-run/dry-run -> khong phai verify (kind null)', () => {
  for (const c of ['tsc --version', 'tsc -v --version', 'bunx tsc --help', 'tsc -h', 'bun test --help', 'npm test -- --help', 'jest --listTests', 'npx jest --listTests',
    'cargo test --no-run', 'cargo test -- --list', 'go test -run ^$ ./...', "go test -run '^$' ./...", 'go test -run=^$ ./...', 'go test -list . ./...',
    'pytest --collect-only', 'pytest --co -q', 'npx vitest list', 'npm run build -- --dry-run', 'eslint --print-config a.js', 'tsc --showConfig', 'tsc --init',
    'cargo build --version', 'cd /x && bun test --help', 'git add . && tsc --version'])
    { expect([c, verifyKind(c)]).toEqual([c, null]); expect([c, isVerifyCommand(c)]).toEqual([c, false]); }
  // khong nham: -v cua pytest la verbose, -run voi mau that van chay test; doan khac trong && van tinh
  for (const [c, k] of [['pytest -v', 'test'], ['go test -run TestA ./...', 'test'], ['tsc --noEmit', 'tsc'], ['bun test --help && npm run build', 'build'], ['cargo test --release', 'test']])
    { expect([c, verifyKind(c)]).toEqual([c, k]); expect([c, isVerifyCommand(c)]).toEqual([c, true]); }
});

test('verifyKind phu isVerifyCommand: lenh verify cu luon co kind', () => {
  for (const c of ['bun test harness/core', 'npm run build', 'tsc --noEmit', 'node harness/cli/commands/doctor.mjs', 'node --test test/*.js', 'go test ./...', 'cargo clippy']) {
    expect(isVerifyCommand(c)).toBe(true); expect(verifyKind(c)).not.toBeNull();
  }
});

test('& don giua lenh (chay nen) khong phai verify; && va chuyen huong 2>&1, >&2, &> van hop le', () => {
  for (const c of ['npm test & exit 0', 'bun test &exit 0', 'bun test & ', 'cd /x && bun test & true', 'bun test 2>&1 & exit 0', 'bun test &&& true']) {
    expect([c, isVerifyCommand(c)]).toEqual([c, false]); expect([c, verifyKind(c)]).toEqual([c, null]);
  }
  for (const c of ['bun test 2>&1', 'bun test >&2', 'bun test &> out.log', 'bun test &>> out.log', 'bun test 2>&1 && npm run build', 'cd /x && bun test 2>&1']) {
    expect([c, isVerifyCommand(c)]).toEqual([c, true]); expect([c, verifyKind(c)]).not.toEqual([c, null]);
  }
  expect(verifyKind('wget -qO- "http://h/health?a=1&b=2"')).toBe('health'); // & trong chuoi trich dan khong tinh
});

test('health: curl phai co -f/--fail/--fail-with-body; wget mac dinh fail khi 4xx/5xx', () => {
  for (const c of ['curl http://localhost:3000/health', 'curl -s http://h/healthz', 'curl -sS -o /dev/null http://h/health', 'curl -F a=b http://h/health', 'curl --fail-early http://h/health'])
    expect([c, verifyKind(c)]).toEqual([c, null]);
  for (const c of ['curl -f http://h/health', 'curl --fail http://h/health', 'curl --fail-with-body http://h/health', 'curl -sSfL http://h/healthz', 'curl -s -f "http://h/health"', 'wget -q http://h/health'])
    expect([c, verifyKind(c)]).toEqual([c, 'health']);
});

test('verifierOutcome: gan theo exit code that, khong doan', () => {
  const v = { isVerify: true, event: 'PostToolUse', ok: true };
  expect(verifierOutcome(v)).toBe('pass');
  expect(verifierOutcome({ ...v, event: 'PostToolUseFailure', ok: false, exitCode: 1 })).toBe('fail');
  // Quy uoc moi: error that bi cat 200 ky tu, khong co "Exit code N"; PostToolUseFailure chi phat khi tool that bai => fail.
  expect(verifierOutcome({ ...v, event: 'PostToolUseFailure', ok: false })).toBe('fail');
  expect(verifierOutcome({ ...v, event: 'PostToolUseFailure', ok: false, interrupted: true })).toBe('none');
  expect(verifierOutcome({ ...v, interrupted: true })).toBe('none');
  expect(verifierOutcome({ ...v, background: true })).toBe('none');
  expect(verifierOutcome({ ...v, isVerify: false })).toBe('none');
  expect(verifierOutcome({ ...v, event: 'PreToolUse' })).toBe('none');
});

test('relFiles: tuong doi cwd, tran N, ngoai cwd chi ten file', () => {
  expect(relFiles(['E:\\hub\\harness\\a.mjs', 'E:/hub/harness/a.mjs', 'C:\\other\\secret\\b.txt', 'rel/c.js'], 'E:\\hub')).toEqual(['harness/a.mjs', 'b.txt', 'rel/c.js']);
  expect(relFiles(['a', 'b', 'c', 'd'], '/x', 2)).toEqual(['a', 'b']);
  expect(relFiles(null, '/x')).toEqual([]);
});

test('validateEvent: truong moi hop le, du lieu cu van doc duoc, gia tri sai bi bat', () => {
  expect(validateEvent({ ts: '2026-01-01T00:00:00Z', type: 'tool' })).toEqual([]);
  expect(validateEvent({ ts: '2026-01-01T00:00:00Z', type: 'tool', task_id: null, error_fingerprint: 'abc', retry_of: 2, attempt: 3, files_touched: ['a.js'], verifier_outcome: 'pass' })).toEqual([]);
  expect(validateEvent({ ts: '2026-01-01T00:00:00Z', type: 'tool', verifier_outcome: 'maybe', files_touched: 'a', retry_of: 'x' }).length).toBe(3);
});

test('verifyKind: lenh test theo stack (npm/pnpm/yarn, Python, Go, Rust, JVM, .NET, make) la test', () => {
  for (const c of ['npm t', 'pnpm -r test', 'pnpm --filter web test', 'yarn workspace x test', 'npm --prefix pkg test', './node_modules/.bin/jest', 'deno test', 'CI=1 npm t',
    'cd pkg && npm t', 'timeout 90 pnpm -r test', 'python3.11 -m pytest', 'python -m unittest discover', 'uv run pytest', 'poetry run pytest', '.venv/bin/pytest', 'tox', 'hatch run test',
    'cargo +nightly test', 'cargo nextest run', 'dotnet test', 'mvn test', './mvnw verify', './gradlew test', 'phpunit', 'php artisan test', 'bundle exec rspec', 'rake test', 'make test', 'ctest'])
    expect([c, verifyKind(c), isVerifyCommand(c)]).toEqual([c, 'test', true]);
});

test('verifyKind: lenh test theo stack co help/no-run/pipe/nen -> khong phai verify', () => {
  for (const c of ['pytest --collect-only', 'cargo nextest run --dry-run', 'dotnet test --help', 'make test --just-print', 'npm t | tail -5', 'pytest; echo ok', 'tox || true', 'npm t &', 'mvn -v', 'make build', 'python main.py', 'npm install'])
    expect([c, verifyKind(c)]).toEqual([c, null]);
  expect(verifyKind('pytest -n auto')).toBe('test'); // -n la so worker xdist, khong phai no-run
});

test('verifyKind: lenh bo test (mvn -DskipTests, gradle -x test) va chay thu (make/just -n) khong phai bang chung', () => {
  for (const c of ['mvn verify -DskipTests', 'mvn test -Dmaven.test.skip=true', 'mvn verify -DskipITs', './mvnw verify -DskipTests=true', './gradlew build -x test', 'gradle check -x test',
    './gradlew check --exclude-task test', 'make -n test', 'make test -n', 'gmake -nk test', 'just -n test', 'make --just-print check', 'make --recon test', 'just --dry-run test'])
    expect([c, verifyKind(c)]).toEqual([c, null]);
  for (const c of ['mvn verify -DskipTests=false', 'mvn test -Dtest=FooTest', './gradlew test --tests Foo', './gradlew check -x lint', 'make test -j4', 'make -C build test', 'pytest -n auto', 'just test'])
    expect([c, verifyKind(c)]).toEqual([c, 'test']);
});

test('verifyKind: sbt test/testOnly la test', () => {
  for (const c of ['sbt test', 'sbt testOnly com.x.FooSpec', 'sbt "testOnly com.x.FooSpec"', 'sbt clean test']) expect([c, verifyKind(c)]).toEqual([c, 'test']);
  for (const c of ['sbt compile', 'sbt test --help']) expect([c, verifyKind(c)]).toEqual([c, null]);
});

test('verifyKind: ten goi/thu muc la "test" khong lam subcommand bi nham la test', () => {
  for (const c of ['npm --prefix test install', 'pnpm --filter test build', 'pnpm --filter=test build', 'npm -w test run build', 'yarn workspace test build', 'npm --prefix test run lint'])
    expect([c, verifyKind(c) === 'test']).toEqual([c, false]);
  for (const c of ['npm --prefix test test', 'pnpm --filter test test', 'pnpm --filter=test run test', 'npm -w test t', 'yarn workspace test test'])
    expect([c, verifyKind(c)]).toEqual([c, 'test']);
});
