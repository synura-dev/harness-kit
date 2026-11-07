// Phan loai nguon cua item (skill/agent/...) de chi de xuat go thu user that su go duoc.
const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
const under = (p, roots) => (roots || []).some((r) => { const x = norm(r).replace(/\/+$/, ''); return x && (p === x || p.startsWith(x + '/')); });

export function classifySource({ id, path, pluginRoots, projectRoots, builtin } = {}) {
  const sid = String(id || '');
  if (sid.startsWith('anthropic-skills:')) return 'account';
  if (/^[^:\s]+:/.test(sid)) return 'plugin';
  const p = norm(path);
  if (p) {
    if (under(p, pluginRoots) || p.includes('/plugins/cache/')) return 'plugin';
    if (/\/\.(claude|agents)\//.test(p) && (!(projectRoots || []).length || under(p, projectRoots))) return 'project';
    return 'unknown';
  }
  if ((builtin || []).includes(sid)) return 'builtin';
  return 'unknown';
}

const ACTIONS = { project: 'delete_in_repo', plugin: 'edit_plugin_repo', account: 'disable_on_claude_ai' };
export const actionFor = (source) => ACTIONS[source] || 'report_only';
// builtin/unknown/account khong bao gio la ung vien go truc tiep: chi project|plugin.
export const canPropose = (source) => source === 'project' || source === 'plugin';
