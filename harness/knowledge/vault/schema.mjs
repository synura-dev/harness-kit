// harness/knowledge/vault/schema.mjs - schema ghi chu vault (thuan, khong I/O): validate, quet secret, han recheck.
export const KINDS = Object.freeze(['rule', 'fact', 'ref', 'decision', 'lesson']);
const KIND_ALIASES = Object.freeze({ reference: 'ref', facts: 'fact', rules: 'rule' });
const CONFIDENCE =Object.freeze(['low', 'med', 'high']);
export const STATUS = Object.freeze(['active', 'stale', 'archived']);
/** Thu tu truong frontmatter khi ghi (on dinh, de diff). */
export const FIELDS = Object.freeze(['id', 'kind', 'scope', 'status', 'confidence', 'tags', 'links', 'refs', 'source', 'quote', 'fetched', 'recheck', 'probe', 'created', 'updated']);
export const LIMITS = Object.freeze({ idMax: 80, quoteMax: 200, sourceMax: 500, bodyMaxBytes: 32768, tagsMax: 20, linksMax: 50, refsMax: 50 });

/** Probe (frontmatter `probe: {"cmd":[argv],"expect":"<regex|substring>","timeoutS":N}`): chay lenh de doi chieu fact voi thuc te (knowledge check --probe). */
export const PROBE = Object.freeze({ cmdMax: 16, tokenMax: 100, expectMax: 200, timeoutDefaultS: 5, timeoutMaxS: 30, outputMax: 4096 });
/** Allowlist mac dinh: argv phai KHOP CHINH XAC mot muc (them muc qua config knowledge.probe.allow). */
export const DEFAULT_PROBE_ALLOW = Object.freeze(['node --version', 'git --version', 'claude --version', 'agy --version', 'bun --version', 'npm --version']);
const PROBE_TOKEN_RE = /^[A-Za-z0-9_.:=@/+-]{1,100}$/;
/** expect: `/re/flags` (flags i m s u) = regex, con lai = chuoi con. Tra {re}|{text}; nem Error neu regex sai. */
export function compileExpect(expect) {
  const s = String(expect);
  const m = s.match(/^\/(.+)\/([imsu]*)$/s);
  return m ? { re: new RegExp(m[1], m[2]) } : { text: s };
}
/** Validate probe; tra mang loi. allow = mang chuoi argv (mac dinh DEFAULT_PROBE_ALLOW). Thuan. */
export function validateProbe(p, allow = DEFAULT_PROBE_ALLOW) {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return ['probe phai la object {cmd, expect, timeoutS}'];
  const e = [];
  for (const k of Object.keys(p)) if (!['cmd', 'expect', 'timeoutS'].includes(k)) e.push(`probe: truong la ${k}`);
  if (!Array.isArray(p.cmd) || !p.cmd.length || p.cmd.length > PROBE.cmdMax || p.cmd.some((x) => typeof x !== 'string' || !PROBE_TOKEN_RE.test(x))) e.push('probe.cmd phai la mang argv (1..16 chuoi ky tu an toan, KHONG qua shell)');
  else if (!allow.some((a) => String(a).trim().split(/\s+/).join(' ') === p.cmd.join(' '))) e.push(`probe.cmd "${p.cmd.join(' ').slice(0, 60)}" khong nam trong allowlist (config knowledge.probe.allow)`);
  if (typeof p.expect !== 'string' || !p.expect || p.expect.length > PROBE.expectMax || /[\r\n]/.test(p.expect)) e.push(`probe.expect phai la chuoi 1 dong <= ${PROBE.expectMax} ky tu`);
  else { try { compileExpect(p.expect); } catch (x) { e.push(`probe.expect regex sai: ${x.message.slice(0, 60)}`); } }
  if (p.timeoutS !== undefined && !(typeof p.timeoutS === 'number' && p.timeoutS > 0 && p.timeoutS <= PROBE.timeoutMaxS)) e.push(`probe.timeoutS phai la so 0..${PROBE.timeoutMaxS}`);
  return e;
}

export const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TAG_RE = /^[a-z0-9][a-z0-9_/-]{0,59}$/;
export const REF_RE = /^project:[a-z0-9_-]+\/(notes|facts)\/[a-z0-9_.-]+$/;
const SCOPE_RE = /^(global|project:[a-z0-9][a-z0-9._-]{0,59}|role:[a-z0-9][a-z0-9_-]{0,59})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STAMP_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?)?$/;
// Heuristic "source web" (xem README): bat ky URL scheme (tru file://), tien to web:/url:/link:, www., host.tld/<path>,
// hoac ten mien tran voi TLD pho bien. Duong dan file cuc bo (docs/x.md, a/b.mjs) khong khop vi host phai o dau token.
const WEB_SOURCE_RES = [
  /\b(?!file:)[a-z][a-z0-9+.-]*:\/\//i,
  /(^|[\s(<"'[])(web|url|link)\s*:/i,
  /(^|[^a-z0-9.-])www\.[a-z0-9-]+\./i,
  /(^|[\s(<"'[=@])[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}(:\d{1,5})?\//i,
  /(^|[\s(<"'[=@])[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|org|net|io|dev|ai|co|gov|edu|app|vn|info|me|so|sh|xyz|tech|cloud)(:\d{1,5})?(?=$|[\s)>"',;\]])/i,
];
export const isWebSource = (s) => { const t = String(s || ''); return WEB_SOURCE_RES.some((re) => re.test(t)); };
export const normKind = (k) => { const s = String(k || '').trim().toLowerCase(); return KIND_ALIASES[s] || s; };

const validDate = (s, re = DATE_RE) => typeof s === 'string' && re.test(s) && !Number.isNaN(Date.parse(s.slice(0, 10) + 'T00:00:00Z'));

// Mau secret toi thieu (khong day du; muc tieu: chan nham lan pho bien).
const SECRET_PATTERNS = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['aws-key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['openai-anthropic-key', /\bsk-(ant-)?[A-Za-z0-9_-]{20,}/],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['telegram-bot-token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['url-credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/i],
  ['assignment', /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?[^\s"']{6,}/i],
];

/** Tra ten mau secret dau tien khop trong chuoi, hoac null. */
export function findSecret(text) {
  const s = String(text || '');
  for (const [name, re] of SECRET_PATTERNS) if (re.test(s)) return name;
  return null;
}

/**
 * Gom de quy moi gia tri vo huong trong meta (object/mang long nhau) thanh van ban de quet secret, moi la 1 dong "khoa: gia tri"
 * (de mau "password: X" bat ca khi secret nam o khoa long). Co tran: qua maxDepth -> JSON cua nhanh do (cat maxBranchChars); toi da maxLeaves dong.
 */
export function metaText(meta, { maxDepth = 6, maxLeaves = 2000, maxBranchChars = 65536 } = {}) {
  const out = [];
  const walk = (v, key, d) => {
    if (out.length >= maxLeaves || v === null || v === undefined) return;
    if (typeof v !== 'object') { if (typeof v !== 'function' && typeof v !== 'symbol') out.push(key ? `${key}: ${v}` : String(v)); return; }
    if (d >= maxDepth) { try { out.push(String(JSON.stringify(v)).slice(0, maxBranchChars)); } catch { /* vong lap: bo */ } return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, key, d + 1); return; }
    for (const [k, x] of Object.entries(v)) walk(x, k, d + 1);
  };
  walk(meta, '', 0);
  return out.join('\n');
}

/** Validate meta (+ body). Tra {errors:[], warnings:[]}. Thuan. */
export function validate(meta, body = '', opts = {}) {
  const e = [], w = [];
  const m = meta && typeof meta === 'object' ? meta : {};
  if (typeof m.id !== 'string' || !ID_RE.test(m.id) || m.id.length > LIMITS.idMax) e.push(`id phai kebab-case <= ${LIMITS.idMax} ky tu`);
  if (!KINDS.includes(m.kind)) e.push(`kind phai thuoc ${KINDS.join('|')}`);
  if (m.scope !== undefined && !(typeof m.scope === 'string' && SCOPE_RE.test(m.scope))) e.push('scope phai la global|project:<id>|role:<ten>');
  if (m.status !== undefined && !STATUS.includes(m.status)) e.push(`status phai thuoc ${STATUS.join('|')}`);
  if (m.confidence !== undefined && !CONFIDENCE.includes(m.confidence)) e.push(`confidence phai thuoc ${CONFIDENCE.join('|')}`);
  for (const k of ['tags', 'links']) {
    if (m[k] === undefined) continue;
    const max = k === 'tags' ? LIMITS.tagsMax : LIMITS.linksMax;
    if (!Array.isArray(m[k]) || m[k].length > max) { e.push(`${k} phai la mang <= ${max} muc`); continue; }
    const re = k === 'tags' ? TAG_RE : ID_RE;
    const bad = m[k].filter((x) => typeof x !== 'string' || !re.test(x));
    if (bad.length) e.push(`${k} khong hop le: ${bad.slice(0, 3).join(', ')}`);
  }
  if (m.refs !== undefined) {
    if (!Array.isArray(m.refs) || m.refs.length > LIMITS.refsMax) {
      e.push(`refs phai la mang <= ${LIMITS.refsMax} muc`);
    } else {
      const bad = m.refs.filter((x) => typeof x !== 'string' || !REF_RE.test(x));
      if (bad.length) e.push(`refs khong hop le: ${bad.slice(0, 3).join(', ')}`);
    }
  }
  if (m.source !== undefined && (typeof m.source !== 'string' || m.source.length > LIMITS.sourceMax || /[\r\n]/.test(m.source))) e.push(`source phai la 1 dong <= ${LIMITS.sourceMax} ky tu`);
  if (m.quote !== undefined && (typeof m.quote !== 'string' || m.quote.length > LIMITS.quoteMax || /[\r\n]/.test(m.quote))) e.push(`quote phai la 1 dong <= ${LIMITS.quoteMax} ky tu`);
  if (m.kind === 'rule' && isWebSource(m.source)) e.push('kind=rule khong duoc co source web (fact web khong thanh quy tac)');
  if (isWebSource(m.source) && !m.quote) e.push('source web can quote nguyen van ngan');
  if (m.probe !== undefined) e.push(...validateProbe(m.probe, opts.probeAllow));
  for (const k of ['recheck', 'created', 'updated']) if (m[k] !== undefined && !validDate(m[k])) e.push(`${k} phai la YYYY-MM-DD`);
  if (m.fetched !== undefined && !validDate(m.fetched, STAMP_RE)) e.push('fetched phai la YYYY-MM-DD[THH:MM[:SS]Z]');
  if (Buffer.byteLength(String(body || ''), 'utf8') > LIMITS.bodyMaxBytes) e.push(`body vuot ${LIMITS.bodyMaxBytes} bytes`);
  for (const k of Object.keys(m)) if (!FIELDS.includes(k)) w.push(`truong la: ${k}`);
  const sec = findSecret([metaText(m), body].join('\n'));
  if (sec) e.push(`nghi chua secret (${sec})`);
  return { errors: e, warnings: w };
}

/** Ngay YYYY-MM-DD + n ngay (UTC). */
export function addDays(date, n) {
  const d = new Date(String(date).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(n));
  return d.toISOString().slice(0, 10);
}
export const todayStr = (now) => (now ? String(now).slice(0, 10) : new Date().toISOString().slice(0, 10));
/** Het han: recheck < hom nay, hoac status=stale. */
export const isStale = (m, today) => m.status === 'stale' || (typeof m.recheck === 'string' && m.recheck < today);
/** Link trong body: [[id]] / [[id|alias]] / [[id#heading]]. */
export function bodyLinks(body) {
  const out = new Set();
  for (const x of String(body || '').matchAll(/\[\[([^\]|#\r\n]+)(?:[#|][^\]\r\n]*)?\]\]/g)) out.add(x[1].trim());
  return [...out];
}
