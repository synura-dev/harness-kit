// Phia cha (cong/CLI) chay external: KHONG import code external; spawn ext-runner o tien trinh con co timeout + tran output.
// Moi loi (throw, exit != 0, treo, rac, manifest hong, thieu plugin) bi bat -> 1 dong audit source ext:<id> status ext-fail + ma loi; core khong anh huong.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditExt, ctxCompatible, CTX_VERSION, hash8, normalizeDataEntries } from './ctx.mjs';
import { manifestDomains } from './manifest-domains.mjs';
import { hkerrLine } from '../io/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HARNESS_DIR = path.resolve(HERE, '..', '..');
export const EXT_LIMITS = Object.freeze({ maxManifests: 40, timeoutS: 30, maxBytes: 262144 });
// Ma thoat ro rang cho lenh goi.
export const EXIT = Object.freeze({ MISSING_CORE: 3, BAD_MANIFEST: 64, BAD_OUTPUT: 65, FAIL: 70, TIMEOUT: 124, OVERFLOW: 125, BLOCKED: 66 });

/** External chua duyet / hash lech: CHAN, khong chay. exit 66, in lenh duyet lai, audit status ext-blocked. KHONG nem. */
export function blockExternal(ext, domain, status = 'drift') {
  const why = status === 'unregistered' ? 'chua dang ky' : status === 'id-mismatch' ? 'id manifest khac id dang ky' : 'hash lech/chua duyet';
  auditExt(ext.id, { ok: false, event: 'run', status: 'ext-blocked', target: domain, error: `blocked: ${why}`, data: { exit: EXIT.BLOCKED, reason: status } });
  return { code: EXIT.BLOCKED, status: 'blocked', stdout: '', stderr: `ext ${ext.id}/${domain}: CHAN (${why}). Kiem tra code roi chay: harness ext approve ${ext.id}\n` };
}



const readJsonSafe =(f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const isUnder = (p, root) => { const r = path.relative(root, p); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

/**
 * list: [{id?, root(abs), workspaces?}] (danh sach tuong minh; chua co ext register). coreDomains: Set/obj ten domain cua core.
 * -> { byDomain: {domain: {ext, entry, caps, id}}, errors: [] }. Domain trung core: core thang, ext bi tu choi. Trung giua 2 ext: tu choi ca ban sau.
 */
export function loadExternals(list, { coreDomains = {}, limits = {} } = {}) {
  const lim = { ...EXT_LIMITS, ...limits };
  const core = coreDomains instanceof Set ? coreDomains : new Set(Object.keys(coreDomains || {}));
  const byDomain = {}; const errors = []; const blocked = {};
  let n = 0;
  for (const item of Array.isArray(list) ? list : []) {
    const id0 = String(item && (item.id || path.basename(String(item.root || '?'))) || '?');
    const bad = (why) => { errors.push(`ext ${id0}: ${why}`); auditExt(id0, { ok: false, event: 'manifest', status: 'ext-fail', error: `manifest: ${why}` }); };
    try {
      if (!item || typeof item.root !== 'string' || !path.isAbsolute(item.root)) { bad('root phai la duong dan tuyet doi'); continue; }
      if (++n > lim.maxManifests) { errors.push(`truncated: toi da ${lim.maxManifests} external`); break; }
      let m;
      try { m = readJsonSafe(path.join(item.root, 'manifest.json')); } catch (e) { bad(`doc manifest loi (${String(e.message).slice(0, 80)})`); continue; }
      if (!m || typeof m !== 'object' || typeof m.entry !== 'string' || !manifestDomains(m).length) { bad('thieu entry/domains'); continue; }
      // id lay tu dang ky (item.id), KHONG tu manifest tu khai: manifest khai id khac => CHAN (66) moi domain no khai, khong chay.
      if (item.id && m.id !== item.id) {
        bad(`id manifest "${String(m.id).slice(0, 40)}" khac id dang ky`);
        for (const d of manifestDomains(m)) if (!blocked[String(d)]) blocked[String(d)] = { id: String(item.id), root: path.resolve(item.root), reason: 'id-mismatch' };
        continue;
      }
      const id = String(item.id || m.id || id0);
      if (!ctxCompatible(m.requires && m.requires.ctx)) { bad(`can ctx ${m.requires.ctx}, loi co ${CTX_VERSION}`); continue; }
      const entry = path.resolve(item.root, m.entry);
      if (m.entry.split(/[\\/]/).includes('..') || !isUnder(entry, path.resolve(item.root))) { bad('entry ra ngoai root'); continue; }
      const dataDecl = normalizeDataEntries(Array.isArray(m.data) ? m.data : null, id);
      for (const er of dataDecl.errors) errors.push(`ext ${id}: data: ${er}`);
      const dataList = Array.isArray(m.data) ? m.data.filter((x) => x && typeof x === 'object') : undefined;
      for (const d of manifestDomains(m)) {
        const dn = String(d);
        if (core.has(dn)) { errors.push(`ext ${id}: domain ${dn} trung core (core thang)`); continue; }
        if (byDomain[dn]) { errors.push(`ext ${id}: domain ${dn} trung ext ${byDomain[dn].id}`); continue; }
        byDomain[dn] = { id, root: path.resolve(item.root), entry, caps: Array.isArray(m.caps) ? m.caps : undefined, data: dataList, workspaces: item.workspaces };
      }
    } catch (e) { bad(String(e.message).slice(0, 80)); }
  }
  return { byDomain, errors, blocked };
}

/**
 * Chay 1 domain external trong tien trinh con. KHONG nem. -> { code, stdout, stderr, status }.
 * opts: timeoutS, maxBytes, coreDir (mac dinh harness/ nay; thieu -> exit 3), workspace, json (kiem stdout la JSON).
 */
/** Hop dong loi cho tung ly do ext-fail: { code, fix_command, next_step, safe }. */
export function extErr(status, ext, domain, { timeoutS = EXT_LIMITS.timeoutS, maxBytes = EXT_LIMITS.maxBytes } = {}) {
  const id = ext && ext.id;
  const T = {
    'missing-core': ['HK_EXT_MISSING_CORE', 'claude plugin install harness-kit', 'cai plugin harness-kit (hoac dat HARNESS_DIR tro toi harness/) roi chay lai'],
    'bad-entry': ['HK_EXT_BAD_ENTRY', `harness ext list`, `sua "entry" trong manifest.json cua ext ${id} roi chay: harness ext approve ${id}`],
    timeout: ['HK_EXT_TIMEOUT', `harness ${domain} --timeout-s ${timeoutS * 2}`, 'tang --timeout-s hoac thu hep pham vi lenh'],
    'output-overflow': ['HK_EXT_OVERFLOW', `harness ${domain} --help`, `output vuot ${maxBytes} byte: loc/thu hep output (them bo loc, gioi han dong)`],
    'bad-output': ['HK_EXT_BAD_OUTPUT', `harness ${domain} --raw`, `ext ${id} phai in JSON hop le khi --json; xem output bang --raw`],
    exit: ['HK_EXT_EXIT', `harness ${domain} --raw`, `xem stderr cua ext ${id}; sua loi trong ext roi chay lai`],
    'spawn-error': ['HK_EXT_SPAWN', 'harness doctor', 'chay harness doctor kiem node/plugin'],
    'host-error': ['HK_EXT_HOST', 'harness doctor', 'chay harness doctor; neu lap lai, bao loi plugin'],
  };
  const [code, fix_command, next_step] = T[status] || ['HK_EXT_FAIL', 'harness doctor', 'chay harness doctor'];
  return { code, fix_command, next_step, safe: true };
}

export function runExternal(ext, domain, argv = [], opts = {}) {
  const t0 = Date.now();
  const timeoutS = opts.timeoutS || EXT_LIMITS.timeoutS;
  const maxBytes = opts.maxBytes || EXT_LIMITS.maxBytes;
  const fail = (code, status, why, extra = {}) => {
    const k = extErr(status, ext, domain, { timeoutS, maxBytes });
    auditExt(ext.id, { ok: false, event: 'run', status: 'ext-fail', target: domain, ms: Date.now() - t0, error: `${status}: ${why}`, data: { exit: code, reason: status, code: k.code, fix_command: k.fix_command, next_step: k.next_step } });
    const line = hkerrLine(k.code, `${status}: ${why}`, { severity: 'error', fix_command: k.fix_command, next_step: k.next_step, safe: k.safe, source: `ext:${ext.id}/${domain}` });
    return { code, status, stdout: extra.stdout || '', stderr: `${line}\next ${ext.id}/${domain}: ${status}: ${why}. Tiep: ${k.next_step}\n${extra.stderr || ''}`.slice(0, 2000) };
  };
  try {
    const coreDir = opts.coreDir || HARNESS_DIR;
    const runner = path.join(coreDir, 'cli', 'ext-runner.mjs');
    if (!fs.existsSync(runner) || !fs.existsSync(path.join(coreDir, 'core', 'ext', 'ctx.mjs'))) {
      return fail(EXIT.MISSING_CORE, 'missing-core', 'khong thay plugin harness; cai plugin harness hoac dat HARNESS_DIR roi chay lai (exit 3)');
    }
    if (!fs.existsSync(ext.entry)) return fail(EXIT.BAD_MANIFEST, 'bad-entry', 'entry khong ton tai');
    const args = [runner, '--ext', ext.id, '--entry', ext.entry, '--root', ext.root, '--domain', domain];
    if (opts.workspace) args.push('--workspace', opts.workspace);
    if (ext.caps) args.push('--caps', ext.caps.join(','));
    if (Array.isArray(ext.data) && ext.data.length) args.push('--data', JSON.stringify(ext.data));
    args.push('--', ...argv.map(String));
    // Qua ext-supervisor: no tu timeout/tran output va giet CA CAY (taskkill /T tren win32, process group tren posix).
    // spawnSync timeout/maxBuffer chi con la luoi du phong (giet supervisor).
    const sup = path.join(HERE, 'ext-supervisor.mjs');
    const r = spawnSync(process.execPath, [sup, String(timeoutS * 1000), String(maxBytes), ...args], { encoding: 'utf8', timeout: timeoutS * 1000 + 15000, maxBuffer: maxBytes + 65536, killSignal: 'SIGKILL', windowsHide: true, env: { ...process.env, HARNESS_EXT: ext.id } });
    const supMark = (why) => String(r.stderr || '').includes(`[ext-supervisor] ${why}`);
    if (r.status === 124 && supMark('timeout')) return fail(EXIT.TIMEOUT, 'timeout', `qua ${timeoutS}s (truncated: timeout)`);
    if (r.status === 125 && supMark('overflow')) return fail(EXIT.OVERFLOW, 'output-overflow', `output > ${maxBytes} byte`);
    if (r.error) {
      if (r.error.code === 'ETIMEDOUT') return fail(EXIT.TIMEOUT, 'timeout', `qua ${timeoutS}s (truncated: timeout)`);
      if (r.error.code === 'ENOBUFS') return fail(EXIT.OVERFLOW, 'output-overflow', `output > ${maxBytes} byte`);
      return fail(EXIT.FAIL, 'spawn-error', String(r.error.message).slice(0, 120));
    }
    if (r.status !== 0) return fail(r.status === null ? EXIT.FAIL : r.status, 'exit', `thoat ${r.status} ${String(r.stderr || '').trim().split('\n').slice(-1)[0].slice(0, 160)}`, { stdout: r.stdout });
    if (opts.json) { try { JSON.parse(r.stdout); } catch { return fail(EXIT.BAD_OUTPUT, 'bad-output', `stdout khong phai JSON (${hash8(r.stdout)})`); } }
    auditExt(ext.id, { ok: true, event: 'run', status: 'ext-ok', target: domain, ms: Date.now() - t0 });
    return { code: 0, status: 'ok', stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return fail(EXIT.FAIL, 'host-error', String(e.message).slice(0, 120));
  }
}
