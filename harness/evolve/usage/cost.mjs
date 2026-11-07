import { parseFrontmatter } from '../../core/agy/agents.mjs';

// shortcut: ~4 chars/token, no tokenizer
export const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

// desc = nap moi phien; body = nap khi dung. hook: 0; rule: ca van ban la desc.
export function componentCost({ kind, description, body } = {}) {
  if (kind === 'hook') return { desc_tokens: 0, body_tokens: 0 };
  if (kind === 'rule') return { desc_tokens: estimateTokens(body), body_tokens: 0 };
  const fm = parseFrontmatter(body);
  const desc = fm ? fm.data.description : description;
  return { desc_tokens: estimateTokens(desc ?? description), body_tokens: estimateTokens(fm ? fm.body : body) };
}

export const costPerUse = ({ desc_tokens = 0, body_tokens = 0 }, { count = 0, sessions = 0 } = {}) =>
  (desc_tokens * sessions + body_tokens * count) / Math.max(count, 1);

export function rankByCost(items) {
  const score = (i) => (i.count > 0 ? costPerUse(i, i) : i.desc_tokens || 0);
  return [...items].sort((a, b) => score(b) - score(a));
}
