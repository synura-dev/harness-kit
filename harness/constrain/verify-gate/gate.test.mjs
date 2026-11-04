import { test, expect } from 'bun:test';
import { DEFAULTS } from './hook.mjs';
import { decide, kindOf, shellWrites } from './gate.mjs';

let n = 0;
const T = () => new Date(Date.UTC(2026, 9, 29, 9, 0, n++)).toISOString();
const edit = (file, extra = {}) => ({ ts: T(), type: 'tool', event: 'PostToolUse', tool: 'Edit', target: file, ok: true, data: {}, ...extra });
const sh = (cmd, data = {}, extra = {}) => ({ ts: T(), type: 'tool', event: 'PostToolUse', tool: 'Bash', target: cmd, ok: true, data: { bg: false, ...data }, ...extra });
const pass = (cmd, extra = {}) => sh(cmd, { verifier_outcome: 'pass' }, extra);
const D = (evs, opts) => decide(evs, DEFAULTS, opts);

test('verify_kind null cua audit duoc tin (khong du phong verifyKind)', () => {
  expect(kindOf({ target: 'bun test', data: { verify_kind: null } })).toBe(null);
  expect(kindOf({ target: 'bun test', data: {} })).toBe('test'); // thieu khoa -> du phong
  expect(kindOf({ target: 'bun test', data: { verify_kind: 'xyz' } })).toBe('test'); // gia tri la -> du phong
  expect(D([edit('a.ts'), sh('bun test', { verify_kind: null, verifier_outcome: 'pass' })]).decision).toBe('block');
});

test('lenh khong chay kiem chung (help/version/no-run) khong la bang chung', () => {
  for (const c of ['tsc --version', 'bun test --help', 'jest --listTests', 'cargo test --no-run', 'go test -run ^$ ./...'])
    expect([c, D([edit('a.ts'), sh(c, { exit_code: 0 })]).decision]).toEqual([c, 'block']);
});

test('deploy theo lenh thuc thi, khong theo chu trong duong dan', () => {
  for (const c of ['cat docs/deploy-x.log', 'ls deploy/', 'grep -r deploy src', 'echo "npm run deploy"', 'git log -- deploy.sh', 'cat deploy.sh', 'node -e "deploy()"'])
    expect([c, D([sh(c)]).code]).toEqual([c, 'no_change']);
  for (const c of ['npm run deploy', 'bun run deploy:prod', 'yarn deploy', './deploy.sh', 'bash scripts/deploy.sh prod', '& "C:\\app\\deploy.ps1"', 'pwsh -File deploy.ps1',
    'cd app && ./deploy.sh', 'pm2 reload all', 'sudo systemctl restart app', 'ssh srv "cd app && pm2 reload all"', "ssh -i k.pem u@h 'bash deploy.sh'", 'ssh h ./deploy.sh',
    'vercel --prod', 'fly deploy', 'docker compose up -d', 'kubectl apply -f k.yaml', 'git status && npm run deploy'])
    expect([c, D([sh(c)]).code]).toEqual([c, 'missing_deploy']);
});

test('sua code qua shell: redirect/tee/sed -i/perl -i/heredoc/Set-Content -> tinh la sua code', () => {
  const cases = {
    'echo x > src/a.ts': ['src/a.ts'], 'echo x >> a.py': ['a.py'], 'printf x | tee b.js': ['b.js'], 'tee -a "c.mjs" < in.txt': ['c.mjs'],
    "sed -i 's/a/b/' x.ts": ['x.ts'], "sed -Ei.bak 's/a/b/' y.go": ['y.go'], "perl -pi -e 's/a/b/' z.rs": ['z.rs'], 'cat > f.ts <<EOF\nconst a = b > c.ts;\nEOF': ['f.ts'],
    "Set-Content -Path a.ps1 -Value 'x'": ['a.ps1'], "'x' | Out-File -FilePath o.cs": ['o.cs'], "Add-Content b.ts 'x'": ['b.ts'], "@'\nx > y.ts\n'@ | Set-Content s.ts": ['s.ts'],
    'cp tmp.txt src/a.ts': ['src/a.ts'], 'echo x &> l.ts': ['l.ts'],
  };
  for (const [c, f] of Object.entries(cases)) {
    expect([c, shellWrites(c).filter((x) => /\.(ts|py|js|mjs|go|rs|ps1|cs)$/.test(x))]).toEqual([c, f]);
    expect([c, D([sh(c)]).decision]).toEqual([c, 'block']);
  }
  for (const c of ['bun test 2>&1', 'bun test > out.log', 'echo "a > b.ts"', 'git diff > x.patch', 'ls >/dev/null', 'node -e "x=>y.ts"', 'cat a.ts'])
    expect([c, D([sh(c)]).code]).toEqual([c, 'no_change']);
  // sua qua shell roi test pass -> cho qua; PostToolUseFailure van tinh la da ghi
  expect(D([sh('echo x > a.ts'), pass('bun test')]).decision).toBe('allow');
  expect(D([{ ...sh('echo x > a.ts && false'), event: 'PostToolUseFailure', ok: false }]).decision).toBe('block');
  // target bi cat 160: dung ca target va cmd_line
  expect(D([sh('echo ' + 'x'.repeat(150), { target_truncated: true, cmd_line: 'sed -i s/a/b/ q.ts' })]).decision).toBe('block');
});

test('bang chung chi hop le cho file trong thu muc chay (to tien) hoac cung git root', () => {
  const cwd = 'E:/hub';
  // cd thu muc khac: khong phu file o E:/hub/src
  expect(D([edit('E:/hub/src/a.ts', { cwd }), pass('cd ../other && bun test', { cwd })], { cwd }).decision).toBe('block');
  expect(D([edit('E:\\hub\\src\\a.ts', { cwd }), pass('cd /d E:\\other && bun test', { cwd })], { cwd }).decision).toBe('block');
  // to tien: cwd hub, hoac cd vao chinh thu muc file
  expect(D([edit('E:/hub/src/a.ts', { cwd }), pass('bun test', { cwd })], { cwd }).decision).toBe('allow');
  expect(D([edit('E:/hub/src/a.ts', { cwd }), pass('cd src && bun test', { cwd })], { cwd }).decision).toBe('allow');
  expect(D([edit('/e/hub/src/a.ts', { cwd }), pass('bun test', { cwd: 'e:\\HUB' })], { cwd }).decision).toBe('allow'); // git-bash + hoa/thuong
  // thu muc con khac nhanh: chi hop le khi cung git root
  const rootOf = (d) => (d.startsWith('e:/hub') ? 'e:/hub' : null);
  const evs = [edit('E:/hub/src/a.ts', { cwd }), pass('cd lib && bun test', { cwd })];
  expect(D(evs, { cwd }).decision).toBe('block');
  expect(D(evs, { cwd, rootOf }).decision).toBe('allow');
  // sua 2 du an, chi test 1 -> block; test ca 2 sau lan sua cuoi -> cho qua
  const two = [edit('E:/p1/a.ts', { cwd: 'E:/p1' }), edit('E:/p2/b.ts', { cwd: 'E:/p2' }), pass('bun test', { cwd: 'E:/p2' })];
  expect(D(two).decision).toBe('block');
  expect(D([...two, pass('cd E:/p1 && bun test', { cwd: 'E:/p2' })]).decision).toBe('allow');
  // file ghi qua shell resolve theo thu muc chay
  expect(D([sh('cd E:/p1 && echo x > a.ts', {}, { cwd: 'E:/p2' }), pass('bun test', { cwd: 'E:/p2' })]).decision).toBe('block');
  // cd khong xac dinh ($VAR, ~) -> coi nhu cwd phien, dem cwdAssumed
  const r = D([edit('E:/hub/a.ts', { cwd }), pass('cd $OTHER && bun test', { cwd })], { cwd });
  expect(r.decision).toBe('allow');
  expect(r.cwdAssumed).toBe(1);
  // khong co cwd o dau ca -> khong xac dinh -> coi nhu cung (giu hanh vi cu)
  expect(D([edit('src/a.ts'), pass('bun test')]).decision).toBe('allow');
});
