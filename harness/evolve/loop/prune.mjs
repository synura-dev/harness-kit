// Giu harness gon: kiem ke thanh phan tat dinh + muc dung 30 ngay tu audit -> ung vien 'deprecate' (pending -> propose_remove) va 'cap' (vuot tran).
// Chi doc (tru ghi prune-state.json khi --record). Khong xoa gi. Co timeout + tran byte, bao truncated.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { collectJsonlFiles } from '../../core/audit/scan.mjs';
import { countEvents, filterMaintenance } from '../usage/collect.mjs';
import { readTranscripts } from '../usage/transcripts.mjs';
import { detectAudit, detectTranscript } from '../usage/detectors/index.mjs';
import { parseFrontmatter } from '../../core/agy/agents.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..', '..');
const DAY = 86400000;
export const PRUNE = Object.freeze({
  days: 30, waitDays: 14, timeoutMs: 20000, maxBytes: 256 * 1048576,
  caps: Object.freeze({ rule: 25, skill: 20, hook: 15, command: 60, agent: 8 }),
});
// loai khong do duoc muc dung -> khong de xuat deprecate (chi xet tran)
const NO_DEPRECATE = new Set(['rule', 'hook']);

const lsDirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };
const lsFiles = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name); } catch { return []; } };
const sha8 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** "a | b <x> | c [--f]" hoac mang ["a","eval run|list"] -> ten lenh dau tien moi nhom ("eval run|list" -> "eval"). */
export function cmdNames(spec) {
  const items = Array.isArray(spec) ? spec : [String(spec || '')];
  const out = [];
  for (const raw of items) {
    const segs = String(raw).replace(/\[[^\]]*\]|<[^>]*>|\([^)]*\)/g, ' ').split(/[|;]/).map((s) => s.trim().split(/\s+/).filter((w) => /^[a-z][\w-]*$/i.test(w)));
    if (!segs.length || !segs[0].length) continue;
    if (segs[0].length > 1 && Array.isArray(spec)) { out.push(segs[0][0]); continue; } // "eval run|list|..." -> eval
    for (const s of segs) if (s[0]) out.push(s[0]);
  }
  return [...new Set(out.map((s) => s.replace(/[,;]$/, '')))];
}

function walkManifests(dir, out, depth = 0) {
  if (depth > 4 || out.length > 200) return;
  for (const f of lsFiles(dir)) if (f === 'manifest.json') out.push(path.join(dir, f));
  for (const d of lsDirs(dir)) if (d !== 'node_modules' && !d.startsWith('.')) walkManifests(path.join(dir, d), out, depth + 1);
}

/** Lenh CLI `<domain>.<cmd>` tu manifest (domain+cmds, domains{}); extRoots: thu muc manifest ngoai. */
export function inventoryCommands({ pluginRoot = PLUGIN_ROOT, extRoots = [] } = {}) {
  const files = [];
  walkManifests(path.join(pluginRoot, 'harness'), files);
  for (const r of extRoots) walkManifests(r, files);
  const set = new Map();
  const add = (domain, cmd) => { if (domain && cmd) set.set(`${domain}.${cmd}`, { type: 'command', name: `${domain}.${cmd}`, domain, cmd }); };
  for (const f of files) {
    let m; try { m = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (m.kind === 'cli' && m.domain) for (const c of cmdNames(m.cmds)) add(m.domain, c);
    for (const [dom, d] of Object.entries(m.domains || {})) for (const c of cmdNames(d && d.cmds)) add(dom, c);
  }
  return [...set.values()];
}

/** Hook module duy nhat tu ORDER cua dispatcher. */
export async function inventoryHooks({ order } = {}) {
  let ord = order;
  if (!ord) { try { ord = (await import('../../hooks/dispatch/modules.mjs')).ORDER; } catch { ord = {}; } }
  const m = new Map();
  for (const [ev, list] of Object.entries(ord)) for (const e of list) {
    const x = m.get(e.id) || { type: 'hook', name: e.id, events: [], gate: !!e.gate };
    x.events.push(ev); m.set(e.id, x);
  }
  return [...m.values()];
}

export function inventorySkills({ pluginRoot = PLUGIN_ROOT, projectDir = '' } = {}) {
  const out = new Map();
  for (const root of [path.join(pluginRoot, 'skills'), projectDir && path.join(projectDir, '.claude', 'skills')].filter(Boolean)) {
    for (const d of lsDirs(root)) out.set(d, { type: 'skill', name: d });
  }
  return [...out.values()];
}

export function inventoryAgents({ projectDir = '' } = {}) {
  if (!projectDir) return [];
  return lsFiles(path.join(projectDir, '.claude', 'agents')).filter((f) => f.endsWith('.md')).map((f) => ({ type: 'agent', name: f.slice(0, -3) }));
}

export function inventoryRules({ projectDir = '' } = {}) {
  if (!projectDir) return [];
  let t = ''; try { t = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8'); } catch { return []; }
  const lines = t.split(/\r?\n/);
  const i = lines.findIndex((l) => /^##\s+Learned rules\b/i.test(l));
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (/^#{1,6}\s/.test(lines[j])) break;
    const m = /^\s*[-*]\s+(.+)$/.exec(lines[j]);
    if (m) out.push({ type: 'rule', name: sha8(m[1].trim()), text: m[1].trim() });
  }
  return out;
}

const dateOfPath = (f) => { const m = /date=(\d{4}-\d{2}-\d{2})/.exec(f.replace(/\\/g, '/')); return m ? m[1] : null; };
const MARK = ['"Skill"', '"Agent"', '"Task"', 'HookRun', 'harness ', '"agent_id"'];

/** Doc audit trong cua so (moi file; tran byte + timeout). Tra {events, scanned, bytes, truncated}. */
export async function readUsageEvents({ auditDirs, fromMs, nowMs = Date.now(), timeoutMs = PRUNE.timeoutMs, maxBytes = PRUNE.maxBytes }) {
  const fromDate = isoDay(fromMs);
  const deadline = Date.now() + timeoutMs;
  const events = []; let scanned = 0, bytes = 0, truncated = null, earliest_ts = null; // earliest_ts: truoc loc ts (do do phu cua so)
  outer: for (const root of auditDirs) {
    const files = collectJsonlFiles(root).filter((f) => { const d = dateOfPath(f); return !d || d >= fromDate; });
    for (const f of files) {
      let sz = 0; try { sz = fs.statSync(f).size; } catch { continue; }
      if (bytes + sz > maxBytes) { truncated = 'max_bytes'; break outer; }
      bytes += sz;
      const gw = /[\\/]gateway[\\/]/.test(f);
      const rl = createInterface({ input: fs.createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
      let n = 0;
      for await (const line of rl) {
        if ((++n & 1023) === 0 && Date.now() > deadline) { truncated = 'timeout'; rl.close(); break outer; }
        if (!line) continue;
        if (!gw && !MARK.some((k) => line.includes(k))) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        scanned++;
        const ts = Date.parse(e.ts);
        if (ts <= nowMs + DAY && (!earliest_ts || ts < Date.parse(earliest_ts))) earliest_ts = e.ts;
        if (!(ts >= fromMs && ts <= nowMs + DAY)) continue;
        events.push(gw ? { gw: true, ts: e.ts, sid: e.session, domain: e.domain, cmd: e.cmd } : e);
      }
    }
  }
  return { events, scanned, bytes, truncated, earliest_ts };
}

/** Su kien audit (qua detector adapters) + so lieu nguon. opts.auditSkill=false: bo Skill audit thieu tool_use_id (da lay tu transcript). */
export function auditEvents(events, inv, opts = {}) {
  const doms = new Map();
  for (const c of inv.commands) { if (!doms.has(c.domain)) doms.set(c.domain, new Set()); doms.get(c.domain).add(c.cmd); }
  const gwFirst = events.reduce((a, e) => (e.gw && (!a || e.ts < a) ? e.ts : a), null);
  const stats = { hookrun_events: 0, hookrun_since: null };
  const ctx = { doms, gwFirst, seenAgents: new Set(), auditSkill: opts.auditSkill, stats };
  return { events: events.flatMap((e) => detectAudit(e, ctx)), gwFirst, stats };
}

/** Events -> {usage:{kind:{m:Map,get}}}. Skill join theo `short` (id cuoi); agent = max(PreToolUse, su kien subagent), khong cong don. */
export function usageFrom(events, { gwFirst = null, stats = {}, maintenanceReads } = {}) {
  const fm = filterMaintenance(events.map((e) => (e.kind === 'skill' ? { ...e, id: e.short || String(e.id).split(':').pop() } : e)), { threshold: maintenanceReads });
  const c = countEvents(fm.kept);
  const cost = new Map();
  for (const e of fm.kept) if (e.cost) cost.set(`${e.kind}:${e.id}`, (cost.get(`${e.kind}:${e.id}`) || 0) + e.cost);
  const u = { command: new Map(), hook: new Map(), skill: new Map(), agent: new Map() };
  const sub = new Map();
  const src = { command_gateway: 0, command_bash_fallback: 0, gateway_since: gwFirst, hookrun_events: stats.hookrun_events || 0, hookrun_since: stats.hookrun_since || null };
  for (const [key, it] of c.items) {
    const i = key.indexOf(':'); const kind = key.slice(0, i), id = key.slice(i + 1);
    const x = { ...it, first: it.first_ts, last: it.last_ts, cost: cost.get(key) || 0 };
    if (kind === 'agentsub') sub.set(id, x); else if (u[kind]) u[kind].set(id, x);
    if (kind === 'command') { src.command_gateway += it.channels.gateway || 0; src.command_bash_fallback += it.channels.bash || 0; }
  }
  for (const [id, x] of sub) { const cur = u.agent.get(id); if (!cur || cur.count < x.count) u.agent.set(id, x); }
  const usage = {}; for (const [k, m] of Object.entries(u)) usage[k] = { m, get: (id) => m.get(id) };
  return { usage, sources: src, duplicates_dropped: c.duplicates_dropped, maintenance_dropped: fm.maintenance_dropped };
}

/** Dem muc dung tu audit (chu ky cu). Lenh: gateway log; truoc ngay gateway dau tien -> fallback Bash `harness <domain> <cmd>`. */
export function countUsage(events, inv, opts = {}) {
  const a = auditEvents(events, inv, opts);
  const r = usageFrom(a.events, { gwFirst: a.gwFirst, stats: a.stats, maintenanceReads: opts.maintenanceReads });
  return { usage: r.usage, sources: r.sources };
}

/**
 * Hop nhat -> items {id,kind,fp,count,sessions,first_ts,last_ts,sample,cost_ms,+status,pending_since,propose_after}.
 * state: {[id]:{pending_since}}. 0 dung -> pending (kem ngay); con 0 sau waitDays -> propose_remove.
 */
export function buildCandidates({ inv, usage, state = {}, caps = {}, nowMs = Date.now(), days = PRUNE.days, waitDays = PRUNE.waitDays, skipDeprecate = false, window }) {
  const cp = { ...PRUNE.caps, ...caps };
  const items = [], counts = {}, nextState = {}, unevaluated = [];
  const groups = { command: inv.commands, hook: inv.hooks, skill: inv.skills, agent: inv.agents, rule: inv.rules };
  for (const [type, list] of Object.entries(groups)) {
    counts[type] = { total: list.length, cap: cp[type] };
    if (list.length > cp[type]) {
      items.push({ id: `cap:${type}`, kind: 'cap', fp: `cap:${type}`, count: list.length, sessions: 0, first_ts: null, last_ts: null, sample: `${type}: ${list.length} > tran ${cp[type]}`, cost_ms: 0, status: 'over_cap' });
    }
    if (NO_DEPRECATE.has(type)) {
      if (list.length) unevaluated.push(type === 'rule' ? 'learned rules: khong do duoc muc dung (chi xet tran)' : 'hook: tool-event chi ghi khi cham/loi, chua co du lieu gate/decision du dai -> khong de xuat bo (chi xet tran)');
      continue;
    }
    if (skipDeprecate) { if (list.length) unevaluated.push(`${type}: bo qua deprecate (quet khong tron ven)`); continue; }
    for (const c of list) {
      const x = usage[type].get(c.name);
      if (x && x.count > 0) continue;
      const id = `${type}:${c.name}`;
      // cua so trung thuc: nguon cua loai nay chua phu du `days` (+1 ngay) -> khong bat dong ho pending, khong de xuat bo
      const w = window && window[type];
      if (w && !(w.earliest && Date.parse(w.earliest) <= nowMs - days * DAY + DAY)) {
        const wd = w.earliest ? Math.floor((nowMs - Date.parse(w.earliest)) / DAY) : 0;
        items.push({ id, kind: 'deprecate', fp: id, count: 0, sessions: 0, first_ts: null, last_ts: null, sample: `${type} ${c.name}: du lieu chi ${wd} ngay < ${days}`, cost_ms: 0, status: 'insufficient_window', window_days: wd });
        continue;
      }
      const since = (state[id] && state[id].pending_since) || isoDay(nowMs);
      const status = nowMs >= Date.parse(since) + waitDays * DAY ? 'propose_remove' : 'pending';
      nextState[id] = { pending_since: since };
      items.push({ id, kind: 'deprecate', fp: id, count: 0, sessions: 0, first_ts: null, last_ts: null, sample: `${type} ${c.name}: 0 lan dung / ${days} ngay`, cost_ms: 0, status, pending_since: since, propose_after: isoDay(Date.parse(since) + waitDays * DAY) });
    }
  }
  return { items, counts, unevaluated, state: nextState };
}

export const readState = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
export function writeState(file, st) { // atomic: ghi tmp roi rename
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(t, JSON.stringify(st, null, 2) + '\n', 'utf8');
  fs.renameSync(t, file);
}

// skills: cua dinh nghia agent (`skills: [a, b]` hoac danh sach `- a`) -> {agent: [skill]}
export function agentSkills({ projectDir = '' } = {}) {
  const out = {};
  if (!projectDir) return out;
  const dir = path.join(projectDir, '.claude', 'agents');
  for (const f of lsFiles(dir).filter((n) => n.endsWith('.md'))) {
    let t; try { t = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const p = parseFrontmatter(t); if (!p) continue;
    let list = String(p.data.skills || '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!list.length) { const m = /^skills:[ \t]*\r?\n((?:[ \t]*-[^\r\n]*\r?\n?)+)/m.exec(p.fm + '\n'); if (m) list = m[1].split(/\r?\n/).map((l) => l.replace(/^[ \t]*-\s*/, '').replace(/^["']|["']$/g, '').trim()).filter(Boolean); }
    if (list.length) out[f.slice(0, -3)] = list;
  }
  return out;
}

/** Mac dinh cho CLI/job: doc transcript that, cache nam trong thu muc data evolve (canh prune-state.json, khong trong repo), cua so trung thuc bat. */
export const wireDefaults = (evoDir) => ({ transcriptRoots: [path.join(os.homedir(), '.claude', 'projects')], transcriptCache: path.join(evoDir, 'transcripts-cache.jsonl'), gateWindow: true });

const daysSince = (iso, nowMs) => (iso ? Math.max(0, Math.floor((nowMs - Date.parse(iso)) / DAY)) : null);

/**
 * Diem vao. o: {auditDirs, projectDir, pluginRoot, extRoots, days, caps, nowMs, timeoutMs, maxBytes, state, order, waitDays,
 * transcriptRoots (khong co -> khong doc transcript), transcriptCache, transcriptLimits, gateWindow}.
 * Skill: neu doc transcript thi CHI lay tu transcript (+ audit Skill co tool_use_id -> trung callId, dem 1 lan); audit Skill thieu id bi bo.
 */
export async function pruneCandidates(o = {}) {
  const nowMs = Number(o.nowMs) || Date.now();
  const days = o.days > 0 ? o.days : PRUNE.days;
  const fromMs = nowMs - days * DAY;
  const inv = { commands: inventoryCommands(o), hooks: await inventoryHooks(o), skills: inventorySkills(o), agents: inventoryAgents(o), rules: inventoryRules(o) };
  const r = await readUsageEvents({ auditDirs: o.auditDirs || [], fromMs, nowMs, timeoutMs: o.timeoutMs, maxBytes: o.maxBytes });
  const useTr = Array.isArray(o.transcriptRoots) && o.transcriptRoots.length > 0;
  const tr = useTr ? await readTranscripts({ roots: o.transcriptRoots, fromMs, nowMs, cacheFile: o.transcriptCache || null, limits: o.transcriptLimits || {} }) : null;
  const a = auditEvents(r.events, inv, { auditSkill: !useTr });
  let trEvents = [], sessions = new Set();
  if (tr) {
    // reader chi loc theo mtime file -> loc lai theo ts record (earliest_ts do truoc loc)
    const recs = tr.records.filter((x) => Date.parse(x.ts) >= fromMs);
    const ctx = { skillNames: new Set(inv.skills.map((s) => s.name)), agentSkills: agentSkills(o) };
    trEvents = recs.flatMap((x) => detectTranscript(x, ctx));
    for (const x of recs) if (x.session) sessions.add(x.session);
  } else for (const e of r.events) if (e.sid) sessions.add(e.sid);
  const u = usageFrom([...a.events, ...trEvents], { gwFirst: a.gwFirst, stats: a.stats, maintenanceReads: o.maintenanceReads });
  const { usage } = u;
  const trunc = r.truncated || (tr && tr.truncated) || null;
  const src = { ...u.sources, audit: { earliest: r.earliest_ts, window_days: daysSince(r.earliest_ts, nowMs) } };
  if (tr) src.transcript = { earliest: tr.earliest_ts, window_days: daysSince(tr.earliest_ts, nowMs), files: tr.files_read, cache_hits: tr.cache_hits, truncated: tr.truncated };
  const skillE = tr ? tr.earliest_ts : r.earliest_ts;
  const window = o.gateWindow ? { skill: { earliest: skillE }, agent: { earliest: r.earliest_ts }, command: { earliest: r.earliest_ts }, hook: { earliest: src.hookrun_since } } : undefined;
  const b = buildCandidates({ inv, usage, state: o.state || {}, caps: o.caps, nowMs, days, waitDays: o.waitDays, skipDeprecate: !!trunc, window });
  const used = {}, usage_counts = {};
  for (const t of Object.keys(usage)) { used[t] = usage[t].m.size; usage_counts[t] = Object.fromEntries([...usage[t].m].map(([k, x]) => [k, x.count])); }
  // total_sessions: phien phan biet trong cua so (transcript neu co, khong thi audit) - mau so cho cost theo phien
  return { days, scanned: r.scanned, truncated: trunc, sources: src, used, usage_counts, duplicates_dropped: u.duplicates_dropped, maintenance_dropped: u.maintenance_dropped, total_sessions: sessions.size, ...b };
}
