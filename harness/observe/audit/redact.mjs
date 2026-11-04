// Redaction helpers. Node built-ins only.
const warned = new Set();
export function compile(list) {
  const out = [];
  for (const s of list || []) {
    try { out.push(new RegExp(s, 'gi')); } catch (e) {
      // khong nuot im: canh bao stderr mot lan cho moi pattern hong
      if (!warned.has(s)) { warned.add(s); try { process.stderr.write(`audit redact: pattern hong bi bo qua: ${s} (${e.message})
`); } catch {} }
    }
  }
  return out;
}
export function redact(str, res) {
  let s = String(str ?? '');
  for (const re of res) {
    re.lastIndex = 0;
    // URL-with-query pattern keeps the base (group 1); others become ***
    s = s.replace(re, (m, g1) => (typeof g1 === 'string' && /^https?:/i.test(g1) && m.startsWith(g1) ? g1 : '***'));
  }
  return s;
}
export const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) : s; };
export function sanitizeSession(id, seed) {
  const s = String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  if (s) return s;
  // No usable id: stable fallback from seed (cli/cwd/pid/day) so unrelated sessions do not merge into one 'nosession' file.
  if (seed == null) return 'nosession';
  let h = 5381;
  for (const c of String(seed)) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return 'nosession-' + h.toString(36);
}
export function urlTarget(u) {
  try { const x = new URL(String(u)); return x.host + x.pathname; } catch { return null; }
}
export function pathTarget(p, sensitive) {
  p = String(p ?? '');
  const base = p.split(/[\\/]/).pop() || p;
  for (const re of sensitive || []) if (re.test(base)) return base;
  return cut(p, 200);
}
