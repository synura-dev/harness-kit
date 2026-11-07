// Build skill tu nguon harness/skills/<ten>/ sang cac dich adapter (.claude/skills).
// Copy (khong symlink), nhung {{include shared/<file>}} luc build, ghi marker .generated.json {generator, source, hash, builtAt}.
// check: bao lech nguon / sua tay / chua build / mo coi / marker hong. prune: chi xoa dich CO marker hop le ma nguon khong con; mac dinh dry-run.
// Skill dich KHONG co marker = lane installed: khong bao gio ghi/xoa. Marker hong/cua cong cu khac: khong dung, chi canh bao. Thuan Node.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MARKER = '.generated.json';
const GENERATOR = 'dev/skills';
export const DEFAULT_SRC = 'harness/skills';
// agy nap skill tu plugin native (<du an>/.agents/plugins/harness-kit/skills), khong sinh ban chep .agents/skills (--target van cho phep chi dinh tuy y).
const DEFAULT_TARGETS = Object.freeze(['.claude/skills']);
export const LIMITS = Object.freeze({ timeoutS: 60, maxFilesPerSkill: 200, maxFileBytes: 1024 * 1024, maxDepth: 8, maxDirsPerSkill: 100 });
const SKIP_SRC = new Set(['shared']); // thu muc dung chung, khong phai skill
const INCLUDE_RE = /\{\{include\s+shared\/([A-Za-z0-9._\/-]+)\s*\}\}/g;
const TEXT_EXT = new Set(['.md', '.txt']);
const HASH_RE = /^[0-9a-f]{64}$/;

const posix = (p) => String(p).split(path.sep).join('/');
const statNoFollow = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const isRealDir = (p) => { const s = statNoFollow(p); return !!s && s.isDirectory() && !s.isSymbolicLink(); };
const timedOut = (c) => Date.now() > c.deadline;

/** Ten thu muc con that (khong symlink/junction, khong an, khong '_'). */
function childDirs(dir) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return ents.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_') && isRealDir(path.join(dir, e.name))).map((e) => e.name).sort();
}

function listSources(srcDir) { return childDirs(srcDir).filter((n) => !SKIP_SRC.has(n)); }

/** Doc de quy file thuong trong dir (bo symlink, bo marker), co tran do sau/so thu muc/so file/deadline. Tra {files, problems, truncated}. */
function readTree(dir, { limits = LIMITS, skipMarker = false, deadline = Infinity } = {}) {
  const out = []; const problems = []; let dirs = 0; let truncated = null;
  const walk = (d, rel, depth) => {
    if (truncated) return;
    if (Date.now() > deadline) { truncated = 'timeout'; problems.push('het thoi gian doc cay'); return; }
    if (depth > limits.maxDepth) { problems.push(`vuot do sau ${limits.maxDepth}: ${rel}`); return; }
    if (++dirs > limits.maxDirsPerSkill) { truncated = 'dirs'; problems.push(`vuot ${limits.maxDirsPerSkill} thu muc`); return; }
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { problems.push(`khong doc duoc ${rel || '.'}: ${e.code || e.message}`); return; }
    for (const e of ents) {
      if (truncated) return;
      const r = rel ? rel + '/' + e.name : e.name;
      const full = path.join(d, e.name);
      const s = statNoFollow(full);
      if (!s || s.isSymbolicLink()) { problems.push(`bo qua symlink: ${r}`); continue; }
      if (s.isDirectory()) { walk(full, r, depth + 1); continue; }
      if (!s.isFile()) continue;
      if (skipMarker && r === MARKER) continue;
      if (out.length >= limits.maxFilesPerSkill) { truncated = 'files'; problems.push(`vuot ${limits.maxFilesPerSkill} file`); return; }
      if (s.size > limits.maxFileBytes) { problems.push(`file qua lon (${s.size}B): ${r}`); continue; }
      out.push({ rel: r, buf: fs.readFileSync(full) });
    }
  };
  walk(dir, '', 0);
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files: out, problems, truncated };
}

/** sha256 tren (rel \0 noi dung \0) theo thu tu rel. */
function hashFiles(files) {
  const h = crypto.createHash('sha256');
  for (const f of files) { h.update(f.rel); h.update('\0'); h.update(f.buf); h.update('\0'); }
  return h.digest('hex');
}

/** Nhung {{include shared/<f>}} (mot cap, khong de quy). Tra {text, problems}. */
function expandIncludes(text, sharedDir) {
  const problems = [];
  const out = text.replace(INCLUDE_RE, (m, rel) => {
    if (rel.split('/').some((s) => s === '..' || s === '' || s === '.')) { problems.push(`include khong hop le: ${rel}`); return m; }
    const f = path.join(sharedDir, ...rel.split('/'));
    const s = statNoFollow(f);
    if (!s || !s.isFile() || s.isSymbolicLink()) { problems.push(`thieu include shared/${rel}`); return m; }
    return fs.readFileSync(f, 'utf8');
  });
  return { text: out, problems };
}

/** Render mot skill nguon -> {files, hash, problems}. */
export function renderSkill(srcDir, name, { limits = LIMITS, deadline } = {}) {
  const { files, problems } = readTree(path.join(srcDir, name), { limits, deadline });
  const sharedDir = path.join(srcDir, 'shared');
  const rendered = files.map((f) => {
    if (!TEXT_EXT.has(path.extname(f.rel).toLowerCase())) return f;
    const r = expandIncludes(f.buf.toString('utf8'), sharedDir);
    for (const p of r.problems) problems.push(`${f.rel}: ${p}`);
    return { rel: f.rel, buf: Buffer.from(r.text, 'utf8') };
  });
  if (!rendered.some((f) => f.rel === 'SKILL.md')) problems.push('thieu SKILL.md');
  return { files: rendered, hash: hashFiles(rendered), problems };
}

/**
 * Doc marker cua dir (skill ten `name`). null = khong co marker (lane installed).
 * {valid:true, ...} chi khi: JSON object, generator (neu co) dung, hash sha256 hex, source tro dung srcDir/<name>.
 * Nguoc lai {valid:false, reason}: KHONG duoc coi la ban sinh cua build nay.
 */
function readMarker(dir, c, name) {
  const f = path.join(dir, MARKER);
  const s = statNoFollow(f);
  if (!s) return null;
  if (!s.isFile() || s.isSymbolicLink()) return { valid: false, reason: 'marker khong phai file thuong' };
  if (s.size > 64 * 1024) return { valid: false, reason: 'marker qua lon' };
  let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { valid: false, reason: 'marker khong phai JSON' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { valid: false, reason: 'marker khong phai object' };
  if (j.generator !== undefined && j.generator !== GENERATOR) return { valid: false, reason: `generator la: ${j.generator}` };
  if (typeof j.hash !== 'string' || !HASH_RE.test(j.hash)) return { valid: false, reason: 'thieu/sai hash' };
  if (typeof j.source !== 'string' || !j.source) return { valid: false, reason: 'thieu source' };
  const src = path.resolve(c.root, j.source);
  const rel = path.relative(c.srcDir, src);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { valid: false, reason: `source ngoai ${posix(path.relative(c.root, c.srcDir))}: ${j.source}` };
  if (rel !== name) return { valid: false, reason: `source khong khop ten skill: ${j.source}` };
  return { valid: true, source: j.source, hash: j.hash };
}

const LEGACY_FILE = '.generated'; // marker cu cua tools/sync.mjs (adapter claude): file + dong header HTML trong SKILL.md
const LEGACY_HEADER_RE = /^<!-- GENERATED - do not edit: sinh tu [^\r\n]*? -->\r?\n/m;

/** Hash noi dung dich KHONG marker sau khi bo dau vet sinh cu (file .generated + dong header o SKILL.md), de so voi hash nguon khi --adopt. */
// Header cu cua sync.mjs nuot dong trong ngay sau frontmatter => so sanh bo qua dong trong o do (ca hai ben).
const looseSkillMd = (s) => s.replace(/^(---\r?\n[\s\S]*?\r?\n---)(\r?\n)+/, '$1\n');
const looseHash = (files) => hashFiles(files.map((f) => (f.rel === 'SKILL.md' ? { rel: f.rel, buf: Buffer.from(looseSkillMd(f.buf.toString('utf8')), 'utf8') } : f)));

function legacyNormalizedHash(dir, c) {
  const t = readTree(dir, { limits: c.limits, deadline: c.deadline });
  if (t.truncated || t.problems.length) return null;
  const hasLegacy = t.files.some((f) => f.rel === LEGACY_FILE);
  const files = t.files.filter((f) => f.rel !== LEGACY_FILE).map((f) => (hasLegacy && f.rel === 'SKILL.md'
    ? { rel: f.rel, buf: Buffer.from(f.buf.toString('utf8').replace(LEGACY_HEADER_RE, ''), 'utf8') } : f));
  return looseHash(files);
}

/** Dich la symlink/junction tro dung thu muc cung ten o MOT dich khac (that, khong phai link): ban sinh cua dich do phu ca ben nay. */
function isAliasOfSibling(dir, name, c) {
  const rp = fs.realpathSync.native || fs.realpathSync; // .native: chuan hoa hoa/thuong o win32 (duong dan go chu thuong)
  let real; try { real = rp(dir); } catch { return false; }
  return c.targets.some((t) => {
    const d = path.join(t.dir, name);
    if (path.resolve(d) === path.resolve(dir) || !isRealDir(d)) return false;
    try { return rp(d) === real; } catch { return false; }
  });
}

/** Trang thai mot dich: missing | installed (khong marker) | adoptable (khong marker nhung noi dung khop nguon, chi khi c.adopt) | badmarker | ok | drift (nguon doi) | edited (sua tay). */
function targetState(dir, name, rendered, c) {
  const s = statNoFollow(dir);
  if (!s) return { state: 'missing' };
  if (s.isSymbolicLink() && isAliasOfSibling(dir, name, c)) return { state: 'alias' };
  if (!s.isDirectory() || s.isSymbolicLink()) return { state: 'installed' };
  const m = readMarker(dir, c, name);
  if (!m) {
    if (c.adopt && rendered && legacyNormalizedHash(dir, c) === looseHash(rendered.files)) return { state: 'adoptable' };
    return { state: 'installed' };
  }
  if (!m.valid) return { state: 'badmarker', reason: m.reason };
  const t = readTree(dir, { limits: c.limits, skipMarker: true, deadline: c.deadline });
  if (t.truncated || hashFiles(t.files) !== m.hash) return { state: 'edited', marker: m };
  if (rendered && m.hash !== rendered.hash) return { state: 'drift', marker: m };
  return { state: 'ok', marker: m };
}

function ctx({ root, src, targets, limits, timeoutS, fsOps, adopt } = {}) {
  const lim = { ...LIMITS, ...(limits || {}) };
  const t = timeoutS || lim.timeoutS;
  return {
    root, adopt: !!adopt, srcDir: path.resolve(root, src || DEFAULT_SRC),
    targets: (targets && targets.length ? targets : DEFAULT_TARGETS).map((d) => ({ rel: posix(d), dir: path.resolve(root, d) })),
    limits: lim, deadline: Date.now() + t * 1000,
    ops: { rename: fs.renameSync, write: fs.writeFileSync, ...(fsOps || {}) }, // fsOps: chi de test gia lap loi
  };
}

const pause = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* bo qua */ } };
/** rename co thu lai khi Windows tra EPERM/EBUSY/EACCES (file bi AV/indexer giu trong chot lat). */
function renameRetry(ops, from, to) {
  for (let i = 0; ; i++) {
    try { return ops.rename(from, to); } catch (e) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      pause(50 * (i + 1));
    }
  }
}
const rmQuiet = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* bo qua */ } };

/**
 * Ghi skill nguyen tu: render vao thu muc an `.<ten>.build-*` cung cha (co marker), roi doi ten.
 * Dich cu (neu co) doi sang `.<ten>.old-*` truoc, rename that bai -> tra dich cu ve, xoa ban dang dung. Khong bao gio de dich mat marker.
 */
function writeSkill(dir, rendered, source, ops) {
  const parent = path.dirname(dir); const base = path.basename(dir);
  const tag = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const stage = path.join(parent, `.${base}.build-${tag}`);
  const old = path.join(parent, `.${base}.old-${tag}`);
  fs.mkdirSync(parent, { recursive: true });
  try {
    for (const f of rendered.files) {
      const out = path.join(stage, ...f.rel.split('/'));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      ops.write(out, f.buf);
    }
    fs.mkdirSync(stage, { recursive: true });
    ops.write(path.join(stage, MARKER), JSON.stringify({ generator: GENERATOR, source, hash: rendered.hash, builtAt: new Date().toISOString() }, null, 2) + '\n');
  } catch (e) { rmQuiet(stage); throw e; }
  const hadOld = !!statNoFollow(dir);
  if (hadOld) {
    try { renameRetry(ops, dir, old); } catch (e) { rmQuiet(stage); throw e; }
  }
  try { renameRetry(ops, stage, dir); } catch (e) {
    if (hadOld) { try { renameRetry(ops, old, dir); } catch { /* old van con o .old-*, bao trong loi */ } }
    rmQuiet(stage);
    if (hadOld && statNoFollow(old)) e.message += ` (ban cu con o ${path.basename(old)})`;
    throw e;
  }
  if (hadOld) rmQuiet(old);
}

/** build: mac dinh dry-run; apply=true moi ghi. force=true moi ghi de ban sua tay. Hash khop -> bo qua.
 *  adopt=true: dich khong marker CHI duoc thay khi noi dung khop nguon (hash bang, sau khi bo dau vet sinh cu); khong khop -> van la lane installed. */
export function build(opts = {}) {
  const c = ctx(opts);
  const items = []; const problems = []; let truncated = null;
  for (const name of listSources(c.srcDir)) {
    if (timedOut(c)) { truncated = 'timeout'; break; }
    const r = renderSkill(c.srcDir, name, { limits: c.limits, deadline: c.deadline });
    if (r.problems.length) { for (const p of r.problems) problems.push(`${name}: ${p}`); continue; }
    const source = posix(path.relative(c.root, path.join(c.srcDir, name)));
    for (const t of c.targets) {
      const dir = path.join(t.dir, name);
      const st = targetState(dir, name, r, c);
      const where = `${t.rel}/${name}`;
      if (st.state === 'ok' || st.state === 'alias') { items.push({ skill: name, target: where, action: 'skip' }); continue; }
      if (st.state === 'installed') { problems.push(`${where}: da co skill khong marker (lane installed), khong ghi de${opts.adopt ? ' (noi dung khac nguon, khong adopt)' : ' (them --adopt neu noi dung trung nguon)'}`); continue; }
      if (st.state === 'badmarker') { problems.push(`${where}: marker khong hop le (${st.reason}), khong dung`); continue; }
      if (st.state === 'edited' && !opts.force) { problems.push(`${where}: ban sinh bi sua tay, dung --force de ghi de`); continue; }
      const action = st.state === 'missing' ? 'create' : st.state === 'adoptable' ? 'adopt' : 'update';
      if (opts.apply) {
        try { writeSkill(dir, r, source, c.ops); } catch (e) { problems.push(`${where}: ghi that bai, giu ban cu: ${e.code || ''} ${e.message}`.trim()); continue; }
      }
      items.push({ skill: name, target: where, action, applied: !!opts.apply });
    }
  }
  return { items, problems, truncated, apply: !!opts.apply };
}

/** Dich co marker ma nguon khong con (theo ten). Khong marker -> bo qua; marker hong -> {invalid}; hash lech -> {edited}. */
function orphans(c) {
  const srcs = new Set(listSources(c.srcDir));
  const out = []; let truncated = null;
  for (const t of c.targets) for (const name of childDirs(t.dir)) {
    if (timedOut(c)) { truncated = 'timeout'; return { list: out, truncated }; }
    if (srcs.has(name)) continue;
    const dir = path.join(t.dir, name);
    const m = readMarker(dir, c, name);
    if (!m) continue;
    const o = { skill: name, target: `${t.rel}/${name}`, dir };
    if (!m.valid) { out.push({ ...o, invalid: m.reason }); continue; }
    const tr = readTree(dir, { limits: c.limits, skipMarker: true, deadline: c.deadline });
    out.push({ ...o, edited: !!tr.truncated || hashFiles(tr.files) !== m.hash });
  }
  return { list: out, truncated };
}

/** check: khong ghi. issues = [{skill,target,issue: unbuilt|drift|edited|conflict|badmarker|orphan|invalid}]. */
export function check(opts = {}) {
  const c = ctx(opts);
  const issues = []; let truncated = null; let checked = 0;
  for (const name of listSources(c.srcDir)) {
    if (timedOut(c)) { truncated = 'timeout'; break; }
    const r = renderSkill(c.srcDir, name, { limits: c.limits, deadline: c.deadline });
    if (r.problems.length) { issues.push({ skill: name, target: null, issue: 'invalid', detail: r.problems.join('; ') }); continue; }
    for (const t of c.targets) {
      checked++;
      const st = targetState(path.join(t.dir, name), name, r, c);
      const map = { missing: 'unbuilt', installed: 'conflict', adoptable: 'conflict', badmarker: 'badmarker', drift: 'drift', edited: 'edited' };
      if (map[st.state]) issues.push({ skill: name, target: `${t.rel}/${name}`, issue: map[st.state], ...(st.reason ? { detail: st.reason } : st.state === 'adoptable' ? { detail: 'trung nguon, chay build --apply --adopt' } : {}) });
    }
  }
  if (!truncated) {
    const o = orphans(c);
    truncated = o.truncated;
    for (const x of o.list) issues.push({ skill: x.skill, target: x.target, issue: x.invalid ? 'badmarker' : 'orphan', ...(x.invalid ? { detail: x.invalid } : {}) });
  }
  return { issues, checked, truncated, ok: !issues.length && !truncated };
}

/**
 * prune: mac dinh dry-run; apply=true moi xoa. Chi xoa thu muc co marker HOP LE, kiem lai ngay truoc khi xoa.
 * Marker hong -> khong dung, canh bao. Orphan bi sua tay (hash lech) -> chi xoa khi force=true.
 */
export function prune(opts = {}) {
  const c = ctx(opts);
  const items = []; const problems = [];
  const o = orphans(c);
  for (const x of o.list) {
    const it = { skill: x.skill, target: x.target, removed: false };
    if (x.invalid) { problems.push(`${x.target}: marker khong hop le (${x.invalid}), khong xoa`); items.push({ ...it, skipped: 'badmarker' }); continue; }
    if (x.edited && !opts.force) { problems.push(`${x.target}: ban sinh bi sua tay, dung --force de xoa`); items.push({ ...it, skipped: 'edited' }); continue; }
    if (opts.apply) {
      if (timedOut(c)) { o.truncated = 'timeout'; break; }
      const m = isRealDir(x.dir) ? readMarker(x.dir, c, x.skill) : null;
      if (m && m.valid) { fs.rmSync(x.dir, { recursive: true, force: true }); it.removed = true; }
    }
    items.push(it);
  }
  return { items, problems, truncated: o.truncated, apply: !!opts.apply };
}
