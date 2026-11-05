// guard (PreToolUse, Bash/PowerShell): chan lenh doc/thao tac DB (best-effort, chi xet text lenh). Fail-open tuyet doi.
// Policy la DATA trong hook.config.json; them mau = 1 muc JSON + 1 dong test.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadFlat as loadConfig, loadConfig as coreLoadConfig, pluginLayerDirs } from '../../core/config/config.mjs';
import { isPluginMode } from '../../core/io/paths.mjs';
import { guardConfigHealth } from '../../core/config/guard-health.mjs';
import { isMain, writeOut } from '../../core/io/stdio.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS = { mode: 'enforce', logFile: '', maxInputBytes: 1048576, maxCommandChars: 100000, remoteHostAliases: [], sensitiveFileNames: [], allowlist: [], denyPatterns: [], protectedPaths: [], hardTimeoutMs: 2500 };
export const HUB_ROOT = path.resolve(HERE, '..', '..', '..');
const LEGACY_LOCAL = path.join(HERE, 'hook.config.local.json');
/** Local: <hubRoot>/config/guard/guard.local.json; neu thieu thi roi ve duong cu trong harness (chuyen tiep, canh bao legacy-local-config). */
export const configFiles = (hubRoot = HUB_ROOT) => {
  const nl = path.join(hubRoot, 'config', 'guard', 'guard.local.json');
  return [path.join(HERE, 'hook.config.json'), !fs.existsSync(nl) && fs.existsSync(LEGACY_LOCAL) ? LEGACY_LOCAL : nl];
};
// Luat cung (khong nam trong config, khong tat duoc): launcher bin/harness.mjs va config/launcher.local.json chi nguoi dung sua (chong tro sang plugin gia).
// Ghi chu: o worktree thu; cho 5c phai chuyen vao repo plugin (harness/constrain/guard/hook.mjs).
const LAUNCHER_FILE_RE = /(?:^|\/)(?:bin\/harness\.mjs|config\/launcher\.local\.json)$/i;
const LAUNCHER_PATH = String.raw`(?:bin[\\/]harness\.mjs|launcher\.local\.json)`;
const LAUNCHER_VERB = String.raw`\b(?:r` + String.raw`m|d` + String.raw`el|erase|mv|move|ren|rename|cp|copy|tee|truncate|ln|sed\s+-i\S*|perl\s+-p?i\S*|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|Rename-Item|New-Item|Clear-Content|git\s+(?:checkout|restore|rm|mv|apply|stash))\b`;
const LAUNCHER_CMD_RE = new RegExp(`${LAUNCHER_VERB}[^\\n;|&]*?${LAUNCHER_PATH}|>>?\\s*["']?[^\\s"']*${LAUNCHER_PATH}|launcher\\.local\\.json|(?:writeFile|appendFile|rename|unlink|copyFile)(?:Sync)?\\s*\\([^)]*bin[\\\\/]harness\\.mjs`, 'i');
const LAUNCHER_REASON = 'Cam sua launcher bin/harness.mjs va config/launcher.local.json (co the tro sang plugin gia); chi nguoi dung sua. / Launcher files are protected; the human edits them.';
// Cung luat launcher-protect: so dang ky plugin (~/.claude/plugins/installed_plugins.json, known_marketplaces.json) va thu muc code plugin guard
// (cache|marketplaces/... harness-kit|agent-guard-kit|harness-plugin): sua duoc la tro launcher sang plugin gia / vo hieu guard. Doc (cat/rg/doctor) KHONG chan.
const PLUGIN_FILE_RE = /(?:^|\/)\.claude\/plugins\/(?:(?:installed_plugins|known_marketplaces)\.json$|(?:cache|marketplaces)\/(?:[^/]+\/)*?[^/]*(?:harness-kit|agent-guard-kit|harness-plugin)(?:[^/]*)(?:\/|$))/i;
const PLUGIN_PATH = String.raw`\.claude[\\/]+plugins[\\/]+(?:(?:installed_plugins|known_marketplaces)\.json|(?:cache|marketplaces)[\\/]+[^\s"';|&]*?(?:harness-kit|agent-guard-kit|harness-plugin))`;
const PLUGIN_CMD_RE = new RegExp(`${LAUNCHER_VERB}[^\\n;|&]*?${PLUGIN_PATH}|>>?\\s*["']?[^\\s"']*${PLUGIN_PATH}|(?:writeFile|appendFile|rename|unlink|rm|rmdir|copyFile|cp)(?:Sync)?\\s*\\([^)]*${PLUGIN_PATH}`, 'i');
const PLUGIN_REASON = 'Cam sua so dang ky plugin (installed_plugins.json/known_marketplaces.json) va thu muc plugin guard; chi nguoi dung sua (claude plugin ...). / Plugin registry and guard plugin files are protected; the human changes them.';
/** Bao ve cung (trong code, config/lop du an khong tat duoc): file dang ky extension lop may (config/ext/local.json) + lenh ext register/approve tu agent. */
const EXT_CONFIG_RE = /(?:^|[^\w-])config[\\/]+ext[\\/]+local\.json\b/i;
// Chi chan lenh GHI/CHAY: `harness ext register|approve`; ext-cmd/ext-registry cung dong voi register|approve; chay ext-cmd bang node/bun/deno;
// ghi/xoa/di chuyen file ext-cmd/ext-registry (LAUNCHER_VERB, redirect). Lenh chi doc (git diff/log/show, cat, rg, grep...) duoc qua (isReadOnlyCmd).
const EXT_FILE = String.raw`ext-(?:cmd|registry)(?:\.mjs)?(?![\w.-])`;
const EXT_CMD_RE = new RegExp(String.raw`\bharness(?:\.mjs)?["']?\s+ext\s+(?:register|approve)\b|\bext-(?:cmd|registry)\b[^\n]*\b(?:register|approve)\b|\b(?:node|bun|deno|npx|tsx)\b[^\n;|&]*\bext-cmd(?:\.mjs)?(?![\w.-])|${LAUNCHER_VERB}[^\n;|&]*?\b${EXT_FILE}|>>?\s*["']?[^\s"']*${EXT_FILE}`, 'i');
const READ_SEG_RE = /^\s*(?:git\s+(?:-c\s+\S+\s+)*(?:diff|log|show|blame|grep|status)|cat|rg|grep|egrep|fgrep|head|tail|less|more|type|Get-Content|gc|wc|ls|Select-String|sls|sort|uniq|nl)\b/i;
/** Lenh chi doc: khong co ; & < > backtick $( ; moi doan pipe deu la lenh doc. */
const isReadOnlyCmd = (cmd) => !/[;&<>`\n]|\$\(/.test(cmd) && cmd.split('|').every((s) => READ_SEG_RE.test(s));
// Van ban tro (message commit/tag, echo/printf) nhac ten lenh ext khong phai LENH: bo chuoi trich dan cua cac lenh nay truoc khi so EXT_*.
// Chi bo khi chuoi khong the thuc thi: lenh co $( / backtick / <( / eval / iex / pipe vao shell-interpreter thi GIU NGUYEN (van chan).
const INERT_LEAD_RE = /^(?:git\s+(?:-c\s+\S+\s+)*(?:commit|tag|notes)|echo|printf|Write-Output|Write-Host)\b/i;
const EXEC_RISK_RE = /\\["']|\$\(|\x60|<\(|\b(?:eval|iex|Invoke-Expression|source)\b|\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|fish|pwsh|powershell|cmd|node|bun|deno|python\d?|perl|ruby|xargs|\.)(?![\w-])/i;
export function stripInertText(cmd) {
  if (typeof cmd !== 'string' || EXEC_RISK_RE.test(cmd)) return cmd;
  let out = '', seg = '', q = null, buf = '';
  for (const ch of cmd) {
    if (q) {
      if (ch === q) { out += INERT_LEAD_RE.test(seg.trimStart()) ? q + q : q + buf + q; seg += q + q; q = null; buf = ''; }
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    out += ch;
    seg = /[;&|\n()]/.test(ch) ? '' : seg + ch;
  }
  return q ? cmd : out; // quote khong dong: giu nguyen (khong doan)
}
const EXT_REASON = 'Cam sua dang ky extension (lop may) hoac ext register/approve tu agent; chi nguoi dung o TTY. / Extension registry is protected; the human must run it in a TTY.';
const PACK_KEYS =new Set(['remoteHostAliases', 'sensitiveFileNames', 'denyPatterns', 'allowlist', 'protectedPaths']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Noi theo id: trung id thi lop sau thang; disable:true tat ro rang. protect = id loi: lop goi khong duoc ghi de/tat (bo qua + canh bao). */
function mergeById(base, over, protect, warn) {
  const out = [...base];
  for (const r of over) {
    if (!isObj(r)) continue;
    if (protect && r.id && protect.has(r.id)) { if (warn) warn('goi du an: id luat loi "' + r.id + '" khong duoc ghi de/tat, bo qua'); continue; }
    const i = r.id ? out.findIndex((x) => x.id === r.id) : -1;
    if (i >= 0) out[i] = r; else out.push(r);
  }
  return out.filter((r) => !r.disable);
}
const norm = (rules) => (Array.isArray(rules) ? rules : []).filter(isObj).map((r) => (r.pattern !== undefined && r.regex === undefined ? { ...r, regex: r.pattern } : r));
const union = (a, b) => [...new Set([...(a || []), ...(Array.isArray(b) ? b : [])])];
const ESC = /[.*+?^${}()|[\]\\]/g;

/** Tap file nhay cam MAC DINH trong code (defaults over config): luon co, ke ca du an sach khong cau hinh; sensitiveFileNames chi MO RONG.
 *  .env/.env.* (tru .env.example|.sample|.template|.dist), khoa/chung chi, file credential pho bien. */
const SENSITIVE_TOKEN = String.raw`\.env(?!\.(?:example|sample|template|dist)(?![\w.-]))(?:\.[\w-]+)*|[\w.-]*\.(?:pem|key|p12|pfx|jks|keystore)|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|secrets?\.(?:json|ya?ml)|service-account[\w.-]*\.json`;
const SENSITIVE_DEFAULT = String.raw`(?:^|[\\/\s'"=])(?:${SENSITIVE_TOKEN})(?=$|[\s'"|;&)])`;
const BUILTIN_SENSITIVE = new Set(['.env']); // da phu boi mac dinh (co loai tru .env.example)

/** Luat config-dump: mac dinh trong code + sensitiveFileNames (mo rong). Luon tra ve luat. */
function sensitiveRule(names = []) {
  const extra = names.map(String).filter((n) => n && !BUILTIN_SENSITIVE.has(n));
  const alt = extra.map((n) => n.replace(ESC, '\\$&')).join('|');
  const regex = String.raw`\b(cat|type|Get-Content|gc|less|more|bat|sed\s+-n|head|tail)\b[^|;&\n]*(` + (alt ? alt + '|' : '') + SENSITIVE_DEFAULT + ')';
  return { id: 'config-dump', regex, unless: '\\|\\s*(sha256sum|md5sum|shasum|wc)\\b', reason: 'Cam in noi dung file cau hinh/bi mat (.env, khoa, credential...). Dung sha256sum/wc/grep -n co gioi han. / Config/secret dump blocked; use sha256sum, wc, bounded grep -n.' };
}

/** Qua core loadConfig (D3): loi (files[0]) < may (files[1..], config/guard/local.json; duy nhat tat duoc luat loi) < du an (config/guard/projects/<id>.json, chi PACK_KEYS) < env. Khong suy tu cwd. -> {config, warnings} */
export function load(files = configFiles(), opts = {}) {
  const warnings = [];
  const env = opts.env || process.env;
  const hubRoot = opts.hubRoot || HUB_ROOT;
  // File config guard hong KHONG am tham thanh rong: canh bao ro (handle ghi audit + stderr; doctor bao ERROR). Hook van fail-open.
  for (const b of guardConfigHealth({ hubRoot, env, repoDir: opts.repoDir })) warnings.push('config-broken: ' + b.file + ' (' + b.problem + ') - config guard hong, protectedPaths va luat tu file nay mat hieu luc');
  let cfg = { ...DEFAULTS };
  let deny = [], allow = [], aliases = [], names = [], paths = [];
  const pile = (c) => {
    const { denyPatterns, allowlist, remoteHostAliases, sensitiveFileNames, protectedPaths, ...scalars } = c;
    cfg = { ...cfg, ...scalars };
    deny = mergeById(deny, norm(denyPatterns)); allow = mergeById(allow, norm(allowlist));
    aliases = union(aliases, remoteHostAliases); names = union(names, sensitiveFileNames); paths = union(paths, protectedPaths);
  };
  if (files.includes(LEGACY_LOCAL)) warnings.push('legacy-local-config: chuyen ' + LEGACY_LOCAL + ' sang config/guard/guard.local.json');
  const read = (f, quiet) => { const l = loadConfig({ defaults: {}, files: [f] }); if (!quiet) warnings.push(...l.warnings); return l.config; };
  const layers = files.map((f) => read(f));
  // Tang may (D3): files[1..] + config/guard/local.json; nap vao 'defaults' cua loader (duoi du an) + bia mo (tombstone) cho luat tat o may.
  // File may chuan (config/guard/local.json, guard.local.json) do core tu nap (khong nap 2 lan); chi file tuy chon khac moi vao defaults.
  const gdir = path.join(hubRoot, 'config', 'guard');
  const std = [path.join(gdir, 'local.json'), path.join(gdir, 'guard.local.json')].map((p) => path.resolve(p));
  const extra = files.slice(1).map((f, i) => ({ f, c: layers[i + 1] }));
  const stdRaw = std.filter((p) => !files.slice(1).some((f) => path.resolve(f) === p)).map((p) => read(p, true));
  const plugMachine = isPluginMode(opts.repoDir || hubRoot) ? [read(path.join(pluginLayerDirs({ env, repoDir: opts.repoDir || hubRoot }).machineDir, 'guard', 'local.json'), true)] : [];
  const machine = [...extra.map((e) => e.c), ...stdRaw, ...plugMachine];
  const viaDefaults = extra.filter((e) => !std.includes(path.resolve(e.f))).map((e) => e.c);
  const lscal = machine.reduce((a, c) => ({ ...a, ...c }), {});
  const tomb = new Set();
  for (const m of machine) for (const k of ['denyPatterns', 'allowlist']) for (const r of Array.isArray(m[k]) ? m[k] : []) if (isObj(r) && r.id && r.disable) tomb.add(r.id);
  const coreLayer = layers[0] || {};
  pile(coreLayer);
  const coreDeny = deny.map((r) => r.id).filter(Boolean), coreAllow = allow.map((r) => r.id).filter(Boolean);
  for (const m of viaDefaults) pile(m);
  const defaults = { ...cfg, denyPatterns: deny, allowlist: allow, remoteHostAliases: aliases, sensitiveFileNames: names, protectedPaths: paths };
  const plugMode = isPluginMode(opts.repoDir || hubRoot) && !env.GUARD_PROJECT;
  const project = plugMode ? 'project' : String(env.GUARD_PROJECT || lscal.project || '').trim();
  // env loc: HARNESS_GUARD_* va HARNESS_CONFIG_DIR khong duoc anh huong guard; chi GUARD_MODE/GUARD_LOG_FILE/GUARD_PROJECT (xu ly rieng).
  const fenv = {}; for (const [k, v] of Object.entries(env)) if (!/^HARNESS_GUARD_/i.test(k) && !/^HARNESS_CONFIG_DIR$/i.test(k)) fenv[k] = v;
  const base = { defaults, root: hubRoot, configDir: path.join(hubRoot, 'config'), env: fenv, repoDir: opts.repoDir, skipProjectLayer: true, protect: { denyPatterns: { ids: coreDeny }, allowlist: { ids: coreAllow } } };
  const b = coreLoadConfig('guard', base);
  let r = b;
  if (project) {
    if (!/^[\w.-]+$/.test(project)) warnings.push('goi du an: ten khong hop le "' + project + '", bo qua');
    else {
      const gd = path.join(hubRoot, 'config', 'guard');
      if (!plugMode && !fs.existsSync(path.join(gd, 'projects', project + '.json')) && !fs.existsSync(path.join(gd, project + '.json'))) warnings.push('goi du an "' + project + '" thieu: ' + path.join(gd, 'projects', project + '.json') + '; chi ap luat chung');
      r = coreLoadConfig('guard', { ...base, project: plugMode ? undefined : project, skipProjectLayer: false });
    }
  }
  warnings.push(...r.warnings);
  cfg = { ...r.config };
  // Du an chi duoc dong goi luat (PACK_KEYS); khoa vo huong khac (mode, maxCommandChars...) bi hoan nguyen.
  if (r !== b) {
    const dropped = new Set();
    for (const [k, src] of Object.entries(r.sources)) {
      const top = k.split('.')[0];
      if (String(src).startsWith('project:') && !PACK_KEYS.has(top)) dropped.add(top);
    }
    for (const k of dropped) { if (k in b.config) cfg[k] = b.config[k]; else delete cfg[k]; warnings.push('goi du an "' + project + '": khoa la "' + k + '" bi bo qua'); }
  }
  // allowlist cua du an: bat buoc co `for` (mang id khong rong), khong tro toi id luat loi; sai thi bo + canh bao (chi id).
  if (r !== b) {
    const had = new Set((b.config.allowlist || []).map((x) => JSON.stringify(x)));
    const core = new Set(coreDeny);
    cfg.allowlist = (cfg.allowlist || []).filter((a) => {
      if (had.has(JSON.stringify(a))) return true;
      const ok = isObj(a) && Array.isArray(a.for) && a.for.length > 0 && a.for.every((x) => typeof x === 'string' && !core.has(x));
      if (!ok) warnings.push('goi du an "' + project + '": allowlist "' + String(a && a.id) + '" thieu/sai "for" hoac tro toi luat loi, bo');
      return ok;
    });
  }
  aliases = union(b.config.remoteHostAliases, cfg.remoteHostAliases); names = union(b.config.sensitiveFileNames, cfg.sensitiveFileNames);
  paths = union(b.config.protectedPaths, cfg.protectedPaths).filter((x) => typeof x === 'string' && x.trim()); // chi them (khong tat duoc): lop du an/may chi siet
  deny = norm(cfg.denyPatterns).filter((x) => !tomb.has(x.id)); allow = norm(cfg.allowlist).filter((x) => !tomb.has(x.id));
  deny = [sensitiveRule(names), ...deny.filter((x) => x.id !== 'config-dump')];
  cfg = { ...cfg, denyPatterns: deny, allowlist: allow, remoteHostAliases: aliases, sensitiveFileNames: names, protectedPaths: paths };
  if (env.GUARD_MODE) cfg.mode = env.GUARD_MODE;
  if (env.GUARD_LOG_FILE) cfg.logFile = env.GUARD_LOG_FILE;
  return { config: cfg, warnings };
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rx = (s) => { try { return new RegExp(s, 'i'); } catch (e) { try { fs.writeSync(2, 'guard: regex loi bi bo qua: ' + String(s).slice(0, 80) + ' (' + e.message + ')\n'); } catch { /* stderr dong */ } return null; } };


// ---- protectedPaths (mac dinh RONG trong code; them tu config guard cua may/du an). Lenh/ file nhac toi duong dan duoc bao ve -> deny, tru cong harness obsidian. ----
const PROTECTED_REASON = 'Duong dan duoc bao ve (guard protectedPaths): chi doc/ghi qua cong co kiem soat (harness obsidian ...). / Protected path: use the gated tool (harness obsidian ...), not raw shell/file access.';
/** Chuan hoa de so khop (ca lenh lan muc protectedPaths): chu thuong; bo backtick PowerShell; \ (lap) -> /; gop //; dang msys /e/x, /mnt/e/x, /cygdrive/e/x -> e:/x;
 *  bo doan /./; gop x/../; bo dau cham/khoang trang cuoi moi thanh phan (Windows coi "Vault." = "Vault"). */
export function normPathText(s, spaces = false) {
  let t = String(s).toLowerCase().replace(/\x60/g, '').replace(/\\+/g, '/').replace(/\/{2,}/g, '/')
    .replace(/(^|[\s"'=(,;])\/(?:mnt|cygdrive)\/([a-z])(?=\/|$|[\s"'])/g, '$1$2:')
    .replace(/(^|[\s"'=(,;])\/([a-z])(?=\/|$|[\s"'])/g, '$1$2:');
  t = t.replace(/\/\.(?=\/)/g, '');
  for (let i = 0; i < 8; i++) { const n = t.replace(/\/(?!\.\.(?:\/|$))[^/\s"']+\/\.\.(?=\/|$)/g, ''); if (n === t) break; t = n; }
  return t.replace(spaces ? /([^\s/.])[. ]+(?=\/)/g : /([^\s/.])\.+(?=\/)/g, '$1').replace(/([^\s/.])\.+(?=[\s"']|$)/g, '$1');
}
/** Danh sach protectedPaths da chuan hoa (bo muc rong/qua ngan <3 ky tu, bo '/' cuoi). */
const protectedList = (cfg) => (Array.isArray(cfg && cfg.protectedPaths) ? cfg.protectedPaths : [])
  .filter((x) => typeof x === 'string').map((x) => normPathText(x.trim()).replace(/\/+$/, '')).filter((x) => x.length >= 3);
// Ngoai le: lenh DON, token dau DUNG "harness" (khong tien to duong dan: ./harness, .\harness, C:\...\harness deu khong duoc) hoac node "<bin harness cua plugin dang chay>" roi "obsidian".
// Co ; & | < > ( ) { } backtick, $( @( hoac xuong dong -> khong ap dung (chong noi lenh/subexpression/scriptblock them).
const OBSIDIAN_DIRECT_RE = /^\s*harness\s+obsidian(?:\s|$)/i;
const OBSIDIAN_NODE_RE = /^\s*node(?:\.exe)?\s+(?:--?[\w-]+(?:=\S+)?\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))\s+obsidian(?:\s|$)/i;
const pluginBins = () => [path.join(HUB_ROOT, 'harness', 'cli', 'harness.mjs'), path.join(HUB_ROOT, 'bin', 'harness.mjs')].map(normPathText);
export function isObsidianGateCmd(cmd, bins = pluginBins()) {
  const c = String(cmd).replace(/^\s*&\s+/, ''); // PowerShell: & harness obsidian ...
  if (/[;&|<>(){}\x60\n\r]|\$\(/.test(c)) return false;
  if (OBSIDIAN_DIRECT_RE.test(c)) return true;
  const m = OBSIDIAN_NODE_RE.exec(c);
  return !!m && bins.includes(normPathText(m[1] || m[2] || m[3]));
}
/** -> {id, reason} neu text (lenh hoac duong dan file) nhac toi protectedPaths, nguoc lai null. opts.file = text la duong dan file (khong co ngoai le obsidian). */
export function protectedPathHit(text, cfg, opts = {}) {
  const list = protectedList(cfg);
  if (!list.length || typeof text !== 'string' || !text) return null;
  if (!opts.file && isObsidianGateCmd(text)) return null;
  const ts = [normPathText(text), normPathText(text, true)]; // khoang trang cuoi thanh phan chi bo o dang 2 (dang 1 giu "lenh /abs/path" nguyen)
  for (const p of list) {
    const re = new RegExp('(?<![a-z0-9_.-])' + p.replace(ESC, '\\$&') + '(?![a-z0-9_.-])');
    if (ts.some((t) => re.test(t))) return { id: 'protected-path', reason: PROTECTED_REASON };
  }
  return null;
}

/** -> {id, reason} cua mau dau tien khop, hoac null. */
export function evaluate(cmd, cfg) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  const extCmd = stripInertText(cmd);
  if (EXT_CONFIG_RE.test(extCmd) || (EXT_CMD_RE.test(extCmd) && !isReadOnlyCmd(cmd))) return { id: 'ext-config-protect', reason: EXT_REASON };
  if (cmd.length > (cfg.maxCommandChars ?? 100000)) return { id: 'command-too-long', reason: 'Lenh qua dai (> maxCommandChars), khong the kiem; chia nho. / Command too long to inspect; split it.' };
  if (LAUNCHER_CMD_RE.test(cmd) && !(isReadOnlyCmd(cmd) && !/\s(?:-o|--output)(?:[\s=]|$)/i.test(cmd))) return { id: 'launcher-protect', reason: LAUNCHER_REASON }; // doc launcher (cat/ls/git diff...) duoc qua; ghi/redirect/rm/node van chan
  if (PLUGIN_CMD_RE.test(cmd)) return { id: 'launcher-protect', reason: PLUGIN_REASON };
  const ncmd = cmd.replace(/\\\r?\n|\x60\r?\n/g, ' '); // noi dong (\ hoac backtick + xuong dong) truoc khi so khop
  const pp = protectedPathHit(ncmd, cfg); if (pp) return pp;
  const aliases = (cfg.remoteHostAliases || []).map(esc).join('|');
  const remote = new RegExp(`\\b(ssh|scp|sftp|rsync)\\b${aliases ? `|\\b(${aliases}):` : ''}`, 'i').test(cmd);
  for (const p of cfg.denyPatterns || []) {
    if (!p || !p.id) continue;
    if (p.remote && !remote) continue;
    const re = rx(p.regex);
    if (!re || !re.test(ncmd)) continue;
    if (p.unless) { const u = rx(p.unless); if (u && u.test(cmd)) continue; }
    const allowed = (cfg.allowlist || []).some((a) => (!a.for || a.for.includes(p.id)) && rx(a.regex)?.test(cmd));
    if (allowed) continue;
    return { id: p.id, reason: p.reason || 'blocked by guard' };
  }
  return null;
}

/** Lay lenh tu input Claude (Bash/PowerShell) hoac agy (run_command). -> {cmd, tool, agy} | null */
function extract(inp) {
  if (!inp || typeof inp !== 'object' || Array.isArray(inp)) return null;
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(inp.tool_name)) {
    const ti = inp.tool_input || {}; const p = ti.file_path || ti.notebook_path;
    const fp = typeof p === 'string' ? p : '';
    if (typeof p === 'string' && EXT_CONFIG_RE.test(p)) return { cmd: p, tool: inp.tool_name, agy: false, filePath: fp };
    const np = typeof p === 'string' ? p.replace(/\\/g, '/') : '';
    if (np && PLUGIN_FILE_RE.test(np)) return { cmd: '> .claude/plugins/installed_plugins.json', tool: inp.tool_name, agy: false, filePath: fp };
    const hit = !!np && LAUNCHER_FILE_RE.test(np);
    return { cmd: hit ? '> bin/harness.mjs' : '', tool: inp.tool_name, agy: false, filePath: fp };
  }
  if (inp.tool_name === 'Bash' || inp.tool_name === 'PowerShell') {
    const c = inp.tool_input && inp.tool_input.command;
    return { cmd: typeof c === 'string' ? c : '', tool: inp.tool_name, agy: false };
  }
  const tc = inp.toolCall;
  if (tc && tc.name === 'run_command' && tc.args) return { cmd: typeof tc.args.CommandLine === 'string' ? tc.args.CommandLine : '', tool: 'run_command', agy: true };
  return null;
}

/** Quyet dinh thuan -> {out, entry|null}. */
export function decide(inp, cfg) {
  const x = extract(inp);
  if (!x) return { out: {}, entry: null };
  let subject = x.cmd;
  let hit = evaluate(x.cmd, cfg);
  if (!hit && x.filePath) { hit = protectedPathHit(x.filePath, cfg, { file: true }); if (hit) subject = x.filePath; } // log hash/len cua file_path (khong ghi noi dung)
  const audit = cfg.mode === 'audit';
  const base = { out: x.agy ? { decision: 'allow' } : {}, entry: null };
  if (!hit) return base;
  const entry = { id: hit.id, tool: x.tool, mode: cfg.mode, action: audit ? 'would-block' : 'block', hash: crypto.createHash('sha256').update(subject).digest('hex').slice(0, 16), len: subject.length }; // khong ghi noi dung lenh (co the chua secret): chi hash + do dai + id luat
  if (audit) return { out: base.out, entry };
  const reason = `guard[${hit.id}]: ${hit.reason}`;
  const out = x.agy ? { decision: 'deny', reason } : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  return { out, entry };
}

async function logFile(cfg) {
  if (cfg.logFile) return cfg.logFile;
  const m = await import('../../core/audit/audit-write.mjs');
  return path.join(m.auditRoot(), 'guard', `guard-${new Date().toISOString().slice(0, 10)}.jsonl`);
}
export async function log(entry, cfg) {
  try {
    const f = await logFile(cfg);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), hook: 'guard', ...entry }) + '\n');
  } catch {}
}

const warnBroken = (w) => { try { fs.writeSync(2, 'guard: ' + w.slice(0, 400) + '\n'); } catch { /* stderr dong */ } };

function readStdin(max, ms) {
  return new Promise((resolve) => {
    let buf = ''; let over = false; let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const t = setTimeout(() => fin({ err: 'timeout' }), ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { if (buf.length + d.length > max) over = true; else buf += d; });
    process.stdin.on('end', () => {
      clearTimeout(t);
      if (over) return fin({ err: 'oversize' });
      try { fin({ inp: JSON.parse(buf.replace(/^﻿/, '') || '{}') }); } catch { fin({ err: 'badjson' }); }
    });
    process.stdin.on('error', () => fin({ err: 'stdin' }));
  });
}

/**
 * Module hook (contract HOOK_MODULE). handle(event, input, ctx) -> Promise<{decision?, reason?}>; KHONG ghi stdout/exit.
 * Ket qua: {} = khong y kien; {decision:'deny', reason:'guard[id]: ...'} = chan; input agy (toolCall.run_command) khong khop luat -> {decision:'allow'} (nghia cu cua agy).
 * Fail-open: moi loi noi bo -> {}. Nhat ky guard (hit/config-warning) tra qua `records` ([{sink:'guard', data}]); chi tu ghi khi ctx.write !== false.
 * ctx (tuy chon): {config (da nap, bo qua load), hubRoot, env, write}. event hien khong dung (guard chi xet tool_name/toolCall).
 */
export async function handle(event, input, ctx = {}) {
  const records = [];
  const emit = async (entry, cfg) => { records.push({ sink: 'guard', data: { ts: new Date().toISOString(), hook: 'guard', ...entry } }); if (!ctx || ctx.write !== false) await log(entry, cfg); };
  const done = (r) => (records.length ? { ...r, records } : r);
  try {
    let cfg = ctx && ctx.config;
    if (!cfg) {
      const L = load(undefined, { hubRoot: ctx && ctx.hubRoot, env: ctx && ctx.env });
      cfg = L.config;
      for (const w of L.warnings) { await emit({ id: 'config-warning', action: w.slice(0, 200) }, cfg); if (w.startsWith('config-broken')) warnBroken(w); }
    }
    const d = decide(input, cfg);
    if (d.entry) await emit(d.entry, cfg);
    const o = d.out || {};
    const hso = o.hookSpecificOutput;
    if (hso && hso.permissionDecision) return done({ decision: hso.permissionDecision, reason: hso.permissionDecisionReason });
    if (o.decision) return done(o.reason === undefined ? { decision: o.decision } : { decision: o.decision, reason: o.reason });
    return done({});
  } catch { return done({}); }
}

const META = { id: 'guard', events: ['PreToolUse'], tools: /^(Bash|PowerShell|run_command|Edit|Write|MultiEdit|NotebookEdit)$/, timeoutMs: 2500, onError: 'open' };
/** Alias cu (test). Chuan dispatcher la export default. */
export const hookModule = Object.freeze({ ...META, handle });
/** Chuan HOOK_MODULE: async handle(event, input, ctx). */
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });

/** Ket qua handle -> JSON stdout nhu ban cu (vo mong; dispatcher co cach render rieng). */
export function toOutput(result, input) {
  const r = result || {};
  if (!r.decision) return {};
  const tc = input && input.toolCall;
  if (tc && tc.name === 'run_command' && tc.args) return r.reason === undefined ? { decision: r.decision } : { decision: r.decision, reason: r.reason };
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: r.decision, permissionDecisionReason: r.reason } };
}

async function main() {
  let out = {};
  try {
    const L = load(); const cfg = L.config;
    for (const w of L.warnings) { await log({ id: 'config-warning', action: w.slice(0, 200) }, cfg); if (w.startsWith('config-broken')) warnBroken(w); }
    const r = await readStdin(cfg.maxInputBytes, cfg.hardTimeoutMs);
    if (r.err) await log({ id: 'fail-open', action: r.err }, cfg);
    else out = toOutput(await handle('PreToolUse', r.inp, { config: cfg, write: true }), r.inp);
  } catch { out = {}; }
  writeOut(JSON.stringify(out));
}

if (isMain(import.meta.url)) { main().then(() => process.exit(0), () => process.exit(0)); }
