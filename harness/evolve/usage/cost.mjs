import path from 'node:path';
import { parseFrontmatter } from '../../core/agy/agents.mjs';

// shortcut: ~4 chars/token, no tokenizer
export const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

// desc = nap moi phien; body = nap khi dung. hook: 0; rule: ca van ban la desc.
export function componentCost({ kind, description, body } = {}) {
  if (kind === 'hook') return { desc_tokens: 0, body_tokens: 0 };
  if (kind === 'rule') return { desc_tokens: estimateTokens(body), body_tokens: 0 };
  body = String(body ?? '').replace(/^\uFEFF/, '');
  const fm = parseFrontmatter(body);
  let desc = fm ? fm.data.description : description;
  if (fm && /^[>|][+-]?$/.test(String(desc).trim())) { // YAML block scalar: doc cac dong thut le ke tiep
    const lines = fm.fm.split(/\r?\n/); const i = lines.findIndex((l) => /^description:/.test(l));
    const folded = []; for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) folded.push(lines[j].trim());
    desc = folded.join(' ');
  }
  return { desc_tokens: estimateTokens(desc ?? description), body_tokens: estimateTokens(fm ? fm.body : body) };
}

// desc nap o MOI phien trong cua so (totalSessions = tat ca phien, khong chi phien da dung); body nap khi dung.
export const windowCost = ({ desc_tokens = 0, body_tokens = 0 } = {}, { count = 0, totalSessions = 0 } = {}) =>
  desc_tokens * totalSessions + body_tokens * count;

export const costPerUse = ({ desc_tokens = 0, body_tokens = 0 }, { count = 0, sessions = 0 } = {}) =>
  (desc_tokens * sessions + body_tokens * count) / Math.max(count, 1);

// items: {desc_tokens, body_tokens, count}; totalSessions = so phien trong cua so. Xep theo windowCost giam dan.
export function rankByCost(items, { totalSessions = 0 } = {}) {
  return items.map((i) => {
    const wc = windowCost(i, { count: i.count, totalSessions });
    return { ...i, windowCost: wc, costPerUse: wc / Math.max(i.count || 0, 1) };
  }).sort((a, b) => b.windowCost - a.windowCost);
}

// Claude ma hoa duong dan du an thanh ten thu muc duoi ~/.claude/projects: moi ky tu khong phai chu/so -> '-'.
export const projectFolder = (p) => path.resolve(String(p)).replace(/[^A-Za-z0-9]/g, '-');

// Windows: ten thu muc du an co the khac hoa/thuong -> cong moi khoa trung nhau khong phan biet hoa thuong.
export const sessionsOf = (byProject, folder) => { const f = folder.toLowerCase(); let n = 0; for (const [k, v] of Object.entries(byProject || {})) if (k.toLowerCase() === f) n += v; return n; };

// So phien noi thanh phan thuc su duoc nap: project -> phien cua thu muc du an; plugin -> du an cai plugin
// (installed_plugins.json; scope user hoac khong ro = tat ca); account/builtin/third_party/unknown -> tat ca.
export function scopeSessions({ source, plugin } = {}, { total = 0, byProject = {}, projectDir = '', installed = null } = {}) {
  if (source === 'project') return projectDir ? sessionsOf(byProject, projectFolder(projectDir)) : total;
  if (source !== 'plugin') return total;
  const list = plugin && installed?.plugins ? Object.entries(installed.plugins).filter(([k]) => k.split('@')[0] === plugin).flatMap(([, v]) => (Array.isArray(v) ? v : [])) : [];
  if (!list.length || list.some((i) => !i.projectPath || (i.scope !== 'project' && i.scope !== 'local'))) return total; // shortcut: khong ro noi cai -> tinh het (khong de thieu)
  return [...new Set(list.map((i) => projectFolder(i.projectPath)))].reduce((n, f) => n + sessionsOf(byProject, f), 0);
}
