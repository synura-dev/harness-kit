// Tin hieu ket qua + dau phien ban + vet prompt cho audit. Re: chi regex + stat (khong doc noi dung lon, khong mang). Khong nem.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { safeId } from '../io/safe-id.mjs';

const strip = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
const sha1 = (s, n = 12) => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);

const STOP = new Set(('the and for you that with this have from are was but not can all any use dung cho cua khong nhung cac mot nhu nay khi hay thi la va co duoc de trong voi cung can den tren duoi minh ban toi them roi sau truoc ra vao se da dang').split(/\s+/));
/** Prompt -> { prompt_hash (sha1 12), prompt_kw (<=8 tu da chuan hoa, khong nguyen van) }. */
export function promptTrace(prompt, maxKw = 8) {
  const t = strip(prompt);
  if (!t.trim()) return null;
  const freq = new Map();
  for (const w of t.split(/[^a-z0-9]+/)) {
    if (w.length < 3 || w.length > 20 || STOP.has(w) || /\d{4,}/.test(w)) continue; // bo chuoi dai/so dai (co the la secret/id)
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  const kw = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxKw).map((e) => e[0]);
  return { prompt_hash: sha1(String(prompt)), prompt_kw: kw };
}

// Sua loi: xet 300 ky tu dau sau khi bo boc <channel>/<system-reminder>. Cum sua loi ro nghia o BAT KY dau, hoac tu khoa o DAU CAU (tranh "Sai Gon", "sai so", "khong phai lo", "sua lai README", "dung cho test").
const CORRECTION_MAX = 300;
const unwrap = (raw) => raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ").replace(/<\/?channel\b[^>]*>/g, " ");
const CORRECTION_PHRASE = /(?:^|[^a-z])(?:sai roi|lam sai|khong dung|ko dung|khong phai vay|ko phai vay|lam lai|undo that|that'?s wrong|that is wrong|toi da noi|toi da bao|sao lai|lai nua|tu gio tro di|tu gio xdungx|xdungx co)(?:[^a-z]|$)/; // xdungx = "đừng" nhan dien truoc khi bo dau (tranh "dùng"/"đúng")
const CORRECTION_START = /^(?:khong duoc\b|(?:khong|ko|k) phai (?:vay|file nay|cai nay|cai do|y toi)|undo(?: it)?\b|redo\b|wrong\b|incorrect\b|not what i)/;
/** Prompt sua loi -> 'correction' | null. */
export function promptSignal(prompt) {
  const raw = String(prompt ?? '');
  const t = strip(unwrap(raw).toLowerCase().normalize('NFC').replace(/đừng/g, 'xdungx')).slice(0, CORRECTION_MAX).replace(/[^\S\n]+/g, ' ').trim();
  if (!t) return null;
  if (CORRECTION_PHRASE.test(t.replace(/\s+/g, ' '))) return 'correction'; // giu \n de CORRECTION_START xet tung dong
  return t.split(/[.!?;\n]+/).some((x) => CORRECTION_START.test(x.trim())) ? 'correction' : null;
}

const REVERT = /(?:^|[\s;&|(])git\s+(?:-C\s+(?:"[^"]*"|\S+)\s+)?(?:revert\b|reset\s+--hard\b|checkout\s+(?:\S+\s+)?--(?:\s|$))/;
const TASK_STATUS = /\bharness\s+tasks\s+set\b[^\n|;&]*--status\b/;
/** Lenh Bash day du -> 'revert' | 'task_status' | null. */
export function bashSignal(cmd) {
  const c = typeof cmd === 'string' ? cmd : '';
  if (REVERT.test(c)) return 'revert';
  if (TASK_STATUS.test(c)) return 'task_status';
  return null;
}

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const walk = (dir, out, max, depth = 0) => {
  if (out.length >= max || depth > 3) return;
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (out.length >= max) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, max, depth + 1); else out.push(p);
  }
};
/**
 * Dau phien ban luc SessionStart: { harness_kit (package/plugin version), rules_hash (sha1 12 cua ten+size+mtime), rules_files (so file) }.
 * Gom: CLAUDE.md/AGENTS.md (cwd), .claude/agents, .agents/agents, skills + hooks/hooks.json cua plugin. Tran maxFiles; chi stat.
 */
const VS_CACHE = new Map();
const mt = (f) => { try { return Math.floor(fs.statSync(f).mtimeMs); } catch { return 0; } };
export function versionStamp({ cwd = '', pluginRoot = PLUGIN_ROOT, maxFiles = 400 } = {}) {
  // Cache theo mtime thu muc (+ file goc): chi quet lai khi doi.
  const watch = [pluginRoot, path.join(pluginRoot, 'skills'), path.join(pluginRoot, 'hooks', 'hooks.json'), path.join(pluginRoot, 'package.json')];
  if (cwd) watch.push(cwd, path.join(cwd, 'CLAUDE.md'), path.join(cwd, 'AGENTS.md'), path.join(cwd, '.claude', 'agents'), path.join(cwd, '.agents', 'agents'));
  const sig = watch.map(mt).join(',');
  const ck = `${cwd}|${pluginRoot}|${maxFiles}`;
  const hit = VS_CACHE.get(ck);
  if (hit && hit.sig === sig) return { ...hit.out };
  const out = versionStampScan({ cwd, pluginRoot, maxFiles });
  VS_CACHE.set(ck, { sig, out });
  return { ...out };
}
function versionStampScan({ cwd, pluginRoot, maxFiles }) {
  const out = { harness_kit: null, rules_hash: null, rules_files: 0 };
  try {
    for (const rel of [['package.json'], ['.claude-plugin', 'plugin.json']]) {
      try { const v = JSON.parse(fs.readFileSync(path.join(pluginRoot, ...rel), 'utf8')).version; if (v) { out.harness_kit = String(v).slice(0, 20); break; } } catch {}
    }
    const files = [];
    if (cwd) {
      for (const f of ['CLAUDE.md', 'AGENTS.md']) files.push(path.join(cwd, f));
      walk(path.join(cwd, '.claude', 'agents'), files, maxFiles);
      walk(path.join(cwd, '.agents', 'agents'), files, maxFiles);
    }
    walk(path.join(pluginRoot, 'skills'), files, maxFiles);
    files.push(path.join(pluginRoot, 'hooks', 'hooks.json'));
    const h = crypto.createHash('sha1');
    let n = 0;
    for (const f of files.slice(0, maxFiles)) {
      try {
        const st = fs.statSync(f); if (!st.isFile()) continue;
        h.update(`${path.relative(cwd && f.startsWith(cwd) ? cwd : pluginRoot, f)}|${st.size}|${Math.floor(st.mtimeMs)}\n`); n++;
      } catch {}
    }
    out.rules_files = n;
    out.rules_hash = n ? h.digest('hex').slice(0, 12) : null;
  } catch {}
  return out;
}

/** Su kien HookRun (khong phai tool call): consumer thong ke tool/loi/actor phai bo qua. Dung cho ca dong da phang (type tu ten phan vung) lan envelope. */
export const isHookRun = (x) => !!x && (x.type === 'hook' || x.event === 'HookRun');

/** Envelope 'HookRun' (type=hook): do tre/loi moi module cua mot lan dispatch. modules = [{id, ms, err?}]. null neu thieu du lieu. */
export function hookRunEnvelope(event, input, modules, totalMs, now = new Date()) {
  try {
    if (!Array.isArray(modules) || !modules.length) return null;
    const raw = String((input && input.session_id) ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'nosession';
    const cli = input && input.cli === 'agy' ? 'agy' : 'claude'; // agy: dispatcher agy gan cli + session_id (conversationId)
    const sid = cli === 'agy' || raw.startsWith('claude-') ? raw : `claude-${raw}`;
    const ms = modules.map((m) => ({ id: safeId(m.id, 40), ms: Math.round(m.ms), ...(m.err ? { err: String(m.err).replace(/[^\w:.-]/g, '').slice(0, 40) } : {}) }));
    return {
      v: 2, ts: now.toISOString(), type: 'hook', event: 'HookRun', cli, sid, agent_id: null, agent_type: null, actor: null,
      project: null, cwd: '', tool: null, target: null, target_kind: null,
      ok: null, dur_ms: Math.round(totalMs), turns: null, tokens_in: null, tokens_out: null, status: String(event).slice(0, 30), model: null,
      summary: `${event} ${Math.round(totalMs)}ms ${ms.map((m) => `${m.id}=${m.ms}${m.err ? '!' : ''}`).join(' ')}`.slice(0, 120),
      data: { hook_event: String(event).slice(0, 30), hook_tool: input && input.tool_name ? safeId(input.tool_name, 40) : null, failed: ms.some((m) => m.err), modules: ms }, origin: null,
    };
  } catch { return null; }
}
