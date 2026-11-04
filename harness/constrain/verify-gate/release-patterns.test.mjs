// deployPatterns: allowlist cho release. MOI lenh release bi coi la deploy tru khi subcommand dau (khong-co) la plan|preflight|status|verify. Chay: bun test.
import { test, expect } from 'bun:test';
import { DEFAULTS } from './hook.mjs';

const gate = DEFAULTS.deployPatterns.map((p) => new RegExp(p, 'i'));
const hits = (c) => gate.some((g) => g.test(c));
const H = 'node harness/cli/harness.mjs release';

test('verify-gate: release apply|rollback (moi thu tu co, duong dan, import) bi coi la deploy', () => {
  for (const c of [`${H} apply --project x --env y`, `${H} --project x --env y apply --confirm t`, `${H} --env y --project x rollback --backup /a`,
    `${H} --timeout-s 5 --max-bytes 100 --json --raw --run a --mark 1 --restarts 2 --expect-hash abc --project x --env y --confirm t apply`,
    `${H} --project plan --env y apply`, `${H} --env verify apply`, `${H} --foo apply`, 'node harness/cli/harness.mjs --json release apply', 'bun harness/cli/harness.mjs release rollback',
    'harness release apply --project x --env y', 'harness --json release rollback --backup /a', 'node hub/release/cli.mjs apply --project x', 'node hub/release/cli.mjs --project x --env y apply', 'node ./hub/release/cli.mjs --json --raw --project x --env y --timeout-s 9 --confirm t apply',
    'node "harness/cli/harness.mjs" release "apply"',
    "node -e \"import('./hub/release/cli.mjs').then(m=>m.run(['apply','--project','x']))\"", "node -e \"const a=['rollback'];import('./hub/release/cli.mjs').then(m=>m.run(a))\"",
    "node -e \"import('./hub/release/steps.mjs').then(m=>m.runApply({}))\"", "node -e \"import('./scripts.mjs').then(m=>m.launchScript({}))\"",
    'node harness\\tools\\release\\cli.mjs rollback --backup /b']) expect(hits(c)).toBe(true);
});

test('verify-gate: release plan/preflight/status/verify khong bi coi la deploy', () => {
  for (const c of [`${H} plan --project x --env y`, `${H} preflight --project x --env y`, `${H} verify --project x --env y --expect-hash abc`, `${H} status --run run-1-2 --project x --env y`,
    `${H} --project x --env y plan`, `${H} --timeout-s 30 --max-bytes 9 --json --project x --env y preflight`, 'node hub/release/cli.mjs verify --project x --env y',
    'node hub/release/cli.mjs --project x --env y --timeout-s 30 --max-bytes 9 preflight', 'node harness/cli/harness.mjs observe query', 'harness release plan --project x', 'harness release verify --project x', 'harness observe query', 'git diff hub/release/cli.mjs',
    'cat hub/release/steps.mjs', 'node --test hub/release/release.test.mjs']) expect(hits(c)).toBe(false);
});

test('verify-gate: mau release khong ReDoS', () => {
  for (const c of ['harness.mjs '.repeat(8000), 'node harness.mjs release ' + '--json '.repeat(14000) + 'apply', 'node ' + 'x '.repeat(40000) + 'release/cli.mjs', 'node ' + 'import('.repeat(15000)]) {
    const t = performance.now(); hits(c); expect(performance.now() - t).toBeLessThan(250);
  }
});
