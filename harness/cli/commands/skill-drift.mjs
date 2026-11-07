// doctor check `skill-drift`: so hash ban sao skill (.claude/skills, .agents/skills, plugin cache). Chi doc, co gioi han.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const IGNORE = new Set(['.generated.json']);

/** sha1 over sorted rel paths + raw bytes (CRLF-normalized chi voi van ban); null neu vuot gioi han (budget.stop dat). */
export function hashSkillDir(dir, budget) {
  const files = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (budget.stop) return;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile() && !IGNORE.has(e.name)) {
        if (++budget.files > budget.maxFiles) { budget.stop = 'max_files'; return; }
        if (Date.now() > budget.deadline) { budget.stop = 'timeout'; return; }
        files.push(r);
      }
    }
  };
  walk(dir, '');
  if (budget.stop) return null;
  const h = crypto.createHash('sha1');
  for (const r of files.sort()) {
    if (Date.now() > budget.deadline) { budget.stop = 'timeout'; return null; }
    h.update(r + '\0');
    let buf = fs.readFileSync(path.join(dir, ...r.split('/')));
    // CRLF chi chuan hoa cho van ban (khong co byte NUL); nhi phan hash nguyen
    if (!buf.includes(0)) buf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'));
    h.update(buf); h.update('\0');
  }
  return h.digest('hex');
}

/** -> {findings:[{level:'ok'|'warn'|'info', skill, detail}], truncated:''|'max_files'|'timeout'} */
export function skillDrift({ projectDir, pluginSkillsDir = null, maxFiles = 2000, timeoutMs = 5000 } = {}) {
  const budget = { files: 0, maxFiles, deadline: Date.now() + timeoutMs, stop: '' };
  const roots = [['.claude/skills', path.join(projectDir, '.claude', 'skills')], ['.agents/skills', path.join(projectDir, '.agents', 'skills')]];
  const names = new Set();
  for (const [, r] of roots) { try { for (const e of fs.readdirSync(r, { withFileTypes: true })) if (e.isDirectory()) names.add(e.name); } catch { /* khong co */ } }
  // thu muc goc vang hoan toan (vd khong co .agents/skills) -> khong bao 'thieu ban sao'
  const existing = new Set(roots.filter(([, r]) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } }).map(([l]) => l));
  existing.add('plugin-cache');
  const findings = [];
  for (const n of [...names].sort()) {
    const copies = roots.map(([label, r]) => [label, path.join(r, n)]);
    if (pluginSkillsDir && fs.existsSync(path.join(pluginSkillsDir, n))) copies.push(['plugin-cache', path.join(pluginSkillsDir, n)]);
    const have = [], missing = [];
    for (const [label, d] of copies) {
      let ok = false; try { ok = fs.statSync(d).isDirectory(); } catch { /* thieu */ }
      if (!ok) { if (existing.has(label)) missing.push(label); continue; }
      const h = hashSkillDir(d, budget);
      if (budget.stop) return { findings, truncated: budget.stop };
      have.push([label, h]);
    }
    if (missing.length) findings.push({ level: 'info', skill: n, detail: `thieu ban sao: ${missing.join(', ')}` });
    if (have.length < 2) continue;
    const groups = new Map();
    for (const [label, h] of have) (groups.get(h) || groups.set(h, []).get(h)).push(label);
    if (groups.size === 1) findings.push({ level: 'ok', skill: n, detail: `${have.length} ban giong nhau` });
    else findings.push({ level: 'warn', skill: n, detail: 'lech: ' + [...groups.values()].map((g) => g.join('+')).join(' != ') });
  }
  return { findings, truncated: budget.stop };
}
