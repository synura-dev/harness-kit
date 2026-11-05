// Playbook policy: allowlist exe/git/bun/node (mac dinh tu choi) + builtin defaults.
import path from 'node:path';
import { isInside } from '../../../../harness/core/io/paths.mjs';

// ---------- allowlist (mac dinh tu choi) ----------
const ALLOW_EXE = ['git', 'node', 'bun'];
const SCRIPT_EXT = /\.(mjs|js|cjs|ts)$/;
const GIT_SAFE_GLOBAL = new Set(['--no-pager', '-P', '--no-optional-locks', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs']);
const GIT_READ_SUBS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'rev-list', 'for-each-ref']);
const GIT_BRANCH_FLAGS = new Set(['-l', '--list', '--merged', '--no-merged', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--show-current', '--no-color', '--color']);
const GIT_COMMIT_FLAGS = new Set(['--only', '-o', '--dry-run', '-q', '--quiet', '-s', '--signoff', '--allow-empty']);
const BROAD_PATHSPEC = new Set(['.', './', ':/', '*', '-A', '--all', '-u', '--update']);
const isTpl = (a) => a.includes('${');
const badRelPath = (p) => path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes('..') || p.startsWith('-');

function gitReason(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '-C') {
      const v = args[i + 1];
      if (v === undefined || isTpl(v) || badRelPath(v)) return 'git -C chi nhan duong dan tuong doi trong hub (bi cam)';
      i += 2; continue;
    }
    if (a === '-c' || /^-c./.test(a) || /^--(git-dir|work-tree|exec-path|namespace|config-env|super-prefix)/.test(a)) return `git option bi cam: ${a}`;
    if (!GIT_SAFE_GLOBAL.has(a)) return `git option toan cuc khong trong allowlist (bi cam): ${a}`;
    i++;
  }
  const sub = args[i], rest = args.slice(i + 1);
  if (!sub) return 'git thieu lenh con';
  for (const a of rest) {
    if (/^--force/i.test(a)) return `co co '--force': ${a}`;
    if (a === '--no-verify' || a === '--no-gpg-sign') return `${a} bi cam`;
    if (/^-[A-Za-z]*f[A-Za-z]*$/.test(a)) return `co co -f bi cam: ${a}`;
    if (/^--output/.test(a)) return `git ${sub} --output bi cam`;
  }
  if (GIT_READ_SUBS.has(sub)) return null;
  if (sub === 'add') {
    const dd = rest.indexOf('--');
    const paths = dd < 0 ? rest.filter((a) => !a.startsWith('-')) : rest.slice(dd + 1);
    const flags = dd < 0 ? rest.filter((a) => a.startsWith('-')) : rest.slice(0, dd);
    if (flags.length) { const b = flags.find((a) => BROAD_PATHSPEC.has(a)); return b ? `git add ${b} bi cam: liet ke duong dan cu the` : `git add option khong trong allowlist (bi cam): ${flags[0]}`; }
    if (!paths.length) return 'git add thieu duong dan cu the';
    if (paths.some((p) => BROAD_PATHSPEC.has(p))) return 'git add . / * bi cam: liet ke duong dan cu the';
    return null;
  }
  if (sub === 'commit') {
    const dd = rest.indexOf('--');
    if (dd < 0 || dd === rest.length - 1) return "git commit bat buoc co '-- <duong dan>' (bi cam: chi commit duong dan khai bao)";
    const head = rest.slice(0, dd);
    for (let k = 0; k < head.length; k++) {
      if (head[k] === '-m') { if (++k >= head.length) return 'git commit -m thieu gia tri'; continue; }
      if (!GIT_COMMIT_FLAGS.has(head[k])) return `git commit option khong trong allowlist (bi cam): ${head[k]}`;
    }
    if (rest.slice(dd + 1).some((p) => BROAD_PATHSPEC.has(p))) return 'git commit pathspec rong bi cam';
    return null;
  }
  if (sub === 'worktree') return (rest.length === 1 && (rest[0] === 'list' || rest[0] === 'prune')) ? null : 'chi cho phep git worktree list|prune (bi cam)';
  if (sub === 'stash') return (rest.length === 1 && rest[0] === 'list') ? null : 'chi cho phep git stash list (bi cam)';
  if (sub === 'branch') {
    if (!rest.some((a) => ['-l', '--list', '--merged', '--no-merged', '--show-current'].includes(a))) return 'git branch chi o che do liet ke -l/--list/--merged/--no-merged (bi cam)';
    const bad = rest.find((a) => a.startsWith('-') && !GIT_BRANCH_FLAGS.has(a));
    return bad ? `git branch option bi cam: ${bad}` : null;
  }
  if (sub === 'symbolic-ref') {
    const pos = rest.filter((a) => !a.startsWith('-'));
    if (rest.some((a) => ['-d', '--delete', '-m'].includes(a)) || pos.length > 1) return 'git symbolic-ref chi doc (bi cam)';
    return null;
  }
  return `git ${sub} khong trong allowlist (bi cam)`;
}

/** @returns {string|null} ly do bi cam, hoac null. Dung ca luc validate (template) lan luc chay (args da thay the). */
export function denyRun(run) {
  if (!Array.isArray(run) || !run.length) return 'run rong';
  const exe = String(run[0]);
  const args = run.slice(1).map(String);
  if (!ALLOW_EXE.includes(exe)) return `exe khong trong allowlist (bi cam): ${exe} (chi ${ALLOW_EXE.join('|')})`;
  if (exe === 'git') return gitReason(args);
  const first = args[0];
  if (exe === 'node') {
    if (first === undefined) return 'node bat buoc co duong dan script (bi cam)';
    if (isTpl(first) || first.startsWith('-') || !SCRIPT_EXT.test(first) || badRelPath(first)) return `node chi chay script tuong doi trong hub, khong option -e/--eval/--import/-p (bi cam): ${first.slice(0, 30)}`;
    return null;
  }
  if (first === 'run') {
    const s = args[1];
    if (s === undefined || isTpl(s) || !SCRIPT_EXT.test(s) || badRelPath(s)) return 'bun run chi chay script tuong doi trong hub (bi cam)';
    return null;
  }
  if (first === 'test') {
    for (let k = 1; k < args.length; k++) {
      const a = args[k];
      if (a === '--timeout') { const v = args[++k]; if (v === undefined || !(/^\d{1,7}$/.test(v) || /^\$\{[a-z][a-z0-9_]*\}$/.test(v))) return 'bun test --timeout can so (bi cam)'; continue; }
      if (a.startsWith('-')) return `bun test option khong trong allowlist (bi cam): ${a}`;
      if (!isTpl(a) && badRelPath(a)) return `bun test duong dan khong hop le (bi cam): ${a}`;
    }
    return null;
  }
  return 'bun chi cho phep test|run <script> (bi cam)';
}

/** Kiem tra luc chay: script/duong dan test/git -C phai nam trong hub. */
export function scriptOutsideHub(argv, cwd, hub) {
  const exe = argv[0];
  const s = exe === 'node' ? argv[1] : (exe === 'bun' && argv[1] === 'run') ? argv[2] : null;
  if (s && !isInside(path.resolve(cwd, s), hub)) return `script nam ngoai hub: ${s.slice(0, 40)}`;
  if (exe === 'bun' && argv[1] === 'test') for (let k = 2; k < argv.length; k++) { const a = argv[k]; if (a === '--timeout') { k++; continue; } if (!isInside(path.resolve(cwd, a), hub)) return `duong dan test ngoai hub: ${a.slice(0, 40)}`; }
  const ci = exe === 'git' ? argv.indexOf('-C') : -1;
  if (ci > 0 && !isInside(path.resolve(cwd, argv[ci + 1]), hub)) return 'git -C ngoai hub';
  return null;
}

// ---------- builtin defaults ----------
export function resolveBuiltin(v, now = new Date()) {
  if (typeof v !== 'string' || !v.startsWith('@')) return v;
  const m = /^@today(?:-(\d{1,3})d)?$/.exec(v);
  if (!m) return v;
  const d = new Date(now.getTime() - (m[1] ? Number(m[1]) : 0) * 86400000);
  return d.toISOString().slice(0, 10);
}
