// Ham thuan cho su kien audit: chuan hoa loi -> dau van tay on dinh, nhan lenh verify, file chạm. Khong I/O, khong secret (chi tra hash/ten tuong doi).
import { createHash } from 'node:crypto';

const WIN_PATH = /[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\\/:*?"<>|\s'`()]*/g;
const UNIX_PATH = /(?<![\w.:<])\/(?:[\w.@~+-]+\/)+[\w.@~+-]*/g;

/** Chuan hoa thong diep loi: bo duong dan tuyet doi, so dong/cot, timestamp, id ngau nhien, hash. */
export function normalizeError(text, max = 300) {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim();
  s = s.replace(WIN_PATH, '<path>').replace(UNIX_PATH, '<path>');
  s = s.replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?/g, '<ts>').replace(/\b\d\d:\d\d:\d\d(?:[.,]\d+)?\b/g, '<ts>');
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>');
  s = s.replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, '<hash>');
  s = s.replace(/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}\b/g, '<id>');
  s = s.replace(/\d+/g, 'N');
  return s.slice(0, max);
}

/** Dau van tay ngan on dinh (10 hex) tu (tool, loi). Rong -> null. */
export function fingerprint(text, tool = '') {
  const n = normalizeError(text);
  if (!n) return null;
  return createHash('sha1').update(String(tool || '') + '|' + n).digest('hex').slice(0, 10);
}

/** Cau truc khien exit code khong phan anh lenh: pipe, `;`, `||`, hoac `&` don (chay nen, ke ca giua lenh: `npm test & exit 0`).
 *  Cho phep `&&` va chuyen huong `2>&1`, `>&2`, `<&3`, `&>`, `&>>`; `&` trong chuoi trich dan khong tinh. */
function unsafeShape(s) {
  if (/[|;]/.test(s)) return true;
  const t = s.replace(/"[^"]*"|'[^']*'/g, '""').replace(/\d*[<>]&(?:\d+|-)?/g, ' ').replace(/&>>?/g, ' ').replace(/&&/g, ' ');
  return t.includes('&');
}

const VERIFY = [
  /^(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test|build|lint|typecheck|check)\b/,
  /^bunx?\s+(?:tsc|vitest|jest|eslint)\b/, /^(?:npx\s+)?(?:tsc|vitest|jest|eslint)\b/,
  /^node\s+--test\b/, /^(?:python3?\s+-m\s+)?pytest\b/, /^go\s+(?:test|build|vet)\b/, /^cargo\s+(?:test|build|check|clippy)\b/,
  /^node\s+\S*harness\/(?:cli\/commands\/doctor|tools\/sync)\.mjs\b/, /^node\s+\S*doctor\.mjs\b/,
];

// Co khien lenh khong chay kiem chung that (chi in help/version/danh sach, bien dich khong chay, chay thu): tat dinh theo token.
// Khong gom `-v` (pytest -v = verbose). go test `-run ^$` / `-run=^$` = khong khop test nao.
const NO_RUN_TOKENS = new Set(['--help', '-h', '-?', '/?', '--version', '-V', '--listTests', '--list-tests', '--list', '-list', '--collect-only', '--co',
  '--no-run', '--dry-run', '--dryrun', '--just-print', '--showConfig', '--show-config', '--print-config', '--init', '--listFiles', '--listFilesOnly', '--list-files']);
function noRun(seg) {
  const toks = seg.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ''));
  if (toks.some((t) => NO_RUN_TOKENS.has(t) || /^--(?:help|version)=/.test(t))) return true;
  if (/\s-{1,2}run(?:=|\s+)["']?\^?\$["']?(?=\s|$)/.test(seg)) return true; // go test -run ^$
  return /^(?:(?:bunx?|npx|pnpm\s+exec)\s+)?vitest\s+list\b/.test(seg); // vitest list
}

/** Bo tien to FOO=bar / timeout N cua mot doan `&&`. */
function stripSeg(seg) {
  let r = seg.trim();
  for (let i = 0; i < 10; i++) { const m = r.match(/^\w+=(?:"[^"]*"|'[^']*'|\S*)\s+/); if (!m) break; r = r.slice(m[0].length); }
  return r.replace(/^timeout\s+\d+[smh]?\s+/, '');
}

/** Lenh co phai lenh verify that khong. Tra true chi khi ket qua exit code phan anh dung verify:
 *  khong pipe/`;`/`||`, moi doan `&&` toi thieu mot doan la verify (tien to cd / timeout / FOO=bar duoc bo).
 *  Doan co co help/version/list/no-run/dry-run khong tinh (khong chay kiem chung that). */
export function isVerifyCommand(cmd) {
  let s = String(cmd ?? '').trim();
  if (!s || /\n/.test(s)) return false;
  s = s.replace(/^\s*cd\s+(?:\/d\s+)?(?:"[^"]*"|'[^']*'|[^\s&;|]+)\s*&&\s*/i, '');
  if (unsafeShape(s)) return false;
  return s.split('&&').some((seg) => {
    const r = stripSeg(seg);
    return !noRun(r) && (VERIFY.some((re) => re.test(r)) || STACK_TEST.some((re) => re.test(r)));
  });
}

// health: curl phai co -f/--fail/--fail-with-body (khong co thi HTTP 5xx van exit 0); wget mac dinh exit 8 khi server tra 4xx/5xx.
const HEALTH_URL = /^(?:curl|wget)\s+(?:[^|;&]*\s)?["']?https?:\/\/[^\s"']*\/(?:health|healthz|healthcheck)(?:[/?#"'\s]|$)/i;
const CURL_FAIL = /\s(?:--fail(?:-with-body)?|-[A-Za-z]*f[A-Za-z]*)(?=\s|$)/; // phan biet hoa/thuong: -F la form, khong phai fail
const HEALTH = { test: (r) => HEALTH_URL.test(r) && (!/^curl\b/i.test(r) || CURL_FAIL.test(r)) };

// Phan loai bang chung (tat dinh, chi theo chuoi lenh). Thu tu quan trong: muc dau khop thang.
// Mau test theo stack (npm t, pnpm -r test, uv run pytest, python -m unittest, tox, cargo nextest, dotnet/mvn/gradle test, make test...).
const PKG_FLAGS = String.raw`(?:(?:-{1,2}(?:prefix|filter|workspace|cwd|dir|F|C|w)[=\s]\S+|-{1,2}[\w-]+(?:=\S+)?)\s+|workspaces?\s+(?:foreach\s+)?\S+\s+)*`;
const EXE = String.raw`(?:\S*[\\/])?`;
const STACK_TEST = [
  new RegExp(String.raw`^(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+${PKG_FLAGS}(?:run(?:-script)?\s+)?(?:t|test)(?::[\w:-]+)?(?=\s|$)`),
  new RegExp(String.raw`^${EXE}(?:jest|vitest|mocha|ava|tap|pytest|py\.test|phpunit|rspec|bats)(?:\.cmd|\.exe)?(?=\s|$)`),
  /^(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx)\s+(?:mocha|ava|tap|playwright\s+test|cypress\s+run)\b/, /^deno\s+test\b/,
  new RegExp(String.raw`^(?:${EXE}python[\d.]*(?:\.exe)?|py(?:\s+-[\d.]+)?)\s+-m\s+(?:pytest|unittest|nose2|tox)\b`),
  /^(?:uv|poetry|pipenv|pdm|rye)\s+run\s+(?:python[\d.]*\s+-m\s+)?(?:pytest|unittest|tox|nox)\b/, /^hatch\s+(?:run\s+)?test\b/, /^(?:tox|nox)(?=\s|$)/,
  /^cargo\s+(?:\+\S+\s+)?(?:nextest\s+run|test|t)\b/, /^dotnet\s+test\b/,
  new RegExp(String.raw`^(?:${EXE}mvnw?(?:\.cmd)?|${EXE}gradlew?(?:\.bat)?)\s+(?:\S+\s+)*?(?:test|verify|check)(?=\s|$)`),
  /^bundle\s+exec\s+(?:rspec|minitest)\b/, /^(?:bundle\s+exec\s+)?rake\s+(?:test|spec)\b/, /^(?:bin[\\/])?rails\s+test\b/, /^php\s+artisan\s+test\b/, /^composer\s+(?:run\s+)?test\b/,
  /^mix\s+test\b/, /^swift\s+test\b/, /^(?:flutter|dart)\s+test\b/, /^ctest\b/, /^Invoke-Pester\b/i,
  /^(?:make|gmake|just|task)\s+(?:\S+\s+)*?(?:test|tests|check)(?=\s|$)/,
];

const KINDS = [
  ['test', [...STACK_TEST, /^(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test\b/, /^(?:bunx?|npx|pnpm\s+exec)\s+(?:vitest|jest)\b/, /^(?:vitest|jest)\b/, /^node\s+--test\b/,
    /^(?:python3?\s+-m\s+)?pytest\b/, /^go\s+test\b/, /^cargo\s+test\b/]],
  ['tsc', [/^(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?typecheck\b/, /^(?:bunx?|npx|pnpm\s+exec)\s+tsc\b/, /^tsc\b/, /^cargo\s+check\b/]],
  ['lint', [/^(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:lint|check)\b/, /^(?:bunx?|npx|pnpm\s+exec)\s+(?:eslint|biome\s+(?:check|lint|ci))\b/, /^(?:eslint|biome\s+(?:check|lint|ci))\b/,
    /^go\s+vet\b/, /^cargo\s+clippy\b/, /^node\s+\S*harness\/(?:cli\/commands\/doctor|tools\/sync)\.mjs\b/, /^node\s+\S*doctor\.mjs\b/]],
  ['build', [/^(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?build\b/, /^go\s+build\b/, /^cargo\s+build\b/]],
  ['hash', [/^git\s+rev-parse\b/, /^(?:sha\d+sum|shasum|md5sum)\b/, /^Get-FileHash\b/i, /^certutil\s+-hashfile\b/i]],
  ['health', [HEALTH]],
];

/** Loai bang chung cua lenh: 'test'|'tsc'|'lint'|'build'|'hash'|'health'|null. Cung rang buoc cau truc nhu isVerifyCommand
 *  (1 dong, khong pipe/`;`/`||`/nen; bo tien to cd/timeout/FOO=bar); chuoi `&&` -> loai cua doan cuoi co loai.
 *  Doan co co help/version/list/no-run/dry-run (noRun) -> khong co loai. */
export function verifyKind(cmd) {
  let s = String(cmd ?? '').trim();
  if (!s || /\n/.test(s)) return null;
  s = s.replace(/^\s*cd\s+(?:\/d\s+)?(?:"[^"]*"|'[^']*'|[^\s&;|]+)\s*&&\s*/i, '');
  if (unsafeShape(s)) return null;
  let kind = null;
  for (const seg of s.split('&&')) {
    const r = stripSeg(seg);
    if (noRun(r)) continue; // help/version/list/no-run/dry-run: khong phai bang chung
    const hit = KINDS.find(([, res]) => res.some((re) => re.test(r)));
    if (hit) kind = hit[0];
  }
  return kind;
}

/** verifier_outcome: chi tu lenh verify + ket qua that. pass|fail|none.
 *  PostToolUseFailure chi phat khi tool that bai (error bi cat, khong co "Exit code N") => verify + khong interrupted = fail. */
export function verifierOutcome({ isVerify, event, ok, exitCode, interrupted, background }) {
  if (!isVerify || interrupted || background) return 'none';
  if (event === 'PostToolUse') {
    if (Number.isFinite(exitCode) && exitCode !== 0) return 'fail'; // payload khong chuan co the mang exit code o tool_response
    return ok === false ? 'none' : 'pass';
  }
  if (event === 'PostToolUseFailure') return 'fail';
  return 'none';
}

/** Danh sach duong dan tuong doi cwd, toi da n; ngoai cwd -> chi ten file. Bo trung. */
export function relFiles(paths, cwd, n = 10) {
  const c = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const out = [];
  for (const p of paths || []) {
    if (typeof p !== 'string' || !p) continue;
    const f = p.replace(/\\/g, '/');
    let r;
    if (c && f.toLowerCase().startsWith(c.toLowerCase() + '/')) r = f.slice(c.length + 1);
    else if (/^(?:[A-Za-z]:)?\//.test(f)) r = f.split('/').pop();
    else r = f.replace(/^\.\//, '');
    if (r && !out.includes(r)) out.push(r);
    if (out.length >= n) break;
  }
  return out;
}
