// Bao cao hook x CLI + sinh bang README (loi thuan cua cli/adapters.mjs; dat o core de tools/sync dung ma khong import cli).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../harness/core/config/config.mjs';
import { toPosix } from '../harness/core/io/paths.mjs';

// Danh sach CLI ho tro, doc tu config workspace (config/workspace config: moi CLI: enabled, hookRegistration, adapterFiles). Co fallback khi thieu.
// hookRegistration: file dang ky hook cua CLI (tuong doi goc workspace). adapterFiles: ten file adapter hop le trong <hook>/ (de canh bao 'none' ma van co file).

export const DEFAULT_TOOLS = {
  claude: { enabled: true, hookRegistration: '.claude/settings.json', adapterFiles: ['adapters/claude.mjs'] },
  agy: { enabled: true, hookRegistration: '.agents/hooks.json', adapterFiles: ['adapters/agy.mjs'] },
};

// Nguon tools: config workspace qua loadConfig('workspace'); thieu thi doc cu config/tools.json (canh bao legacy-config).
// strict=true: tools.json cu hong/khong doc duoc thi throw (sync); mac dinh nuot loi. Tra {tools|null, warnings}.
export function loadToolsConfig(root, { strict = false } = {}) {
  const r = loadConfig('workspace', { root });
  const warnings = r.warnings.slice();
  if (r.config.tools && typeof r.config.tools === 'object') return { tools: r.config.tools, warnings };
  let txt;
  try { txt = fs.readFileSync(path.join(root, 'config', 'tools.json'), 'utf8'); }
  catch (e) { if (strict && e && e.code !== 'ENOENT') throw new Error('config/tools.json khong doc duoc: ' + e.message); return { tools: null, warnings }; }
  warnings.push('legacy-config: tools.json -> workspace config');
  try { const j = JSON.parse(txt.charCodeAt(0) === 0xfeff ? txt.slice(1) : txt); return { tools: j && j.tools && typeof j.tools === 'object' ? j.tools : (strict ? {} : null), warnings }; }
  catch (e) { if (strict) throw new Error('config/tools.json JSON hong: ' + e.message); return { tools: null, warnings }; }
}

const fallback = () => Object.entries(DEFAULT_TOOLS).map(([name, d]) => ({ name, ...d }));

function loadClis(root) {
  const tools = loadToolsConfig(root).tools;
  if (!tools) return fallback();
  const out = [];
  for (const [name, cfg] of Object.entries(tools)) {
    if (!cfg || typeof cfg !== 'object' || cfg.enabled === false) continue;
    const d = DEFAULT_TOOLS[name] || {};
    out.push({
      name,
      hookRegistration: cfg.hookRegistration || d.hookRegistration || null,
      adapterFiles: Array.isArray(cfg.adapterFiles) ? cfg.adapterFiles : d.adapterFiles || [`adapters/${name}.mjs`],
    });
  }
  return out.length ? out : fallback();
}

const MAX_BYTES = 2_000_000;
const SPECIAL = new Set(['native', 'none', 'n/a']);
const LEGACY = /(^|\/)[a-z]+_adapter\.mjs$/;
const norm = toPosix;

function readJsonResult(file) {
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_BYTES) return { err: 'file qua lon' };
    const t = fs.readFileSync(file, 'utf8');
    return { json: JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t) };
  } catch (e) { return { err: e.code === 'ENOENT' ? null : (e.code || e.message) }; }
}

// lay moi file harness/hooks/<dir>/<file>.mjs tu cac command trong JSON bat ky
export function registeredFiles(json) {
  const out = new Set();
  const re = /harness\/hooks\/([^/\s"']+)\/([^\s"']+?\.mjs)/g;
  const walk = (v, depth = 0) => {
    if (depth > 12 || v == null) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (typeof v !== 'object') return;
    if (typeof v.command === 'string') for (const m of norm(v.command).matchAll(re)) out.add(`${m[1]}/${m[2]}`);
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(json);
  return out;
}

export function buildReport(root) {
  const warnings = [];
  // nguon: harness/hooks/<nhom>/manifest.json (truong adapters); bo qua nhom bat dau bang "_"
  const hooks = [];
  const hooksDir = path.join(root, 'harness', 'hooks');
  let names = [];
  try { names = fs.readdirSync(hooksDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name).sort(); } catch {}
  for (const n of names) {
    const mj = readJsonResult(path.join(hooksDir, n, 'manifest.json'));
    if (mj.err) { warnings.push(`adapters: harness/hooks/${n}/manifest.json khong doc duoc: ${mj.err}`); continue; }
    if (mj.json && typeof mj.json === 'object') hooks.push({ id: mj.json.id || n, path: `harness/hooks/${n}`, adapters: mj.json.adapters });
    else warnings.push(`adapters: harness/hooks/${n}: thieu manifest.json`);
  }
  if (!hooks.length) return { rows: [], warnings: [...warnings, 'adapters: khong doc duoc manifest.json cua hook nao'] };
  const clis = loadClis(root);
  const CLIS = clis.map((x) => x.name);
  const KNOWN_FILES = Object.fromEntries(clis.map((x) => [x.name, x.adapterFiles]));
  const reg = Object.fromEntries(clis.map((x) => [x.name, x.hookRegistration ? readJsonResult(path.join(root, x.hookRegistration)) : {}]));
  const regFiles = {};
  for (const c of CLIS) {
    if (reg[c].err) warnings.push(`adapters: khong doc duoc dang ky ${c}: ${reg[c].err}`);
    regFiles[c] = reg[c].json ? registeredFiles(reg[c].json) : new Set();
  }
  const dirs = new Set(hooks.map((u) => norm(u.path).replace(/^harness\/hooks\//, '')));
  const rows = [];
  for (const u of hooks) {
    const dir = norm(u.path).replace(/^harness\/hooks\//, '');
    const ad = u.adapters || {};
    const row = { hook: dir, id: u.id, note: ad.note || '', registered: {} };
    for (const c of CLIS) row[c] = ad[c] || '?';
    if (!u.adapters) warnings.push(`adapters: ${u.id}: manifest thieu truong adapters`);
    for (const c of CLIS) {
      const v = ad[c];
      const files = [...regFiles[c]].filter((f) => f.startsWith(dir + '/')).map((f) => f.slice(dir.length + 1));
      row.registered[c] = files;
      if (v && !SPECIAL.has(v) && !fs.existsSync(path.join(root, u.path, v))) warnings.push(`adapters: ${u.id}: adapter ${c} ghi ${v} nhung file khong ton tai`);
      if (v && !SPECIAL.has(v) && LEGACY.test(norm(v))) warnings.push(`adapters: ${u.id}: adapter ${c} kieu cu ${v}; chuyen vao adapters/${c}.mjs`);
      if (v === 'none') {
        const found = KNOWN_FILES[c].find((f) => fs.existsSync(path.join(root, u.path, f)));
        if (found) warnings.push(`adapters: ${u.id}: co file ${found} nhung manifest ghi ${c}=none`);
      }
      if ((v === 'none' || v === 'n/a') && files.length) warnings.push(`adapters: ${u.id}: ${c} dang ky ${files.join(', ')} nhung manifest ghi ${v}`);
    }
    const declared = new Set(Object.values(ad).filter((x) => typeof x === 'string').map(norm));
    try {
      const ads = path.join(root, u.path, 'adapters');
      if (fs.existsSync(ads)) for (const f of fs.readdirSync(ads)) {
        if (/\.mjs$/.test(f) && !/\.test\.mjs$/.test(f) && !declared.has('adapters/' + f)) warnings.push(`adapters: ${u.id}: co adapters/${f} nhung manifest khong khai bao`);
      }
      for (const f of fs.readdirSync(path.join(root, u.path))) {
        if (/^agy_.*\.mjs$/.test(f) && !/\.test\.mjs$/.test(f) && !declared.has(f)) warnings.push(`adapters: ${u.id}: file le ${f} o goc nhom; chuyen vao adapters/`);
      }
    } catch {}
    rows.push(row);
  }
  for (const c of CLIS) {
    for (const f of regFiles[c]) {
      const [d] = f.split('/');
      if (!fs.existsSync(path.join(root, 'harness', 'hooks', f))) warnings.push(`adapters: ${c} dang ky file khong ton tai: harness/hooks/${f}`);
      else if (!dirs.has(d)) warnings.push(`adapters: ${c} dang ky harness/hooks/${f} nhung nhom ${d} khong co trong manifest`);
    }
  }
  return { rows, warnings, clis: CLIS };
}

export function formatAdaptersTable(rows, clis) {
  const cs = clis || (rows[0] ? Object.keys(rows[0].registered) : ['claude', 'agy']);
  const cell = (r, c) => r[c] + (r.registered[c].length ? ' [dk]' : '');
  const head = ['hook', ...cs, 'dang ky (settings.json / hooks.json)'];
  const body = rows.map((r) => [r.hook, ...cs.map((c) => cell(r, c)), cs.map((c) => `${c}: ${r.registered[c].join(',') || '-'}`).join(' | ')]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const fmt = (a) => a.map((x, i) => x.padEnd(w[i])).join(' | ');
  return [fmt(head), w.map((n) => '-'.repeat(n)).join('-|-'), ...body.map(fmt)].join('\n');
}

const README_BEGIN = '<!-- GENERATED:adapters (node harness/cli/harness.mjs adapters --write-readme) -->';
const README_END = '<!-- /GENERATED -->';

// Bang markdown hook x CLI cho harness/README.md (sinh, khong chep tay).
export function markdownTable(rows, clis) {
  const cs = clis || (rows[0] ? Object.keys(rows[0].registered) : []);
  const esc = (x) => String(x).replace(/\|/g, '\\|');
  const head = ['hook', ...cs, 'ghi chu'];
  const body = rows.map((r) => [`\`${r.hook}\``, ...cs.map((c) => esc(r[c]) + (r.registered[c].length ? ' [dk]' : '')), esc(r.note || '')]);
  const line = (a) => '| ' + a.join(' | ') + ' |';
  return [line(head), line(head.map(() => '---')), ...body.map(line)].join('\n');
}

// Thay khoi giua marker trong README; tra { text, found }.
export function applyReadme(text, table) {
  const i = text.indexOf('<!-- GENERATED:adapters'), k = text.indexOf(README_END, i);
  if (i < 0 || k < 0) return null;
  return text.slice(0, i) + README_BEGIN + '\n' + table + '\n' + text.slice(k);
}

// write=false: chi kiem; tra { changed, problem }
export function syncReadme(root, write = false) {
  const f = path.join(root, 'harness', 'README.md');
  let t; try { t = fs.readFileSync(f, 'utf8'); } catch { return { changed: false }; }
  const rep = buildReport(root);
  const n = applyReadme(t, markdownTable(rep.rows, rep.clis));
  if (n === null) return { changed: false, problem: 'harness/README.md thieu marker GENERATED:adapters' };
  if (n === t) return { changed: false };
  if (write) fs.writeFileSync(f, n);
  return { changed: true };
}
