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
