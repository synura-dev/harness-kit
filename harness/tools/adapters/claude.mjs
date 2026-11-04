// Adapter Claude Code (agent .claude/agents/ viet tay, khong sinh): .agents/skills/<n> -> .claude/skills/<n> (copy hoac link).
// Khi harness/skills/<n>/SKILL.md ton tai (nguon that moi): skill do bo qua o day (sync.mjs goi `skills build`); skill chi co o .agents/skills (lane cai ngoai) van dong bo.
// Chi dong vao file/thu muc co dau GENERATED hoac trung ten voi nguon; skill tay (vd plugin-authoring) khong bi dong.
import fs from 'node:fs';
import path from 'node:path';
import { MARK, isGenerated, read, parseFrontmatter, isDir, listDirs, listDirFiles, rel, writeIfChanged, withHeader } from './_util.mjs';
import { samePath } from '../../core/io/paths.mjs';

export const name = 'claude';
const MARKER_FILE = '.generated';

function walk(dir, base = dir) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p).replace(/\\/g, '/'));
  }
  return out.sort();
}

// .agents/rules/**/*.md -> .claude/rules/**/*.md (giu frontmatter, them header). Bo qua nguon da GENERATED (vd orchestrator.md sinh tu AGENTS.md: CLAUDE.md da @AGENTS.md, tranh nap doi)
// va nguon khong co 'paths:' (Claude nap rule khong paths luon luon; frontmatter 'trigger' la cua agy). config.rulesAll=true de sinh ca rule khong paths.
function syncRules(root, check, config, changes) {
  const srcRoot = path.join(root, '.agents', 'rules');
  const dstRoot = path.join(root, '.claude', 'rules');
  const want = new Set();
  if (isDir(srcRoot)) for (const f of walk(srcRoot)) {
    if (!f.endsWith('.md')) continue;
    const src = path.join(srcRoot, f);
    const text = read(src) || '';
    if (isGenerated(text)) continue;
    const fm = parseFrontmatter(text);
    if (!config.rulesAll && !(fm && fm.data.paths !== undefined)) continue;
    want.add(f);
    const dst = path.join(dstRoot, f);
    if (writeIfChanged(dst, withHeader(text, rel(root, src)), check)) changes.push(rel(root, dst));
  }
  if (isDir(dstRoot)) for (const f of walk(dstRoot)) {
    if (!f.endsWith('.md') || want.has(f)) continue;
    const dst = path.join(dstRoot, f);
    if (isGenerated(read(dst))) {
      changes.push(`${rel(root, dst)} (xoa: nguon khong con)`);
      if (!check) fs.rmSync(dst);
    }
  }
}

function skillExpected(srcDir) {
  const m = new Map();
  for (const f of walk(srcDir)) {
    const buf = fs.readFileSync(path.join(srcDir, f));
    m.set(f, f === 'SKILL.md' ? Buffer.from(withHeader(buf.toString('utf8'), `.agents/skills/${path.basename(srcDir)}/SKILL.md`)) : buf);
  }
  return m;
}

const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };

// Link dung = realpath trung nguon (link hong/tro sai -> false). Tren POSIX con yeu cau target tuong doi (de dom may khong gay link).
function isLinkTo(dst, src) {
  try {
    if (!fs.lstatSync(dst).isSymbolicLink()) return false;
    if (!samePath(fs.realpathSync(dst), fs.realpathSync(src))) return false;
    return process.platform === 'win32' || !path.isAbsolute(fs.readlinkSync(dst));
  } catch { return false; }
}

// Go link (symlink/junction) ma khong dong vao noi dung dich.
function removeLink(p) {
  try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch {} }
}

// Tao link toi src: symlink TUONG DOI; Windows khong du quyen -> junction (bat buoc tuyet doi, may-cuc-bo, sync tao lai khi dom may).
function makeLink(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const relTarget = path.relative(path.dirname(dst), src);
  try { fs.symlinkSync(relTarget, dst, 'dir'); return 'symlink'; } catch (e) {
    if (process.platform !== 'win32') throw e;
  }
  fs.symlinkSync(path.resolve(src), dst, 'junction');
  return 'junction';
}

// Dich la symlink/junction DUNG hoac cung realpath voi nguon: bo qua, khong bao gio ghi vao nguon.
// Link hong/tro sai khong phai alias (se bi go va thay).
function isAlias(dst, src) {
  try { return samePath(fs.realpathSync(dst), fs.realpathSync(src)); } catch { return false; }
}

function syncSkills(root, check, mode, changes, problems, skip = new Set()) {
  const srcRoot = path.join(root, '.agents', 'skills');
  const dstRoot = path.join(root, '.claude', 'skills');
  for (const n of listDirs(srcRoot).filter((x) => !skip.has(x) && fs.existsSync(path.join(srcRoot, x, 'SKILL.md')))) {
    const src = path.join(srcRoot, n);
    const dst = path.join(dstRoot, n);
    if (mode === 'link') {
      if (isLinkTo(dst, src)) continue;
      changes.push(`${rel(root, dst)} (link)`);
      if (check) continue;
      try {
        if (lstat(dst)?.isSymbolicLink()) removeLink(dst); else fs.rmSync(dst, { recursive: true, force: true });
        makeLink(src, dst);
        continue;
      } catch (e) { changes.push(`${rel(root, dst)} (link that bai: ${e.code || e.message}; chuyen sang copy)`); }
    }
    if (isAlias(dst, src)) continue;
    // link hong/tro sai (vd dom may): go link truoc khi copy, de khong ghi qua link
    if (lstat(dst)?.isSymbolicLink()) { changes.push(`${rel(root, dst)} (link hong/tro sai: tao lai)`); if (!check) removeLink(dst); else continue; }
    const want = skillExpected(src);
    let drift = false;
    for (const [f, buf] of want) {
      const dstF = path.join(dst, f);
      let have = null; try { have = fs.readFileSync(dstF); } catch {}
      if (!have || !have.equals(buf)) {
        drift = true;
        if (!check) { fs.mkdirSync(path.dirname(dstF), { recursive: true }); fs.writeFileSync(dstF, buf); }
      }
    }
    if (isDir(dst)) for (const f of walk(dst)) if (f !== MARKER_FILE && !want.has(f)) { drift = true; if (!check) fs.rmSync(path.join(dst, f)); }
    if (writeIfChanged(path.join(dst, MARKER_FILE), `${MARK}: sinh tu .agents/skills/${n} boi tools/sync.mjs\n`, check)) drift = true;
    if (drift) changes.push(rel(root, dst));
  }
  // skill sinh cu khong con nguon
  for (const n of listDirs(dstRoot)) {
    if (skip.has(n) || fs.existsSync(path.join(srcRoot, n, 'SKILL.md'))) continue;
    if (fs.existsSync(path.join(dstRoot, n, MARKER_FILE))) {
      changes.push(`${rel(root, path.join(dstRoot, n))} (xoa: nguon khong con)`);
      if (!check) fs.rmSync(path.join(dstRoot, n), { recursive: true, force: true });
    }
  }
}

// Ten skill co nguon that o harness/skills (do `skills build` lo); skill con lai (vd lane cai ngoai chi o .agents/skills) van do syncSkills cu dong bo.
function harnessSkillNames(root) {
  return new Set(listDirs(path.join(root, 'harness', 'skills')).filter((n) => fs.existsSync(path.join(root, 'harness', 'skills', n, 'SKILL.md'))));
}

export async function run({ root, check = false, config = {} }) {
  const changes = [];
  const problems = [];
  syncSkills(root, check, config.skillsMode === 'link' ? 'link' : 'copy', changes, problems, harnessSkillNames(root));
  syncRules(root, check, config, changes);
  return { changes, problems };
}
