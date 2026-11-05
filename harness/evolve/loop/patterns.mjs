// evolve patterns: do quy trinh lap (khong phai loi) tu audit. Chay theo lo, khong trong hook.
// Hop dong dau ra: {id, kind:'pattern', subkind, fp, count, sessions, first_ts, last_ts, sample, cost_ms} (cost_ms = trung binh/lan).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { normalizeMessage } from '../../core/audit/normalize-message.mjs';
import { collectJsonlFiles, readAuditEvents } from '../../core/audit/scan.mjs';
import { auditCtx, nestedDateDirs, LIMITS, redact } from './loop.mjs';

export const PATTERN_DEFAULTS = Object.freeze({
  days: 7, limit: 20, minCount: 10, minSessions: 3, seqMin: 3, seqMax: 5,
  maxOps: 200000, infoHead: 6, infoBeforeAgent: 3,
  promptMinCount: 3, promptMinSessions: 2, promptMinKw: 4, // prompt lap: ngat rieng (khong dung chung minCount/minSessions cua lenh)
});
// Danh sach bo qua/info la DU LIEU: luat repeated-pattern.json (ignore, info: chuoi regex). Ghi de bang <project>/.harness/rules/repeated-pattern.json.
export const compileRegexList = (a) => (Array.isArray(a) ? a : []).flatMap((s) => { try { return [new RegExp(String(s))]; } catch { return []; } });
const RULE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'observe', 'ledger', 'defaults', 'repeated-pattern.json');
let RULE = {}; try { RULE = JSON.parse(fs.readFileSync(RULE_FILE, 'utf8')); } catch { /* fail-open: khong ignore gi */ }
export const DEFAULT_IGNORE = Object.freeze(compileRegexList(RULE.ignore));
export const DEFAULT_INFO = Object.freeze(compileRegexList(RULE.info));
// Nguong prompt lap lay tu dinh nghia luat (prompt_min_count / prompt_min_sessions) neu co, khong thi PATTERN_DEFAULTS.
const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);
export const PROMPT_THRESHOLDS = Object.freeze({ count: posInt(RULE.prompt_min_count, 3), sessions: posInt(RULE.prompt_min_sessions, 2) });

const MULTI = { harness: 3, git: 2, bun: 2, npm: 2, node: 2, gh: 2, docker: 2, pnpm: 2, yarn: 2, npx: 2, bunx: 2 };
const SCRIPT_RUNNERS = new Set(['node', 'python', 'python3', 'bash', 'sh', 'powershell', 'pwsh']);
const REMOTE_CMDS = new Set(['push', 'pull', 'fetch']);
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);

/** Lenh dau (bo cd ... &&, timeout N, VAR=x). */
export function firstCommand(cmd) {
  let s = String(cmd ?? '').trim();
  for (let i = 0; i < 6; i++) {
    const before = s;
    s = s.replace(/^[({]\s*/, '').replace(/^cd\s+(?:\/d\s+)?(?:"[^"]*"|'[^']*'|[^\s&;|]+)\s*(?:&&|;)\s*/i, '')
      .replace(/^timeout\s+(?:-[\w=.]+\s+)*\d+[smhd]?\s+/i, '')
      .replace(/^(?:\w+=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '');
    if (s === before) break;
  }
  return s.split(/\s*(?:&&|\|\||;|\|)\s*/)[0].split(/\r?\n/)[0].trim();
}

/** Chu ky lenh Bash: 2-3 tu dau co nghia, bo doi so duong dan/id/so. */
export function bashSignature(cmd) {
  const first = firstCommand(cmd);
  if (!first) return null;
  const toks = first.split(/\s+/).map((t) => t.replace(/^["'`]|["'`]$/g, ''));
  const head = toks[0].replace(/\\/g, '/').split('/').pop().replace(/\.(exe|cmd|bat|mjs|js)$/i, '');
  if (!/^[a-z][\w.-]*$/.test(head) && !/^[A-Z][a-z]+-[A-Z]\w+$/.test(head)) return null; // khong phai lenh (vd. van ban heredoc)
  if (SCRIPT_RUNNERS.has(head)) {
    const sc = toks.slice(1).find((t) => t && !t.startsWith('-'));
    const bn = sc && sc.replace(/\\/g, '/').split('/').pop();
    if (bn && /^[\w.-]+\.(mjs|js|cjs|ts|py|ps1|sh)$/.test(bn)) return `Bash:${head} ${bn}`;
  }
  let max = MULTI[head] || 1;
  const words = [head];
  for (let i = 1; i < toks.length && words.length < max; i++) {
    const t = toks[i];
    if (!t) break;
    if (t.startsWith('-')) continue; // co: bo qua
    if (!/^[A-Za-z][\w:-]*$/.test(t) || normalizeMessage(t, 30) !== t) break; // duong dan/id/so -> dung
    words.push(t);
    if (head === 'git' && REMOTE_CMDS.has(t)) max = 3;
  }
  return `Bash:${words.join(' ')}`;
}

function extOf(p) {
  const m = String(p || '').match(/\.([A-Za-z0-9]{1,6})$/);
  return m ? m[1].toLowerCase() : null;
}

/** Chu ky thao tac tu su kien audit (envelope v2). null neu khong co tool. */
export function opSignature(ev) {
  const d = ev && ev.data && typeof ev.data === 'object' ? ev.data : {};
  const tool = ev && (ev.tool || d.tool);
  if (!tool) return null;
  if (tool === 'Bash') return bashSignature(ev.target || d.cmd_line || '');
  if (tool === 'Agent' || tool === 'Task') {
    const st = d.subagent_type || normalizeMessage(ev.target || '', 30);
    return `Agent:${st || '-'}`;
  }
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const e = extOf(ev.target);
    return `${tool}:${e ? '.' + e : ev.target_kind || 'file'}`;
  }
  return String(tool);
}

// Chuoi chi gom thao tac sua file (Edit/Write/Read...) hoac < 2 lenh Bash khac loai: khong co y nghia tu dong hoa.
const FILE_OP = /^(Read|Edit|Write|MultiEdit|NotebookEdit)(:|$)/;
export const meaningfulSequence = (sigs) => !sigs.every((x) => FILE_OP.test(x)) && new Set(sigs.filter((x) => x.startsWith('Bash:'))).size >= 2;

export const isIgnored = (sig, ignore = DEFAULT_IGNORE) => ignore.some((r) => r.test(sig));

// Luong thao tac theo (sid, actor, agent_id), sap theo thoi gian. Chi PostToolUse (co dur_ms), tranh dem doi Pre/Post.
function buildStreams(events, o) {
  const streams = new Map();
  let n = 0;
  for (const ev of events) {
    if (ev.event !== 'PostToolUse') continue;
    const sig = opSignature(ev);
    if (!sig) continue;
    if (++n > o.maxOps) break;
    const sid = ev.sid || ev.session_id || '-';
    const key = [sid, ev.actor || 'main', ev.agent_id || ''].join('|');
    if (!streams.has(key)) streams.set(key, { sid, ops: [] });
    streams.get(key).ops.push({ sig, ts: String(ev.ts || ''), ms: Number.isFinite(ev.dur_ms) ? ev.dur_ms : 0 });
  }
  for (const s of streams.values()) s.ops.sort((a, b) => a.ts.localeCompare(b.ts));
  return [...streams.values()];
}

function mk(subkind, key, sample, acc) {
  const fp = hash(`${subkind}|${key}`);
  return {
    id: `pat_${subkind}_${fp}`, kind: 'pattern', subkind, fp, count: acc.count, sessions: acc.sids.size,
    first_ts: acc.first || null, last_ts: acc.last || null, sample: redact(sample),
    cost_ms: acc.count ? Math.round(acc.ms / acc.count) : 0,
  };
}
const newAcc = () => ({ count: 0, sids: new Set(), ms: 0, first: null, last: null });
function bump(acc, sid, op, ms = op.ms) {
  acc.count++; acc.sids.add(sid); acc.ms += ms;
  if (!acc.first || op.ts < acc.first) acc.first = op.ts;
  if (!acc.last || op.ts > acc.last) acc.last = op.ts;
}

export function detectCommands(streams, o) {
  const m = new Map();
  for (const s of streams) for (const op of s.ops) {
    if (isIgnored(op.sig, o.ignore)) continue;
    if (!m.has(op.sig)) m.set(op.sig, newAcc());
    bump(m.get(op.sig), s.sid, op);
  }
  return [...m].filter(([, a]) => a.count >= o.minCount && a.sids.size >= o.minSessions).map(([sig, a]) => mk('command', sig, sig, a));
}

const isSub = (a, b) => { // a la chuoi con lien tiep cua b
  for (let i = 0; i + a.length <= b.length; i++) if (a.every((x, j) => x === b[i + j])) return true;
  return false;
};

export function detectSequences(streams, o) {
  const m = new Map();
  for (const s of streams) {
    const ops = s.ops.filter((x) => !isIgnored(x.sig, o.ignore));
    for (let n = o.seqMin; n <= o.seqMax; n++) {
      const seen = new Set(); // moi phien dem 1 lan / n-gram
      for (let i = 0; i + n <= ops.length; i++) {
        const g = ops.slice(i, i + n);
        if (!meaningfulSequence(g.map((x) => x.sig))) continue; // 1 tool don/tool+duoi file/chi Edit-Write: khong bao cao
        const key = g.map((x) => x.sig).join(' > ');
        if (seen.has(key)) continue;
        seen.add(key);
        if (!m.has(key)) m.set(key, newAcc());
        bump(m.get(key), s.sid, g[0], g.reduce((t, x) => t + x.ms, 0));
      }
    }
  }
  const arr = [...m].filter(([, a]) => a.sids.size >= o.minSessions).map(([k, a]) => ({ k, a, parts: k.split(' > ') }));
  return arr.filter((x) => !arr.some((y) => y !== x && y.parts.length > x.parts.length && y.a.count === x.a.count && isSub(x.parts, y.parts)))
    .map((x) => mk('sequence', x.k, x.k, x.a));
}

export function detectInfoFetch(streams, o) {
  const info = o.info || DEFAULT_INFO;
  const m = new Map();
  for (const s of streams) {
    const hit = new Map(); // sig -> op (moi phien 1 lan / sig)
    s.ops.forEach((op, i) => {
      if (!info.some((r) => r.test(op.sig))) return;
      const early = i < o.infoHead;
      const beforeAgent = s.ops.slice(i + 1, i + 1 + o.infoBeforeAgent).some((x) => x.sig.startsWith('Agent:'));
      if ((early || beforeAgent) && !hit.has(op.sig)) hit.set(op.sig, op);
    });
    for (const [sig, op] of hit) {
      if (!m.has(sig)) m.set(sig, newAcc());
      bump(m.get(sig), s.sid, op);
    }
  }
  return [...m].filter(([, a]) => a.sids.size >= o.minSessions).map(([sig, a]) => mk('info_fetch', sig, `${sig} (dau phien/truoc Agent) -> inject`, a));
}

// Yeu cau lap: chi khi UserPromptSubmit co hash prompt. Chua co -> skipped.
export function detectPrompts(events, o) {
  const hashOf = (ev) => { const d = ev.data || {}; return d.prompt_hash || d.prompt_fp || ev.prompt_hash || null; };
  const ups = events.filter((e) => e.event === 'UserPromptSubmit');
  const kwLen = (ev) => { const k = (ev.data || {}).prompt_kw; return Array.isArray(k) ? k.length : null; };
  // prompt qua ngan (<= 3 tu khoa, vd. "ok tiep di") khong phai yeu cau lap co nghia; thieu prompt_kw -> khong biet, giu.
  const minKw = o.promptMinKw ?? PATTERN_DEFAULTS.promptMinKw;
  const withHash = ups.filter((e) => hashOf(e) && (kwLen(e) == null || kwLen(e) >= minKw));
  if (!withHash.length) return { items: [], skipped: ups.length ? 'chua co field prompt_hash trong UserPromptSubmit' : 'khong co su kien UserPromptSubmit' };
  const m = new Map();
  for (const ev of withHash) {
    const h = String(hashOf(ev));
    if (!m.has(h)) m.set(h, newAcc());
    bump(m.get(h), ev.sid || '-', { ts: String(ev.ts || ''), ms: 0 });
  }
  const minCount = o.promptMinCount ?? PROMPT_THRESHOLDS.count, minSess = o.promptMinSessions ?? PROMPT_THRESHOLDS.sessions;
  return { items: [...m].filter(([, a]) => a.count >= minCount && a.sids.size >= minSess).map(([h, a]) => mk('prompt', h, `prompt_hash=${h}`, a)), skipped: null };
}

export const rank = (items) => items.slice().sort((a, b) => (b.count * Math.max(b.cost_ms, 1)) - (a.count * Math.max(a.cost_ms, 1)) || b.count - a.count);

/** Thuan: mang su kien -> {items, skipped:{prompt}}. */
export function detectPatterns(events, opts = {}) {
  const clean = Object.fromEntries(Object.entries(opts).filter(([, v]) => v != null));
  const o = { ...PATTERN_DEFAULTS, promptMinCount: PROMPT_THRESHOLDS.count, promptMinSessions: PROMPT_THRESHOLDS.sessions, ignore: DEFAULT_IGNORE, info: DEFAULT_INFO, ...clean };
  const streams = buildStreams(events, o);
  const p = detectPrompts(events, o);
  // detectCommands van export (dung le) nhung khong dua vao ledger: lenh don khong phai mau tu dong hoa.
  const items = [...detectSequences(streams, o), ...detectInfoFetch(streams, o), ...p.items];
  return { items: rank(items), skipped: { prompt: p.skipped } };
}

/** Doc audit (tran byte + timeout nhu findCandidates), roi do. */
export async function findPatterns(o = {}) {
  const c = auditCtx(o);
  const days = o.days > 0 ? o.days : PATTERN_DEFAULTS.days;
  const nowMs = Number(o.nowMs) || Date.now();
  const DAY = 86400000, fromMs = nowMs - days * DAY;
  const fromDate = new Date(fromMs).toISOString().slice(0, 10);
  const deadline = Date.now() + (o.timeoutMs > 0 ? o.timeoutMs : LIMITS.scanTimeoutMs);
  const maxBytes = o.maxBytes > 0 ? o.maxBytes : LIMITS.scanMaxBytes;
  let used = 0, truncated = null, scanned = 0;
  const events = [];
  for (const { date, dir } of c.audits.flatMap(nestedDateDirs)) {
    if (date < fromDate) continue;
    if (Date.now() > deadline) { truncated = 'timeout'; break; }
    let size = 0;
    for (const f of collectJsonlFiles(dir)) { try { size += fs.statSync(f).size; } catch {} }
    if (used + size > maxBytes) { truncated = 'max_bytes'; break; }
    used += size;
    const r = await readAuditEvents(dir, size + 1, deadline);
    scanned += r.scannedEvents;
    for (const ev of r.events) {
      if (ev.event !== 'PostToolUse' && ev.event !== 'UserPromptSubmit') continue;
      const t = Date.parse(ev.ts);
      if (Number.isFinite(t) && (t < fromMs || t > nowMs + DAY)) continue;
      events.push(ev);
    }
    if (r.truncated) { truncated = r.truncated; break; }
  }
  const r = detectPatterns(events, { minCount: o.threshold, minSessions: o.sessions });
  return { items: r.items, total: r.items.length, scanned, days, skipped: r.skipped, truncated };
}
