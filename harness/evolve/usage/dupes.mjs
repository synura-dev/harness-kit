// Phát hiện mô tả trùng nhau (Jaccard trên tập token) trong cùng kind.
const STOP = new Set('the a an and or to of for use when dung khi va cho cua the'.split(' '));

const tokens = (s) => new Set(
  String(s ?? '').toLowerCase().replace(/đ/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)),
);

export function findDupes(items, { threshold = 0.7, top = 10, maxItems = 200 } = {}) {
  const truncated = items.length > maxItems ? 'max_items' : null;
  const list = items.slice(0, maxItems).map((i) => ({ ...i, t: tokens(i.description) }));
  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const x = list[i], y = list[j];
      if (x.kind !== y.kind || !x.t.size || !y.t.size) continue;
      let inter = 0;
      for (const w of x.t) if (y.t.has(w)) inter++;
      const score = inter / (x.t.size + y.t.size - inter);
      if (score >= threshold) pairs.push({ a: x.id, b: y.id, score });
    }
  }
  pairs.sort((p, q) => q.score - p.score);
  return { pairs: pairs.slice(0, top), truncated };
}
