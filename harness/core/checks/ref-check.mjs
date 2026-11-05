// ref-check: every referenced harness path (harness/..., ./harness/..., cli/..., plugins/...) must exist.
// Pure: caller supplies files [{path, content}] and exists(relPath). No fs, no imports from cli/plugins/hooks/tools.
import { SEVERITY } from '../config/constants.mjs';

const REF_LIMITS = Object.freeze({ maxFiles: 500, maxBytes: 512 * 1024, timeoutMs: 5000 });

const REF_RE = /(?<![\w./@-])(?:\.\/)?(?:harness|cli|plugins)\/[A-Za-z0-9_.\-/]+/g;

/** Scan mode for a repo-relative path: 'playbook' | 'text' | 'usage' | null. */
export function scanKind(p) {
  const f = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  if (/^\.agents\/playbooks\/[^/]+\.json$/.test(f)) return 'playbook';
  if (/^docs\/[^/]+\.md$/.test(f)) return 'text';
  if (/^\.claude\/agents\/[^/]+\.md$/.test(f)) return 'text';
  if (/^\.agents\/agents\/[^/]+\.md$/.test(f)) return 'text';
  if (/^config\/[^/]+\.json$/.test(f)) return 'text';
  if (/^harness\/(?:plugins\/.+\/)?cli\/[^/]+\.mjs$/.test(f)) return 'usage';
  if (/^harness\/plugins\/[^/]+\/cli[^/]*\.mjs$/.test(f)) return 'usage';
  return null;
}

/** Extract refs from one line: [{ref, path}] (path = repo-relative, to be checked). */
export function extractRefs(line) {
  const out = [];
  for (const m of line.matchAll(REF_RE)) {
    const raw = m[0].replace(/[.,;:)\]]+$/, '');
    const next = line.charAt(m.index + m[0].length);
    if (/[*<>{}$]/.test(next)) continue; // glob / placeholder
    let path = raw.replace(/^\.\//, '');
    if (!path.startsWith('harness/')) path = 'harness/' + path;
    path = path.replace(/\/+$/, '');
    if (path === 'harness' || path.includes('//')) continue;
    out.push({ ref: raw, path });
  }
  return out;
}

function playbookItems(content) {
  let data;
  try { data = JSON.parse(content); } catch { return []; }
  const lines = content.split('\n');
  const res = [];
  const walk = (v, key) => {
    if (typeof v === 'string') {
      if (key === 'run' || key === 'command') {
        const needle = JSON.stringify(v).slice(1, -1);
        const i = lines.findIndex((l) => l.includes(needle));
        res.push({ line: i < 0 ? 1 : i + 1, text: v });
      }
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(data, '');
  return res;
}

// USAGE block: from first line mentioning USAGE until the template literal closes.
function usageItems(content) {
  const res = [];
  let on = false;
  content.split('\n').forEach((text, i) => {
    if (!on && /USAGE/.test(text)) on = true;
    if (!on) return;
    res.push({ line: i + 1, text });
    if (/`\s*;?\s*$/.test(text) && !/=\s*`\s*$/.test(text)) on = false;
  });
  return res;
}

// Danh dau 'planned': <!-- ref-ignore --> (1 dong), <!-- ref-ignore-start/end --> (khoi), hoac dong bat dau bang 'sẽ tạo'.
const IGNORE_LINE = /<!--\s*ref-ignore\s*-->/i;
const IGNORE_START = /<!--\s*ref-ignore-start\s*-->/i;
const IGNORE_END = /<!--\s*ref-ignore-end\s*-->/i;
const PLANNED_LINE = /^[\s>*\-\d.)]*(?:\*\*)?(?:sẽ tạo|se tao)\b/i;
const ANY_MARK = /<!--\s*ref-ignore(?:-start|-end)?\s*-->/i;
const MISUSE_REF = '<!-- ref-ignore --> ngoai docs/ (khong duoc che ref hong)';
const EXTS =['.mjs', '.json', '.md'];

// Docs lich su (bao cao audit, research, plans, TASKS.md): anh chup thoi diem viet, khong kiem ref.
const HISTORICAL = /^(?:docs\/(?:audit-[^/]*\.md|research\/|plans\/)|TASKS\.md$)/;
export const isHistorical = (p) => HISTORICAL.test(String(p).replace(/\\/g, '/').replace(/^\.\//, ''));

/** coreOwned(path) cho workspace mode: path thuoc loi plugin neu khop thu muc loi harness/<top>/ hoac ton tai trong pluginRoot. */
export function makeCoreOwned({ coreDirs = [], existsInPlugin = null } = {}) {
  const dirs = new Set(coreDirs);
  return (p) => {
    const m = /^harness\/([^/]+)(?:\/|$)/.exec(p);
    return !!m && (dirs.has(m[1]) || !!(existsInPlugin && existsInPlugin(p)));
  };
}

// ref khong duoi hop le neu ton tai voi .mjs/.json/.md
function refExists(exists, path) {
  if (exists(path)) return true;
  const last = path.slice(path.lastIndexOf('/') + 1);
  if (last.includes('.')) return false;
  return EXTS.some((e) => exists(path + e));
}

/**
 * @param {{files:{path:string,content:string}[], exists:(rel:string)=>boolean, limits?:object, now?:()=>number}} a
 * @returns {{ok:boolean, severity:string, errors:{file:string,line:number,ref:string}[], scanned:number, truncated:false|string}}
 */
export function checkRefs({ files, exists, limits, now = Date.now, coreOwned = null, skipHistorical = false }) {
  const lim = { ...REF_LIMITS, ...(limits || {}) };
  // workspace mode: ref thuoc loi plugin (coreOwned) khong phai loi cua workspace; ref toi file workspace hong van bao
  const has = coreOwned ? (p) => exists(p) || coreOwned(p) : exists;
  const deadline = now() + lim.timeoutMs;
  const errors = [];
  let scanned = 0;
  let truncated = false;
  for (const f of files) {
    const kind = scanKind(f.path);
    if (!kind) continue;
    if (skipHistorical && isHistorical(f.path)) continue;
    if (scanned >= lim.maxFiles) { truncated = 'max-files'; break; }
    if (now() > deadline) { truncated = 'timeout'; break; }
    let content = String(f.content ?? '');
    if (content.length > lim.maxBytes) { content = content.slice(0, lim.maxBytes); truncated = truncated || 'max-bytes'; }
    scanned++;
    const rel = f.path.replace(/\\/g, '/').replace(/^\.\//, '');
    const items = kind === 'playbook' ? playbookItems(content)
      : kind === 'usage' ? usageItems(content)
      : content.split('\n').map((text, i) => ({ line: i + 1, text }));
    let skipBlock = false;
    const mayIgnore = rel.startsWith('docs/'); // marker ref-ignore chi co hieu luc trong docs/
    for (const { line, text } of items) {
      if (!mayIgnore && ANY_MARK.test(text)) errors.push({ file: rel, line, ref: MISUSE_REF });
      if (mayIgnore && IGNORE_START.test(text)) { skipBlock = true; continue; }
      if (mayIgnore && IGNORE_END.test(text)) { skipBlock = false; continue; }
      if (skipBlock || (mayIgnore && IGNORE_LINE.test(text)) || PLANNED_LINE.test(text)) continue;
      for (const r of extractRefs(text)) {
        if (!refExists(has, r.path)) errors.push({ file: rel, line, ref: r.ref });
      }
    }
  }
  return { ok: errors.length === 0, severity: errors.length ? (SEVERITY.error ?? 'error') : 'ok', errors, scanned, truncated };
}
