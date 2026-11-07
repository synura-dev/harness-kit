// Pure skill-usage detector: detect(record, ctx) -> event[]. No I/O.
// record = {session, project, ts, turn, file, msg}; ctx = {agentSkills?, skillNames?: Set}.
// Event: id = id day du (vd harness-kit:doctor), short = doan cuoi. Slash: 'skill' only if ctx.skillNames has short (or id); 'command' only if ctx.commandIds has id; else bo (built-in /clear, /model... khong phai muc dung).
// Slash callId = msg.uuid:blockIndex (dedupe khi doc lai cache); tool/read callId = tool_use id.

const last = (s) => String(s).split(':').pop();
const SLASH = /<command-name>\s*\/?([^<\s]+?)\s*<\/command-name>/g;
const THIRD_PARTY = /\/\.claude\/plugins\//; // cache/marketplaces cua plugin ben thu ba: khong ghep voi skill local cung ten
const SKILL_MD = /^(?:.*\/)?skills\/([^/]+)\/skill\.md$/i;

export function detect(record, ctx = {}) {
  try {
    const content = record?.msg?.message?.content;
    if (!content) return [];
    const base = { ts: record.ts, session: record.session, project: record.project, turn: record.turn, origin: 'transcript' };
    const ev = (kind, id, channel, extra = {}) => ({ kind, id, short: last(id), ...base, channel, ...extra });
    const out = [];
    if (typeof content === 'string' || Array.isArray(content)) {
      const items = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
      const uuid = record.msg.uuid;
      items.forEach((it, bi) => {
        try {
          if (!it || typeof it !== 'object') return;
          if (it.type === 'text' && typeof it.text === 'string' && record.msg.type === 'user') {
            let j = 0;
            for (const m of it.text.matchAll(SLASH)) {
              const id = m[1];
              const isSkill = ctx.skillNames?.has(last(id)) || ctx.skillNames?.has(id);
              const kind = isSkill ? 'skill' : ctx.commandIds?.has(id) ? 'command' : null;
              if (kind) out.push(ev(kind, id, 'slash', uuid ? { callId: `${uuid}:${bi}${j ? '.' + j : ''}` } : {}));
              j++;
            }
          } else if (it.type === 'tool_use') {
            const inp = it.input || {};
            if (it.name === 'Skill' && typeof inp.skill === 'string') {
              out.push(ev('skill', inp.skill, 'tool', { callId: it.id }));
            } else if (it.name === 'Read' && typeof inp.file_path === 'string') {
              const file = inp.file_path.replace(/\\/g, '/');
              const m = SKILL_MD.exec(file);
              if (m && !THIRD_PARTY.test(file)) out.push(ev('skill', m[1], 'read', { file, callId: it.id }));
            } else if ((it.name === 'Agent' || it.name === 'Task') && typeof inp.subagent_type === 'string') {
              const a = ctx.agentSkills, key = last(inp.subagent_type);
              const list = a && Object.hasOwn(a, key) ? a[key] : null;
              for (const s of Array.isArray(list) ? list : []) out.push(ev('skill', s, 'preload', { callId: `${it.id}:${s}` }));
            }
          }
        } catch { /* bo khoi hong, giu cac khoi khac */ }
      });
    }
    return out;
  } catch {
    return [];
  }
}
