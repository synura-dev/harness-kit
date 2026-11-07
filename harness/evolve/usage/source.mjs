// Phan loai nguon cua item (skill/agent/...) de chi de xuat go thu user that su go duoc.
// plugin = chi plugin user so huu (path duoi pluginRoots hoac prefix thuoc ownedPlugins); plugin khac -> third_party.
const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
const under = (p, roots) => (roots || []).some((r) => { const x = norm(r).replace(/\/+$/, ''); return x && (p === x || p.startsWith(x + '/')); });

export function classifySource({ id, path, pluginRoots, projectRoots, ownedPlugins, builtin } = {}) {
  const sid = String(id || '');
  if (sid.startsWith('anthropic-skills:')) return 'account';
  const p = norm(path);
  if (/^[^:\s]+:/.test(sid)) {
    const owned = ownedPlugins instanceof Set ? ownedPlugins : new Set(ownedPlugins || []);
    return owned.has(sid.split(':')[0]) || (p && under(p, pluginRoots)) ? 'plugin' : 'third_party';
  }
  if (p) {
    if (under(p, pluginRoots)) return 'plugin';
    if (p.includes('/plugins/cache/') || p.includes('/.claude/plugins/') || p.includes('/marketplaces/')) return 'third_party';
    if (/\/\.(claude|agents)\//.test(p) && under(p, projectRoots)) return 'project';
    return 'unknown';
  }
  if ((builtin || []).includes(sid)) return 'builtin';
  return 'unknown';
}

const ACTIONS = { project: 'delete_in_repo', plugin: 'edit_plugin_repo', account: 'disable_on_claude_ai' };
export const actionFor = (source) => ACTIONS[source] || 'report_only'; // third_party/builtin/unknown -> report_only
// chi project|plugin la ung vien go truc tiep.
export const canPropose = (source) => source === 'project' || source === 'plugin';
