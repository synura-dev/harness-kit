// Ham thuan verify-gate: tu danh sach su kien audit (da loc theo phien) -> quyet dinh allow|block. Khong I/O
// (tra git root qua opts.rootOf do hook tiem vao). Ket luan chi tu du lieu audit (event, ok, exit code,
// verify_kind/verifier_outcome, cwd, lenh); khong phan doan noi dung.
import { verifyKind } from '../../core/audit/fingerprint.mjs';

const FILE_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/;
const SHELL_TOOLS = /^(?:Bash|PowerShell)$/;
const CODE_KINDS = new Set(['test', 'tsc', 'build', 'lint']);
const ALL_KINDS = new Set([...CODE_KINDS, 'hash', 'health']);
export const GATE_HOOK = 'verify-gate'; // id hook trong ban ghi gate (core/audit/gate-event)

/** Chuoi lenh tu envelope: target khi khong bi cat, khong thi cmd_line (dong dau). Rong -> ''. */
function commandOf(e) {
  const d = e.data || {};
  if (typeof e.target === 'string' && e.target && d.target_truncated !== true) return e.target;
  return typeof d.cmd_line === 'string' ? d.cmd_line : '';
}

/** Loai bang chung: tin data.verify_kind cua audit (ke ca null = audit da xet lenh day du, khong phai verify);
 *  thieu khoa / gia tri la -> verifyKind(lenh) du phong (PowerShell, audit cu). */
export function kindOf(e) {
  const d = e.data || {};
  if (Object.prototype.hasOwnProperty.call(d, 'verify_kind')) {
    if (d.verify_kind === null) return null;
    if (ALL_KINDS.has(d.verify_kind)) return d.verify_kind;
  }
  return verifyKind(commandOf(e));
}

/** Ket qua bang chung pass|fail|none. Tin data.verifier_outcome (pass/fail) neu co; 'none' voi loai code giu nguyen.
 *  Thieu (PowerShell, hash/health): PostToolUse ok===true, khong nen, exit 0/khong co -> pass; PostToolUseFailure -> fail. */
export function outcomeOf(e, kind) {
  const d = e.data || {};
  const vo = d.verifier_outcome;
  if (vo === 'pass' || vo === 'fail') return vo;
  if (vo === 'none' && CODE_KINDS.has(kind)) return 'none';
  if (e.event === 'PostToolUseFailure') return 'fail';
  if (e.event !== 'PostToolUse' || e.ok !== true || d.bg === true) return 'none';
  if (Number.isFinite(d.exit_code) && d.exit_code !== 0) return 'fail';
  return 'pass';
}

// ---------- du an co runner khong (suy ra tu file du an; hook tiem hasRunner, gate khong I/O) ----------
const ANY_RUNNER = /^(?:package\.json|makefile|gnumakefile|justfile|taskfile\.ya?ml|deno\.jsonc?|bunfig\.toml)$/i;
const STACK_RUNNER = {
  py: /^(?:pyproject\.toml|pytest\.ini|tox\.ini|setup\.cfg|setup\.py|noxfile\.py|conftest\.py|pipfile|requirements[\w.-]*\.txt|uv\.lock|poetry\.lock)$/i,
  go: /^go\.(?:mod|work)$/i, rs: /^cargo\.toml$/i,
  jvm: /^(?:pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|build\.sbt|build\.xml|gradlew|mvnw)$/i,
  cs: /(?:\.(?:csproj|fsproj|vbproj|sln|slnx)|^global\.json)$/i, rb: /^(?:gemfile|rakefile|[\w.-]+\.gemspec)$/i,
  php: /^(?:composer\.json|phpunit\.xml(?:\.dist)?)$/i, swift: /^package\.swift$/i, dart: /^pubspec\.yaml$/i,
  lua: /^(?:\.busted|[\w.-]+\.rockspec)$/i, c: /^(?:cmakelists\.txt|meson\.build|configure\.ac|[\w.-]+\.vcxproj)$/i,
};
const EXT_STACK = { py: 'py', go: 'go', rs: 'rs', java: 'jvm', kt: 'jvm', scala: 'jvm', cs: 'cs', rb: 'rb', php: 'php', swift: 'swift', dart: 'dart',
  lua: 'lua', c: 'c', h: 'c', cpp: 'c', hpp: 'c' };
/** Regex ten file chung to du an co runner cho file nay, hoac null = luon tinh (JS/TS chay duoc khong can manifest: bun test, node --test; sh/ps1/sql giu hanh vi cu). */
export function runnerSpec(file) {
  const m = String(file || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const st = m && EXT_STACK[m[1]];
  return st ? [ANY_RUNNER, STACK_RUNNER[st]] : null;
}
const SUGGEST = { py: 'pytest', go: 'go test ./...', rs: 'cargo test', java: 'mvn test | gradle test', kt: 'gradle test', scala: 'sbt test', cs: 'dotnet test', rb: 'bundle exec rspec', php: 'phpunit', swift: 'swift test', dart: 'dart test' };

function isCodeFile(p, exts) {
  const m = String(p || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return !!m && exts.includes(m[1]);
}

// ---------- duong dan (thuan, khong I/O) ----------
const isAbs = (p) => /^(?:[A-Za-z]:[\\/]|[\\/])/.test(String(p));
/** Chuan hoa: '/', git-bash /e/x -> e:/x, giai . va .., o dia Windows -> chu thuong. */
function canonPath(p) {
  let s = String(p).replace(/\\/g, '/').replace(/^\/([A-Za-z])(?=\/|$)/, '$1:');
  const dm = s.match(/^([A-Za-z]):/);
  if (dm) s = s.slice(2);
  const st = [];
  for (const seg of s.split('/')) { if (!seg || seg === '.') continue; if (seg === '..') st.pop(); else st.push(seg); }
  return dm ? (dm[1] + ':/' + st.join('/')).toLowerCase() : '/' + st.join('/');
}
const resolveP = (base, p) => (isAbs(p) ? canonPath(p) : base ? canonPath(base + '/' + p) : null);
const dirOf = (f) => { const i = f.lastIndexOf('/'); return i <= 0 ? '/' : /^[a-z]:$/.test(f.slice(0, i)) ? f.slice(0, i + 1) : f.slice(0, i); };

/** Bang chung chay o run co phu file khong: run la to tien (hoac chinh) thu muc cua file, hoac cung git root.
 *  Khong xac dinh duoc run hoac file -> coi nhu cung cwd phien (true). */
function covers(run, file, rootOf) {
  if (!run || !file) return true;
  const pre = run.endsWith('/') ? run : run + '/';
  if (file.startsWith(pre)) return true;
  if (typeof rootOf !== 'function') return false;
  const a = rootOf(run), b = rootOf(dirOf(file));
  return !!a && a === b;
}

// ---------- phan tich lenh shell (thuan, tat dinh) ----------
/** Che chuoi trich dan bang \u0000i\u0000 de tach doan an toan. */
function mask(s) {
  const q = [];
  const m = s.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (x) => { q.push(x); return `\u0000${q.length - 1}\u0000`; });
  return { m, un: (t) => t.replace(/\u0000(\d+)\u0000/g, (_, i) => q[+i]) };
}
const unq = (t) => t.replace(/^["']|["']$/g, '');

/** Cac dong lenh thuc thi: bo than heredoc (<<EOF ... EOF) va here-string PowerShell (@' ... '@). */
function cmdLines(text) {
  const out = []; let until = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (until) {
      if (until === '@' ? /^\s*['"]@/.test(line) : line.trim() === until) { if (until === '@') out.push(line.replace(/^\s*['"]@/, '')); until = null; }
      continue;
    }
    out.push(line);
    const h = line.match(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1/);
    if (h) until = h[2]; else if (/@['"]\s*$/.test(line)) until = '@';
  }
  return out;
}

/** Tach dong thanh doan lenh (&&, ||, ;, |), ton trong trich dan. Tra chuoi da bo tien to sudo/env/FOO=bar/timeout/&. */
function segments(text) {
  const segs = [];
  for (const line of cmdLines(text)) {
    const { m, un } = mask(line);
    for (const part of m.split(/&&|\|\||[;|]/)) {
      let r = part.trim();
      for (let i = 0; i < 10; i++) {
        const p = r.match(/^(?:sudo(?:\s+-\S+)*\s+|env\s+|nohup\s+|exec\s+|time\s+|command\s+|&\s*|\w+=(?:\u0000\d+\u0000|\S*)\s+|timeout(?:\s+-\S+)*\s+\d+[smh]?\s+)/);
        if (!p) break; r = r.slice(p[0].length);
      }
      if (r) segs.push({ m: r, s: un(r), un });
    }
  }
  return segs;
}
const segTokens = (seg) => seg.m.split(/\s+/).filter(Boolean).map((t) => unq(seg.un(t)));

const CD_RE = /^\s*(?:cd|pushd|chdir|Set-Location|sl)\s+(?:\/d\s+)?(?:-(?:Literal)?Path\s+)?("[^"]*"|'[^']*'|[^\s&;|]+)\s*(?:&&|;)\s*/i;
/** Thu muc chay cua su kien shell: cwd payload (thieu -> cwd phien) + chuoi `cd X &&` dau lenh.
 *  Tra { dir, assumed }: assumed=true khi cd khong xac dinh duoc ($VAR, ~, bi cat...) -> coi nhu cwd. */
function runDirOf(e, sessionCwd) {
  const base = typeof e.cwd === 'string' && e.cwd ? e.cwd : sessionCwd || null;
  let dir = base ? canonPath(base) : null, s = commandOf(e).split(/\r?\n/, 1)[0], n = 0;
  for (let m; n < 8 && (m = s.match(CD_RE)); n++) {
    const t = unq(m[1]);
    if (/[$%~`(]/.test(t) || t === '-' || (!dir && !isAbs(t))) return { dir: base ? canonPath(base) : null, assumed: true };
    dir = resolveP(dir, t); s = s.slice(m[0].length);
  }
  if (!n && (e.data || {}).cd_prefix === true) return { dir, assumed: true }; // audit thay cd nhung lenh con lai bi cat
  return { dir, assumed: false };
}

const ARG_FLAGS = new Set(['-i', '-p', '-l', '-o', '-F', '-J', '-E', '-b', '-c', '-D', '-L', '-R', '-W', '-S', '-O', '-Q', '-w', '-B', '-e', '-m']);
/** Lenh co phai deploy khong: tung doan lenh (khong theo chu trong duong dan) khop deployPatterns (neo ^);
 *  ssh: xet de quy lenh tu xa (1 cap). */
function isDeploy(text, res, depth = 0) {
  for (const seg of segments(text)) {
    if (res.some((re) => re.test(seg.s))) return true;
    if (depth < 1 && /^ssh(?:\.exe)?\s/i.test(seg.s)) {
      const t = segTokens(seg); let i = 1;
      while (i < t.length && t[i].startsWith('-')) i += ARG_FLAGS.has(t[i]) ? 2 : 1;
      const remote = t.slice(i + 1).join(' ');
      if (remote && isDeploy(remote, res, depth + 1)) return true;
    }
  }
  return false;
}

/** File bi ghi boi lenh shell (tat dinh): redirect > >> &> vao file, tee, sed -i, perl -i, Set-Content/Add-Content/
 *  Out-File/New-Item/Tee-Object, cp/mv/Copy-Item/Move-Item (dich). Khong bat: ghi qua interpreter (node -e, python -c), git apply/patch. */
export function shellWrites(text) {
  const files = [];
  for (const line of cmdLines(text)) {
    const { m, un } = mask(line);
    for (const r of m.matchAll(/(?:^|[^<>&\w=-])(?:\d|&)?>>?\|?(?!&)\s*([^\s|;&<>()]+)/g)) files.push(unq(un(r[1])));
  }
  for (const seg of segments(text)) {
    const t = segTokens(seg); const head = (t[0] || '').toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, '');
    let args = t.slice(1);
    const cut = args.findIndex((a) => /^(?:\d|&)?[<>]/.test(a)); // phan sau redirect da xu ly o tren; `< in` la nguon
    if (cut >= 0) args = args.slice(0, cut);
    const nonFlag = args.filter((a) => !/^-/.test(a));
    if (head === 'tee' || head === 'tee-object') files.push(...nonFlag);
    else if (head === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) files.push(...nonFlag);
    else if (head === 'perl' && args.some((a) => /^-[a-zA-Z]*i/.test(a))) files.push(...nonFlag);
    else if (/^(?:set-content|add-content|out-file|new-item|sc|ac)$/.test(head)) files.push(...nonFlag);
    else if (/^(?:cp|mv|copy-item|move-item|copy|move|cpi|mi|install)$/.test(head) && nonFlag.length) files.push(nonFlag[nonFlag.length - 1]);
  }
  return [...new Set(files.filter(Boolean))];
}

/** File ma su kien sua (files_touched hoac target). */
function filesOf(e) {
  const d = e.data || {};
  if (Array.isArray(d.files_touched) && d.files_touched.length) return d.files_touched.filter((x) => typeof x === 'string');
  return typeof e.target === 'string' && e.target ? [e.target] : [];
}

/** Loc su kien thuoc pham vi: SubagentStop -> dung agent_id; Stop -> actor main, sau UserPromptSubmit cuoi (khong co -> ca phien). */
export function scopeEvents(events, { event, agentId }) {
  const sorted = events.filter((e) => e && typeof e.ts === 'string').map((e, i) => [e, i])
    .sort((a, b) => (a[0].ts < b[0].ts ? -1 : a[0].ts > b[0].ts ? 1 : a[1] - b[1])).map((x) => x[0]);
  if (event === 'SubagentStop') return sorted.filter((e) => e.agent_id === agentId);
  const main = sorted.filter((e) => !e.agent_id);
  let start = 0;
  for (let i = main.length - 1; i >= 0; i--) if (main[i].event === 'UserPromptSubmit') { start = i + 1; break; }
  return main.slice(start);
}

/**
 * Quyet dinh. events: envelope audit da sap/loc pham vi (scopeEvents). cfg: { codeExts, deployPatterns }.
 * opts: { stopHookActive, cwd (cwd phien, du phong khi su kien thieu cwd), rootOf(dir)->git root|null }.
 * Sua code = Edit/Write/... hoac lenh shell ghi file ma (shellWrites). Bang chung code chi hop le cho file khi chay
 * SAU lan sua code cuoi, o thu muc la to tien cua file hoac cung git root; moi file da sua phai duoc phu.
 * Tra { decision: 'allow'|'block', code, reason?, edits, lastEditTs?, cwdAssumed }.
 */
export function decide(events, cfg, { stopHookActive = false, cwd = null, rootOf = null, tmpDirs = [], hasRunner = null } = {}) {
  const deployRes = (cfg.deployPatterns || []).map((s) => new RegExp(s, 'i'));
  const exts = cfg.codeExts || [];
  let lastEdit = -1, lastDeploy = -1, edits = 0, priorBlock = false, cwdAssumed = 0;
  const ev = events;
  const edited = new Map(); // khoa duong dan (null = khong xac dinh) -> true
  const runDirs = new Map();
  const runDir = (i) => { if (!runDirs.has(i)) { const r = runDirOf(ev[i], cwd); if (r.assumed) cwdAssumed++; runDirs.set(i, r.dir); } return runDirs.get(i); };
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    const g = e.type === 'gate' && e.data && e.data.gate;
    if (g && typeof g === 'object' && g.hook === GATE_HOOK && g.decision === 'block') priorBlock = true;
    if (!e.tool) continue;
    if (FILE_TOOLS.test(e.tool) && e.event === 'PostToolUse' && e.ok !== false) {
      const code = filesOf(e).filter((f) => isCodeFile(f, exts));
      if (code.length) {
        lastEdit = i; edits++;
        const base = typeof e.cwd === 'string' && e.cwd ? e.cwd : cwd;
        const abs = typeof e.target === 'string' && isAbs(e.target) && isCodeFile(e.target, exts) ? canonPath(e.target) : null;
        for (const f of code) edited.set(abs || resolveP(base, f), true);
      }
    }
    if (SHELL_TOOLS.test(e.tool) && (e.event === 'PostToolUse' || e.event === 'PostToolUseFailure')) {
      const d = e.data || {};
      // target bi cat (bash_target_max) -> xet ca target va cmd_line (dong dau); phan sau diem cat khong thay duoc.
      const texts = d.target_truncated === true ? [e.target, d.cmd_line] : [commandOf(e)];
      const written = [...new Set(texts.filter((x) => typeof x === 'string' && x).flatMap(shellWrites))].filter((f) => isCodeFile(f, exts));
      if (written.length) {
        lastEdit = i; edits++;
        const dir = runDir(i);
        for (const f of written) edited.set(resolveP(dir, f), true);
      }
      const cmd = commandOf(e);
      if (e.event === 'PostToolUse' && e.ok !== false && cmd && isDeploy(cmd, deployRes)) lastDeploy = i;
    }
  }
  const after = (from, wantCode) => {
    const kinds = new Set(), codeDirs = [];
    for (let i = from + 1; i < ev.length; i++) {
      const e = ev[i];
      if (!e.tool || !SHELL_TOOLS.test(e.tool) || (e.event !== 'PostToolUse' && e.event !== 'PostToolUseFailure')) continue;
      const k = kindOf(e);
      if (!k || outcomeOf(e, k) !== 'pass') continue;
      kinds.add(k);
      if (wantCode && CODE_KINDS.has(k)) codeDirs.push(runDir(i));
    }
    return { kinds, codeDirs };
  };
  const missing = [];
  // Chi tinh file nam trong mot git root: bo qua ignorePaths (cau hinh) va file ngoai moi git repo (vd scratchpad/thu muc tam).
  // File duoi thu muc tam chi tinh khi git root cua no nam TRONG thu muc tam (repo tam co .git van bi gate).
  const ign = (cfg.ignorePaths || []).map((p) => canonPath(p).replace(/\/+$/, ''));
  const tmps = (tmpDirs || []).filter(Boolean).map((p) => canonPath(p).replace(/\/+$/, ''));
  const under = (f, d) => f === d || f.startsWith(d.endsWith('/') ? d : d + '/');
  const tracked = [...edited.keys()].filter((f) => {
    if (f === null) return true; // khong xac dinh duoc duong dan: giu (an toan)
    if (ign.some((d) => under(f, d))) return false;
    if (typeof rootOf !== 'function') return true;
    const r = rootOf(dirOf(f));
    if (!r) return false;
    const t = tmps.find((d) => under(f, d));
    if (t && !under(r, t)) return false;
    // Du an khong co runner nhan ra duoc cho stack cua file (py/go/rs/... khong co manifest): khong chan, khong the bat buoc test.
    if (typeof hasRunner === 'function' && !hasRunner(f, r)) return false;
    return true;
  });
  if (lastEdit >= 0 && tracked.length) {
    const { codeDirs } = after(lastEdit, true);
    const ok = codeDirs.length > 0 && tracked.every((f) => codeDirs.some((d) => covers(d, f, rootOf)));
    if (!ok) missing.push('code');
  }
  if (lastDeploy >= 0) { const { kinds: k } = after(lastDeploy, false); if (!k.has('hash') || !k.has('health')) missing.push('deploy'); }
  const base = { edits, lastEditTs: lastEdit >= 0 ? ev[lastEdit].ts : null, cwdAssumed };
  if (!missing.length) return { decision: 'allow', code: lastEdit >= 0 && !tracked.length && lastDeploy < 0 ? 'edits_ignored' : lastEdit >= 0 || lastDeploy >= 0 ? 'evidence_ok' : 'no_change', ...base };
  if (stopHookActive) return { decision: 'allow', code: 'already_blocked_stop_hook_active', missing, ...base };
  if (priorBlock) return { decision: 'allow', code: 'already_blocked_audit', missing, ...base };
  const parts = [];
  if (missing.includes('code')) {
    const known = tracked.filter(Boolean);
    const hint = [...new Set(known.map((f) => SUGGEST[(f.match(/\.([a-z0-9]+)$/) || [])[1]] || 'bun test | npm test'))].slice(0, 3).join(' | ');
    const shown = known.slice(0, 3).join(', ') + (known.length > 3 ? ` (+${known.length - 3})` : '');
    parts.push('Da sua code nhung chua co bang chung pass sau lan sua cuoi, chay trong thu muc/du an (git root) cua moi file da sua: chay test/tsc (hoac build/lint) roi bao ket qua.' + (shown ? ` Tep: ${shown}.` : '') + (hint ? ` Goi y lenh: ${hint}.` : ''));
  }
  if (missing.includes('deploy')) parts.push('Da deploy nhung chua co bang chung hash (git rev-parse...) va health (curl -f .../health) pass sau deploy.');
  return { decision: 'block', code: 'missing_' + missing.join('_'), missing, reason: 'verify-gate: ' + parts.join(' '), ...base };
}

// ---- route-check: bao cao cuoi subagent co dong `status:` thi kiem serves/assumptions/counter/adopted ----
const ROUTE_NONE = /^(?:khong\s*co|không\s*có|none|n\/a|na|-+|—+|–+)[\s.]*$/i;
const ROUTE_EVIDENCE = /[\w.\\/-]+\.\w+:\d+|https?:\/\/\S+|\d(?:[.,]\d+)?\s*%|\d(?:[.,]\d+)?\s*(?:ms|s|kb|mb|gb|lượt|luot|turns?|tests?|dòng|dong|lines?)(?![\p{L}\d])/iu;
const ROUTE_KEYS = ['status', 'serves', 'assumptions', 'counter', 'adopted'];
const routeKeyRe = (k) => new RegExp(`^[ \\t]*(?:[-*][ \\t]*)?\\**${k}\\**[ \\t]*:\\**[ \\t]*(.*)$`, 'im');
const anyKeyRe = new RegExp(`^[ \\t]*(?:[-*][ \\t]*)?\\**(?:${ROUTE_KEYS.join('|')})\\**[ \\t]*:`, 'i');

/** Gia tri truong `key:` (cung dong; rong thi cac dong sau toi dong truong khac/dong trong). null neu khong co dong truong. */
function routeField(text, key) {
  const m = routeKeyRe(key).exec(text);
  if (!m) return null;
  const v = m[1].trim();
  if (v) return v;
  const rest = text.slice(m.index + m[0].length).split('\n').slice(1);
  const out = [];
  for (const l of rest) { if (!l.trim() || anyKeyRe.test(l)) break; out.push(l.trim()); }
  return out.join(' ').trim();
}

/** Kich hoat: `status:` la dong co noi dung dau tien, hoac gia tri status thuoc PASS|FAIL|BLOCKED|PARTIAL (khong bat YAML `status: todo`). */
function routeActive(t) {
  const first = t.split('\n').find((l) => l.trim());
  if (first && routeKeyRe('status').test(first)) return true;
  return /^[ \t]*(?:[-*][ \t]*)?\**status\**[ \t]*:\**[ \t]*(?:pass|fail|blocked|partial)(?![\p{L}\d])/imu.test(t);
}

/** Kiem bao cao theo mau protocol. Khong co dong `status:` -> { applies:false }; else { applies:true, ok, missing:[...] }. Tat dinh, khong nem. */
export function checkRouteReport(text) {
  const t = typeof text === 'string' ? text : '';
  if (!routeActive(t)) return { applies: false, ok: true, missing: [] };
  const missing = [];
  for (const k of ['serves', 'assumptions', 'adopted']) if (!routeField(t, k)) missing.push(k);
  const c = routeField(t, 'counter');
  if (!c) missing.push('counter');
  else if (ROUTE_NONE.test(c)) missing.push('counter(khong-co)');
  else if (!ROUTE_EVIDENCE.test(c)) missing.push('counter(thieu-dan-chung)');
  return { applies: true, ok: missing.length === 0, missing };
}
