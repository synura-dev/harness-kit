// Giu harness gon: kiem ke thanh phan tat dinh + muc dung 30 ngay tu audit -> ung vien 'deprecate' (pending -> propose_remove) va 'cap' (vuot tran).
// Chi doc (tru ghi prune-state.json khi --record). Khong xoa gi. Co timeout + tran byte, bao truncated.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { collectJsonlFiles } from '../../core/audit/scan.mjs';

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
  const events = []; let scanned = 0, bytes = 0, truncated = null;
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
        if (!(ts >= fromMs && ts <= nowMs + DAY)) continue;
        events.push(gw ? { gw: true, ts: e.ts, sid: e.session, domain: e.domain, cmd: e.cmd } : e);
      }
    }
  }
  return { events, scanned, bytes, truncated };
}

const HARNESS_RE = /(?:^|[\s;&|(])harness\s+([a-z][\w-]*)(?:\s+([a-z][\w-]*))?/;
class Acc {
  constructor() { this.m = new Map(); }
  hit(id, e, cost = 0) {
    const x = this.m.get(id) || { count: 0, sids: new Set(), first: null, last: null, cost: 0 };
    x.count++; if (e.sid) x.sids.add(e.sid); x.cost += cost;
    if (!x.first || e.ts < x.first) x.first = e.ts;
    if (!x.last || e.ts > x.last) x.last = e.ts;
    this.m.set(id, x);
  }
  get(id) { return this.m.get(id); }
}

/** Dem muc dung. Lenh: gateway log; truoc ngay gateway co dau tien -> fallback Bash target `harness <domain> <cmd>`. */
export function countUsage(events, inv) {
  const doms = new Map();
  for (const c of inv.commands) { if (!doms.has(c.domain)) doms.set(c.domain, new Set()); doms.get(c.domain).add(c.cmd); }
  const u = { command: new Acc(), hook: new Acc(), skill: new Acc(), agent: new Acc() };
  const gwFirst = events.reduce((a, e) => (e.gw && (!a || e.ts < a) ? e.ts : a), null);
  const src = { command_gateway: 0, command_bash_fallback: 0, gateway_since: gwFirst, hookrun_events: 0, hookrun_since: null };
  const seen = new Set();
  for (const e of events) {
    if (e.gw) { if (e.domain && e.cmd) { u.command.hit(`${e.domain}.${e.cmd}`, e); src.command_gateway++; } continue; }
    if (e.event === 'HookRun') {
      src.hookrun_events++; if (!src.hookrun_since || e.ts < src.hookrun_since) src.hookrun_since = e.ts;
      for (const m of (e.data && e.data.modules) || []) if (m && m.id) u.hook.hit(m.id, e, Number(m.ms) || 0);
      continue;
    }
    const d = e.data && typeof e.data === 'object' ? e.data : {};
    if (e.tool === 'Skill' && e.event === 'PreToolUse') {
      const n = String(d.skill || e.target || '').split(':').pop().trim().split(/\s+/)[0];
      if (n) u.skill.hit(n, e);
    }
    if ((e.tool === 'Agent' || e.tool === 'Task') && e.event === 'PreToolUse') {
      const n = String(d.subagent_type || e.target || '').trim().split(/\s+/)[0];
      if (n) u.agent.hit(n, e);
    }
    if (e.agent_type && e.agent_id && !seen.has(e.agent_id)) { seen.add(e.agent_id); u.agent.hit(e.agent_type, e); }
    if (e.tool === 'Bash' && e.event === 'PreToolUse' && (!gwFirst || e.ts < gwFirst)) {
      const m = HARNESS_RE.exec(String(d.cmd_line || e.target || ''));
      if (m && doms.has(m[1]) && m[2] && doms.get(m[1]).has(m[2])) { u.command.hit(`${m[1]}.${m[2]}`, e); src.command_bash_fallback++; }
    }
  }
  return { usage: u, sources: src };
}

/**
 * Hop nhat -> items {id,kind,fp,count,sessions,first_ts,last_ts,sample,cost_ms,+status,pending_since,propose_after}.
 * state: {[id]:{pending_since}}. 0 dung -> pending (kem ngay); con 0 sau waitDays -> propose_remove.
 */
export function buildCandidates({ inv, usage, state = {}, caps = {}, nowMs = Date.now(), days = PRUNE.days, waitDays = PRUNE.waitDays, skipDeprecate = false }) {
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
      const since = (state[id] && state[id].pending_since) || isoDay(nowMs);
      const status = nowMs >= Date.parse(since) + waitDays * DAY ? 'propose_remove' : 'pending';
      nextState[id] = { pending_since: since };
      items.push({ id, kind: 'deprecate', fp: id, count: 0, sessions: 0, first_ts: null, last_ts: null, sample: `${type} ${c.name}: 0 lan dung / ${days} ngay`, cost_ms: 0, status, pending_since: since, propose_after: isoDay(Date.parse(since) + waitDays * DAY) });
    }
  }
  return { items, counts, unevaluated, state: nextState };
}

export const readState = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
export function writeState(file, st) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(st, null, 2) + '\n', 'utf8'); }

/** Diem vao. o: {auditDirs, projectDir, pluginRoot, extRoots, days, caps, nowMs, timeoutMs, maxBytes, state, order, waitDays}. */
export async function pruneCandidates(o = {}) {
  const nowMs = Number(o.nowMs) || Date.now();
  const days = o.days > 0 ? o.days : PRUNE.days;
  const inv = { commands: inventoryCommands(o), hooks: await inventoryHooks(o), skills: inventorySkills(o), agents: inventoryAgents(o), rules: inventoryRules(o) };
  const r = await readUsageEvents({ auditDirs: o.auditDirs || [], fromMs: nowMs - days * DAY, nowMs, timeoutMs: o.timeoutMs, maxBytes: o.maxBytes });
  const { usage, sources } = countUsage(r.events, inv);
  const b = buildCandidates({ inv, usage, state: o.state || {}, caps: o.caps, nowMs, days, waitDays: o.waitDays, skipDeprecate: !!r.truncated });
  const used = {}; for (const t of Object.keys(usage)) used[t] = usage[t].m.size;
  return { days, scanned: r.scanned, truncated: r.truncated, sources, used, ...b };
}
