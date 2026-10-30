// Nguon duy nhat cho hub root. Thu tu: env HUB_DIR > config/paths.local.json {"hubDir"} > thu muc chua repo (tinh tu vi tri file).
// Node built-ins only, KHONG nem loi. Moi script (sync, doctor, hook adapter) import tu day.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Kiem object thuan (khong null, khong mang): luon tra boolean.
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const readJson = (f) => {
  try { const t = fs.readFileSync(f, 'utf8'); return JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t); } catch { return null; }
};

// opts: { env, repoDir } -> { hubDir, source: 'env'|'paths.local.json'|'default' }. hubDir tuong doi duoc tinh theo repoDir.
// Che do plugin: ma nam trong plugin da export (co .claude-plugin/plugin.json o goc ma). PLUGIN_ROOT chi doc; goc workspace = du an (CLAUDE_PROJECT_DIR > cwd), du lieu mac dinh <du an>/.harness/data.
export const isPluginMode = (repoDir = REPO_DIR) => { try { return fs.existsSync(path.join(repoDir, '.claude-plugin', 'plugin.json')); } catch { return false; } };

export function resolveHub({ env = process.env, repoDir = REPO_DIR, cwd = process.cwd() } = {}) {
  const e = env.HUB_DIR;
  if (typeof e === 'string' && e.trim()) return { hubDir: path.resolve(repoDir, e.trim()), source: 'env' };
  if (isPluginMode(repoDir)) {
    const p = env.CLAUDE_PROJECT_DIR;
    return { hubDir: path.resolve(typeof p === 'string' && p.trim() ? p.trim() : cwd), source: 'plugin' };
  }
  const j = readJson(path.join(repoDir, 'config', 'paths.local.json'));
  if (j && typeof j.hubDir === 'string' && j.hubDir.trim()) return { hubDir: path.resolve(repoDir, j.hubDir.trim()), source: 'paths.local.json' };
  return { hubDir: repoDir, source: 'default' };
}

/** Chuan hoa dau gach cheo nguoc -> xuoi (thuan). */
export const toPosix = (s) => String(s).replace(/\\/g, '/');
export const hubDir = (opts) => resolveHub(opts).hubDir;
// Ten trung tinh: workspaceRoot() = goc workspace (hubDir() la alias cu). codeRoot() = repo chua harness/ (khong doi theo HUB_DIR).
export const resolveWorkspace = (opts) => { const r = resolveHub(opts); return { workspaceRoot: r.hubDir, source: r.source }; };
export const workspaceRoot = (opts) => resolveHub(opts).hubDir;
export const codeRoot = () => REPO_DIR;

// Goc du lieu: env HUB_DATA_DIR > <hubDir()>/data; them /<kind> neu co. Mac dinh trung vi tri cu (<hub>/data/<kind>).
export function dataDir(kind, opts = {}) {
  const env = opts.env || process.env;
  const e = env.HUB_DATA_DIR;
  const r = resolveHub(opts);
  const plug = path.join(r.hubDir, '.harness', 'data');
  // Mot goc cho cung workspace: hook plugin ghi <ws>/.harness/data; CLI (ma sao chep, khong plugin.json) thay thu muc do thi dung chung. Hub goc khong co .harness -> giu data/.
  const base = typeof e === 'string' && e.trim() ? path.resolve(e.trim()) : r.source === 'plugin' || (r.source === 'default' && fs.existsSync(plug)) ? plug : path.join(r.hubDir, 'data');
  return kind ? path.join(base, String(kind)) : base;
}

// Plugin mode: tao lazy khi ghi dau <du an>/.harness/.gitignore (noi dung: data/). Khong throw; chi tao neu chua co.
export function ensureDataIgnore(opts = {}) {
  try {
    if (!isPluginMode(opts.repoDir)) return false;
    const r = resolveHub(opts);
    if (r.source !== 'plugin') return false;
    const d = path.join(r.hubDir, '.harness');
    const f = path.join(d, '.gitignore');
    if (fs.existsSync(f)) {
      const cur = fs.readFileSync(f, 'utf8');
      if (cur.split(/\r?\n/).some((l) => l.trim() === '*')) return false;
      fs.appendFileSync(f, (cur === '' || cur.endsWith('\n') ? '' : '\n') + '*\n');
      return true;
    }
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(f, '*\n');
    return true;
  } catch { return false; }
}

export const dataRoot = (kind, opts) => dataDir(kind, opts); // ten trung tinh cua dataDir

// So sanh duong dan: khong phan biet hoa thuong tren win32.
export function samePath(a, b) {
  const norm = (s) => { const r = path.resolve(s); return process.platform === 'win32' ? r.toLowerCase() : r; };
  return norm(a) === norm(b);
}

// true neu p nam trong (hoac bang) dir; khong phan biet hoa thuong tren win32.
export function isInside(p, dir) {
  const norm = (s) => { const r = path.resolve(s); return process.platform === 'win32' ? r.toLowerCase() : r; };
  const rel = path.relative(norm(dir), norm(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Quet link (symlink/junction) truc tiep trong skillsDir: tra [{ name, problem: 'hong'|'ngoai-hub', target }].
export function findBadLinks(skillsDir, hub) {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(skillsDir, { withFileTypes: true }); } catch { return out; }
  for (const d of ents) {
    const p = path.join(skillsDir, d.name);
    let st; try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isSymbolicLink()) continue;
    let real = null; try { real = fs.realpathSync(p); } catch {}
    if (real == null) { let t = '?'; try { t = fs.readlinkSync(p); } catch {} out.push({ name: d.name, problem: 'hong', target: t }); }
    else if (!isInside(real, hub)) out.push({ name: d.name, problem: 'ngoai-hub', target: real });
  }
  return out;
}

// Schema hooks.json cua agy (VERIFIED agy 1.4.3): key cap cao nhat = ten hook -> { enabled?, <Event>: [...] }.
// SessionStart/PreInvocation/PostInvocation/Stop: danh sach handler phang. PreToolUse/PostToolUse: [{matcher, hooks:[handler]}].
const AGY_FLAT_EVENTS = ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop'];
const AGY_TOOL_EVENTS = ['PreToolUse', 'PostToolUse'];

// Duyet hooks.json agy: { handlers: [{hook,event,command}], problems: [string] }. Tu choi layout kieu Claude ({"hooks":{Event:[...]}}).
export function walkAgyHooks(j) {
  const handlers = [];
  const problems = [];
  if (!isObj(j)) return { handlers, problems: ['hooks.json phai la object {tenHook: {...}}'] };
  for (const [hook, spec] of Object.entries(j)) {
    if (!isObj(spec)) { problems.push(`hook "${hook}": phai la object`); continue; }
    if (hook === 'hooks') problems.push('layout kieu Claude ({"hooks":{Event:[...]}}): agy can key cap cao = ten hook, vd {"audit-logger":{"PostToolUse":[...]}}');
    for (const [ev, list] of Object.entries(spec)) {
      if (ev === 'enabled') continue;
      const tool = AGY_TOOL_EVENTS.includes(ev);
      if (!tool && !AGY_FLAT_EVENTS.includes(ev)) { problems.push(`hook "${hook}": event "${ev}" khong hop le`); continue; }
      if (!Array.isArray(list)) { problems.push(`hook "${hook}".${ev}: phai la mang`); continue; }
      for (const item of list) {
        if (!isObj(item)) { problems.push(`hook "${hook}".${ev}: phan tu phai la object`); continue; }
        if (tool) {
          if (!Array.isArray(item.hooks)) { problems.push(`hook "${hook}".${ev}: can {matcher, hooks:[...]}`); continue; }
          for (const h of item.hooks) handlers.push({ hook, event: ev, command: isObj(h) ? h.command : undefined });
        } else if (item.hooks !== undefined || item.matcher !== undefined) {
          problems.push(`hook "${hook}".${ev}: event phang, khong boc {matcher, hooks}`);
        } else handlers.push({ hook, event: ev, command: item.command });
      }
    }
  }
  return { handlers, problems };
}

// Quet command trong hooks.json: [{ command, problem: 'tuyet-doi'|'ngoai-hub'|'agents-prefix' }] neu co duong dan tuyet doi.
export function findBadHookCommands(hooksJsonFile, hub) {
  const out = [];
  const j = readJson(hooksJsonFile);
  if (!j) return out;
  for (const { command } of walkAgyHooks(j).handlers) {
    const c = command || '';
    const m = /(?:^|[\s"'])((?:[A-Za-z]:[\\/]|\/)[^\s"']*)/.exec(c);
    if (/^node\s+"?\.?[\\/]?\.agents[\\/]/.test(c)) out.push({ command: c, problem: 'agents-prefix' });
    if (m) out.push({ command: c, problem: isInside(m[1], hub) ? 'tuyet-doi' : 'ngoai-hub' });
  }
  return out;
}
