// Hook PreToolUse (gate): chan agent doc/ghi thang data/. Fail-open.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHookConfig } from '../../core/config/config.mjs';
import { dataRoot, isInside, isPluginMode, toPosix, workspaceRoot } from '../../core/io/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS = { enabled: true, allow: [] };
export const configFiles = () => [path.join(HERE, 'hook.config.json'), path.join(HERE, 'hook.config.local.json')];
export const load = (files = configFiles()) => loadHookConfig('data-gate', { defaults: DEFAULTS, files, env: { HOOK_DATA_GATE_ENABLED: 'enabled' } });

/**
 * Thong diep chan theo ngu canh: thu muc du lieu that (tuong doi workspace) + lenh cong dung.
 * Workspace co launcher bin/harness.mjs (hub) -> `harness` hoac `node bin/harness.mjs`; plugin mode -> `harness` (bin/ trong PATH);
 * ban sao khong plugin, khong launcher -> `node harness/cli/harness.mjs`. Khong nem.
 */
export function denyReason(ctx = {}) {
  const env = ctx.env || process.env;
  let rel = 'data/', cmd = 'harness data ls|...';
  try {
    const ws = ctx.workspace || workspaceRoot({ env });
    const d = dataRoot(null, { env });
    const r = path.relative(ws, d);
    rel = (r && !r.startsWith('..') && !path.isAbsolute(r) ? toPosix(r) : toPosix(d)) + '/';
    const launcher = fs.existsSync(path.join(ws, 'bin', 'harness.mjs'));
    const plugin = ctx.pluginMode ?? (!!env.CLAUDE_PLUGIN_ROOT || isPluginMode());
    cmd = launcher ? 'harness data ls|... (hoac node bin/harness.mjs data ...)'
      : plugin ? 'harness data ls|...'
      : 'node harness/cli/harness.mjs data ls|...';
  } catch { /* fail-open: thong diep mac dinh */ }
  return `data-gate: khong doc/ghi thang ${rel}. Dung cong: ${cmd} hoac observe (co log).`;
}
const VERB = /(^|[\s;&|(`])(cat|type|head|tail|less|more|ls|dir|find|grep|rg|sed|awk|tee|rm|del|erase|rd|rmdir|mv|move|ren|cp|copy|xcopy|touch|mkdir|truncate|get-content|gc|set-content|add-content|out-file|remove-item|copy-item|move-item|get-childitem|gci|sort|wc|cut|od|xxd)(\s|$)|>|readfilesync|writefilesync|readdirsync|unlinksync|rmsync|open\(|node\s+-e|node\s+--eval|python/i;

const PRE = String.raw`^(?:\w+=\S*\s+)*(?:(?:timeout|nice)\s+(?:-\S+\s+)*\S+\s+)?(?:node|bun)(?:\.exe)?\s+`;
// script dau (doi so dau sau co) phai la duong dan harness/ (nhay hoac khong); segment co $( ` redirect khong duoc mien tru
// cong cua plugin: bin/harness(.mjs) (node bin/harness.mjs, node "<plugin>/bin/harness", node ${CLAUDE_PLUGIN_ROOT}/bin/harness)
const BIN = String.raw`bin/harness(?:\.mjs)?`;
const GATE_RUN = new RegExp(PRE + String.raw`(?!-e\b|--eval|-p\b|--print)(?:--?[\w-]+(?:=\S+)?\s+)*(?:"[^"]*(?:harness/[^"]*|${BIN})"|'[^']*(?:harness/[^']*|${BIN})'|[^\s"']*(?:harness/\S*|${BIN}))(?:\s|$)`, 'i');
// lenh `harness <domain>` tu bin/ cua plugin (PATH)
const GATE_BIN = /^(?:\w+=\S*\s+)*(?:(?:timeout|nice)\s+(?:-\S+\s+)*\S+\s+)?harness(?:\.cmd|\.exe)?(?:\s|$)/i;
const GATE_TEST = new RegExp(PRE + String.raw`(?:--test|test)\s+(?:"[^"]*harness/|'[^']*harness/|[^\s"']*harness/)`, 'i');
const NODE_ANY = new RegExp(PRE, 'i');
const TAINT =/\$\(|`|[<>]/;
const WRAP = /(?:^|[\s;&|(])(?:bash|sh|zsh|dash|pwsh|powershell|cmd)(?:\.exe)?\s+(?:-\S+\s+)*?(?:-\w*c|-command|\/[ck])\s+("([^"]*)"|'([^']*)'|(.*))/i;
const CD = /^(?:cd|pushd|chdir|set-location|sl)\s+(.*)$/i;
const TOK = /"([^"]*)"|'([^']*)'|([^\s"'()<>=,]+)/g;
const tokens = (s, split = true) => { // token nhay giu nguyen (duong dan co dau cach) + them cac manh ben trong
  const o = []; let m; TOK.lastIndex = 0;
  while ((m = TOK.exec(s))) {
    const t = (m[1] ?? m[2] ?? m[3]).replace(/\u0001/g, ' '); o.push(t);
    if (split && m[3] === undefined) o.push(...(t.match(/[^\s"'()<>=,]+/g) || []));
  }
  return o;
};

/** Noi dung $(...) va backtick (khong long). */
function subs(c) {
  const out = [];
  for (let i = 0; i < c.length; i++) {
    if (c[i] === '$' && c[i + 1] === '(') {
      let d = 1, j = i + 2;
      for (; j < c.length && d; j++) { if (c[j] === '(') d++; else if (c[j] === ')') d--; }
      out.push(c.slice(i + 2, d ? j : j - 1)); i = j - 1;
    } else if (c[i] === '`') {
      const j = c.indexOf('`', i + 1); const e = j < 0 ? c.length : j;
      out.push(c.slice(i + 1, e)); i = e;
    }
  }
  return out;
}

const realOrSelf = (p) => {
  let cur = path.resolve(p); const tail = [];
  for (let i = 0; i < 64; i++) {
    try { return path.join((fs.realpathSync.native || fs.realpathSync)(cur), ...tail.reverse()); } catch {}
    const up = path.dirname(cur); if (up === cur) return path.resolve(p);
    tail.push(path.basename(cur)); cur = up;
  }
  return path.resolve(p);
};
const roots = (ctx) => { const d = dataRoot(null, ctx.env ? { env: ctx.env } : {}); return [path.resolve(d), realOrSelf(d)]; };

/** true neu duong dan p (tuong doi theo cwd) nam trong data/ va khong thuoc allow. */
function inData(p, cwd, cfg, ctx = {}) {
  if (typeof p !== 'string' || !p) return false;
  const base = roots(ctx);
  const abs = path.resolve(cwd || process.cwd(), p);
  const real = realOrSelf(abs);
  if (!base.some((b) => isInside(abs, b) || isInside(real, b))) return false;
  for (const a of cfg.allow || []) {
    const ab = path.resolve(base[0], a);
    if (isInside(abs, ab) && isInside(real, realOrSelf(ab))) return false;
  }
  return true;
}

const globBase = (g) => { const i = String(g).search(/[*?[{]/); return i < 0 ? String(g) : String(g).slice(0, i); };

/** Tach lenh theo ; && || | newline, bo qua ky tu nam trong chuoi quote. */
function splitSegs(c) {
  const out = []; let cur = ''; let q = '';
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (q) { cur += ch; if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur); return out;
}
const stripQuoted = (s) => s.replace(/"[^"]*"|'[^']*'/g, ' ');
const TEXTUAL = /^(git\s+(commit|log|tag|notes)|echo|printf)(\s|$)/i;
const GITPATH = /^git\s+(?:-C\s+\S+\s+|-\S+\s+)*(add|rm|mv|checkout|restore|clean|reset|update-index|stash|status|diff|log|show)(\s|$)/i;
const GREPLIKE = /^(grep|egrep|fgrep|rg)(\s|$)/i;

function bashRefsData(cmd, cwd, cfg, ctx = {}, depth = 0) {
  if (depth > 3) return false;
  const c = String(cmd).replace(/\\ /g, '\u0001').replace(/\\/g, '/').replace(/\d*>&\d/g, ' ');
  for (const sub of subs(c)) if (bashRefsData(sub, cwd, cfg, ctx, depth + 1)) return true;
  let cur = cwd;
  const hit = (t) => inData(t, cur, cfg, ctx) || inData(t, cwd, cfg, ctx); // cd co the that bai: xet ca cwd goc
  for (const seg of splitSegs(c)) {
    let s = seg.trim(); if (!s) continue;
    const cd = CD.exec(s);
    if (cd) { const t = tokens(cd[1]).find((x) => !/^\/d$/i.test(x) && !/^-\w$/.test(x)); if (t) cur = path.resolve(cur || process.cwd(), t); continue; }
    const w = WRAP.exec(s);
    if (w && bashRefsData(w[2] ?? w[3] ?? w[4] ?? '', cur, cfg, ctx, depth + 1)) return true;
    if (!TAINT.test(s.replace(/\d*>&\d|\d*>>?\s*(?:\/dev\/null|nul)\b/gi, '')) && (GATE_RUN.test(s) || GATE_TEST.test(s) || GATE_BIN.test(s))) continue; // cong / script / test harness
    if (NODE_ANY.test(s) && tokens(s).some((t) => hit(t))) return true; // node/bun script ngoai harness nhan duong dan data/
    if (TEXTUAL.test(s)) s = stripQuoted(s); // noi dung message/echo khong phai duong dan
    if (GITPATH.test(s)) { // git thao tac/doc duong dan: chan neu token resolve vao dataDir
      if (tokens(s).some((t) => hit(t) || (t.includes(':') && hit(t.slice(t.indexOf(":") + 1))))) return true; // rev:path
      continue;
    }
    if (!VERB.test(s)) continue;
    let cand = tokens(s, !GREPLIKE.test(s));
    if (GREPLIKE.test(s)) { // bo pattern (tham so dau khong phai co, hoac sau -e)
      const e = cand.indexOf('-e');
      const drop = e >= 0 ? e + 1 : cand.findIndex((t, k) => k > 0 && !t.startsWith('-'));
      if (drop > 0) cand = cand.filter((_, k) => k !== drop);
    }
    // chi chan khi token duong dan THUC SU resolve vao dataRoot()
    if (cand.some((t) => hit(t))) return true;
  }
  return false;
}

export function check(input, cfg, ctx = {}) {
  const ti = (input && input.tool_input) || {};
  const tool = input && input.tool_name;
  const cwd = input.cwd || process.cwd();
  if (/^(Read|Write|Edit|NotebookEdit|MultiEdit)$/.test(tool)) return inData(ti.file_path || ti.notebook_path || ti.path, cwd, cfg, ctx);
  if (tool === 'Glob' || tool === 'Grep') {
    if (ti.path && inData(ti.path, cwd, cfg, ctx)) return true;
    const g = globBase(tool === 'Glob' ? ti.pattern : ti.glob);
    return !!g && inData(g, ti.path ? path.resolve(cwd, ti.path) : cwd, cfg, ctx);
  }
  if (tool === 'Bash' || tool === 'PowerShell') return bashRefsData(ti.command || '', cwd, cfg, ctx);
  return false;
}

export async function handle(event, input, ctx = {}) {
  try {
    const env = ctx.env || process.env;
    if (env.HARNESS_GATEWAY === '1') return {};
    const cfg = ctx.cfg ?? load().config;
    if (!cfg.enabled || event !== 'PreToolUse' || !input || typeof input !== 'object') return {};
    if (check(input, cfg, ctx)) return { decision: 'deny', reason: denyReason(ctx) };
    return {};
  } catch { return {}; } // fail-open
}

const META = { id: 'data-gate', events: ['PreToolUse'], tools: /^(Read|Write|Edit|NotebookEdit|MultiEdit|Glob|Grep|Bash|PowerShell)$/, timeoutMs: 1500, onError: 'open' };
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });
