// harness/knowledge/vault/rank.mjs - Cham diem va xep hang ghi chu vault. Thuan, khong I/O.
// Khi co text: tu khoa tat dinh -> cham diem (id/tag/kind=3, line/source=1), loc minScore, rule truoc, roi diem, kind, updated.
// Khi khong co text: xep theo kind (rule > lesson > decision > fact > ref), roi updated moi nhat.

export const KIND_ORDER = Object.freeze({ rule: 0, lesson: 1, decision: 2, fact: 3, ref: 4 });

export const STOPWORDS = Object.freeze([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'have', 'has', 'are', 'was', 'not', 'you', 'your', 'can', 'please', 'what', 'how', 'why', 'when', 'where', 'which', 'will', 'should', 'would', 'could', 'all', 'any', 'one', 'out', 'use', 'make',
  'cho', 'cua', 'khong', 'nhung', 'trong', 'mot', 'cac', 'nay', 'kia', 'thi', 'duoc', 'lam', 'voi', 'nhu', 'roi', 'xem', 'hay', 'giup', 'minh', 'toi', 'ban', 'neu', 'sau', 'truoc', 'them', 'bang', 'theo', 'khi', 'can', 'phai', 'nao', 'gi', 'vao', 'ra', 'len', 'xuong', 'dang', 'con', 'nua', 'cung', 'viec', 'chay', 'sua',
]);

/** Bo dau tieng Viet + ha chu: "Đường dẫn" -> "duong dan". */
export const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase();

/** Tach token tu chuoi. */
export const tokens = (s) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);

/** Trich tu khoa tat dinh tu chuoi truy van. */
export function keywords(text, { minLen = 3, maxKeywords = 24, maxChars = 4000, stopwords = STOPWORDS } = {}) {
  const stop = new Set(stopwords || []);
  const out = [];
  for (const t of tokens(String(text || '').slice(0, maxChars))) {
    if (t.length < minLen || stop.has(t) || /^\d+$/.test(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= maxKeywords) break;
  }
  return out;
}

/** Cham diem 1 ghi chu vault theo tu khoa: id/tag/kind = 3, line/source = 1. */
export function scoreItem(item, kws) {
  if (!item || !kws || !kws.length) return 0;
  const itemTags = Array.isArray(item.tags) ? item.tags : (item.meta && Array.isArray(item.meta.tags) ? item.meta.tags : []);
  const strong = new Set([...tokens(item.id), ...itemTags.flatMap(tokens), item.kind]);
  const line = item.line || (item.meta && item.meta.quote) || '';
  const source = item.source || (item.meta && item.meta.source) || '';
  const weak = new Set([...tokens(line), ...tokens(source)]);
  let s = 0;
  for (const k of kws) s += strong.has(k) ? 3 : weak.has(k) ? 1 : 0;
  return s;
}

const itemTs = (item) => String(item.updated || (item.meta && item.meta.updated) || item.created || (item.meta && item.meta.created) || '');

/**
 * Xep hang danh sach ghi chu.
 * @param {Array} items Danh sach ghi chu
 * @param {Object} [opts] { text, kws, minScore = 2 }
 * @returns {Array} Danh sach da xep hang kem truong score (khi co text/kws)
 */
export function rankItems(items = [], opts = {}) {
  const list = [...items];
  const kws = opts.kws || (opts.text ? keywords(opts.text) : []);
  if (kws.length) {
    const minScore = typeof opts.minScore === 'number' ? opts.minScore : 2;
    const scored = [];
    for (const it of list) {
      const s = scoreItem(it, kws);
      if (s >= minScore) scored.push({ ...it, score: s });
    }
    scored.sort((a, b) => {
      // rule luon xep truoc
      if ((a.kind === 'rule') !== (b.kind === 'rule')) return a.kind === 'rule' ? -1 : 1;
      // diem cao truoc
      if (b.score !== a.score) return b.score - a.score;
      // thu tu kind: rule > lesson > decision > fact > ref
      const kA = KIND_ORDER[a.kind] ?? 9, kB = KIND_ORDER[b.kind] ?? 9;
      if (kA !== kB) return kA - kB;
      // updated moi nhat
      const tA = itemTs(a), tB = itemTs(b);
      if (tB !== tA) return tB > tA ? 1 : -1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return scored;
  }

  // Khong co text: xep theo kind (rule > lesson > decision > fact > ref), roi updated moi nhat
  list.sort((a, b) => {
    const kA = KIND_ORDER[a.kind] ?? 9, kB = KIND_ORDER[b.kind] ?? 9;
    if (kA !== kB) return kA - kB;
    const tA = itemTs(a), tB = itemTs(b);
    if (tB !== tA) return tB > tA ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return list;
}
