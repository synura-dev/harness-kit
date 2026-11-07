// Pure skill-usage detector: detect(record, ctx) -> event[]. No I/O.
// record = {session, project, ts, turn, file, msg}; ctx = {agentSkills?, skillNames?: Set}.
// Slash: `<command-name>/x</command-name>` is kind 'skill' only if ctx.skillNames has x, else kind 'command'.

const last = (s) => String(s).split(':').pop();
const SLASH = /<command-name>\s*\/?([^<\s]+?)\s*<\/command-name>/g;
const SKILL_MD = /^(?:.*\/)?([^/]+)\/skill\.md$/i;

export function detect(record, ctx = {}) {
  try {
    const content = record?.msg?.message?.content;
    if (!content) return [];
    const base = { ts: record.ts, session: record.session, project: record.project, turn: record.turn, origin: 'transcript' };
    const ev = (kind, id, channel, extra = {}) => ({ kind, id, ...base, channel, ...extra });
    const out = [];
    if (typeof content === 'string' || Array.isArray(content)) {
      const items = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        if (it.type === 'text' && typeof it.text === 'string' && record.msg.type === 'user') {
          for (const m of it.text.matchAll(SLASH)) {
            const id = last(m[1]);
            out.push(ev(ctx.skillNames?.has(id) ? 'skill' : 'command', id, 'slash'));
          }
        } else if (it.type === 'tool_use') {
          const inp = it.input || {};
          if (it.name === 'Skill' && typeof inp.skill === 'string') {
            out.push(ev('skill', last(inp.skill), 'tool', { callId: it.id }));
          } else if (it.name === 'Read' && typeof inp.file_path === 'string') {
            const file = inp.file_path.replace(/\\/g, '/');
            const m = SKILL_MD.exec(file);
            if (m) out.push(ev('skill', m[1], 'read', { file, callId: it.id }));
          } else if (it.name === 'Agent' || it.name === 'Task') {
            for (const s of ctx.agentSkills?.[inp.subagent_type] || []) {
              out.push(ev('skill', s, 'preload', { callId: `${it.id}:${s}` }));
            }
          }
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}
