// Hop dong harness (T0): schema manifest/su kien/config, bang loai, luat import, tran chong rac.
// Thuan: khong I/O, khong import ngoai core (khong cli/plugins/hooks/tools). Nguon: docs/HARNESS-DESIGN.md muc 2.
// Ban rieng, KHONG export: contract.test cam contract.mjs co import; ban dung chung o core/io/paths.mjs.
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Vai tro tang code: kernel lib / lenh kernel / cam bien / extension / cong cu. */
export const LAYERS = Object.freeze(['core', 'ext']);

/** Thu muc cap 1 duoc phep trong harness/ (file: README.md). */
// observe/constrain/evolve/build: vung code nhom moi (HARNESS-DESIGN muc 4), cau truc <vung>/<nhom>/manifest.json.
// skills/ (nguon skill viet tay) va config/ (default commit): chi du lieu, khong code, khong quet registry.
export const TOP_DIRS = Object.freeze(['core', 'cli', 'hooks', 'tools', 'tests',
  'observe', 'constrain', 'evolve', 'build', 'skills', 'config']);
/** Vung code nhom moi (moi thu muc con = mot extension co manifest.json). */
export const GROUP_ZONES = Object.freeze(['observe', 'constrain', 'evolve', 'build']);
export const TOP_FILES = Object.freeze(['README.md']);
/** File duoc phep o goc repo (TOP_FILES chi cho harness/); scan dung de bao repo-clutter. File mo rong (vd TASKS.md cua hub) lay tu config workspace khoa repoRootFiles. Dotfile va *.code-workspace luon duoc phep. */
export const REPO_ROOT_FILES = Object.freeze(['README.md', 'AGENTS.md', 'CLAUDE.md', 'package.json', 'skills-lock.json', 'LICENSE']);


/** Thu tu cau hinh tu thap -> cao (D3): default < may < du an < env < flag. */
export const CONFIG_LAYERS = Object.freeze(['code', 'machine', 'project', 'env', 'flag']);
/** Luat loi (protect) chi duoc tat o tang nay (D3). */
export const CORE_RULE_DISABLE_LAYERS = Object.freeze(['machine']);

/** Vi tri cau hinh theo tang (mau, {tool}/{id}/{TOOL}/{KEY} la placeholder). Cay dich: HARNESS-SLIM muc 3. */
export const CONFIG_PATHS = Object.freeze({
  code: 'harness/<...>/defaults.mjs',          // + hook.config.json khai bao qua manifest.config.defaults (coi la code)
  default: 'config/{tool}/default.json',       // tuy chon, commit
  machine: 'config/{tool}/local.json',         // gitignore
  machineLegacy: 'config/{tool}.local.json',   // fallback 1 vong, canh bao legacy-config
  project: 'config/{tool}/projects/{id}.json',
  example: 'config/{tool}/example.example.json',
  env: 'HARNESS_{TOOL}_{KEY}',
});

/** Canh bao khi doc duong dan cu. */
export const LEGACY_WARNING = 'legacy-config';

/** Chu ky bo nap duy nhat (core/config/config.mjs, S1): loadConfig(tool, opts) -> {config, sources, warnings}; khong throw. */
export const LOAD_CONFIG_SIGNATURE = Object.freeze({
  name: 'loadConfig',
  args: Object.freeze(['tool', 'opts']),
  opts: Object.freeze(['project', 'flags', 'env', 'root']),
  returns: Object.freeze(['config', 'sources', 'warnings']),
});

/** Ten bien env: HARNESS_<TOOL>_<KEY> (camel/kebab -> UPPER_SNAKE). Thuan. */
export function envName(tool, key) {
  const up = (x) => String(x).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  return `HARNESS_${up(tool)}_${up(key)}`;
}

/** Duong dan config theo tang cho tool/id (thuan, khong I/O). Tang khong ro -> ''. */
export function configPath(layer, tool, id = '') {
  const t = CONFIG_PATHS[layer];
  if (typeof t !== 'string') return '';
  return t.replace('{tool}', tool).replace('{id}', id);
}

/** Tran chong rac MAC DINH (ghi de duoc qua resolveCaps / config custom). */
export const DEFAULT_CAPS = Object.freeze({
  filesPerExtension: 12,   // khong tinh test
  flatMax: 8,              // tran so file nguon PHANG moi thu muc harness/** (khong de quy, khong tinh test)
  maxDepth: 2,
  coreModules: 30,         // canh bao (tran core)
  linesPerFile: 500,       // canh bao
  fileMinBytes: 40,
  dataMaxMB: 500,          // canh bao
  viewMaxLines: 40,
  incubatingTtlDays: 7,
  incubatingMaxItems: 20,
  incubatingDescMax: 400,
  retention: Object.freeze({ eventsDays: 30, digestsDays: 90, runsDays: 14, baselinesKeep: 10 }),
});
/** Canh bao mem: file > so dong nay (doctor in [long]; tran cung la linesPerFile). Khong co tran TONG de quy theo vung (HARNESS-SLIM muc 7). */
export const LONG_FILE_SOFT = 400;
/** Alias ngan cho cac tran. */
export const CAPS = DEFAULT_CAPS;

/** Muc do mac dinh cua tung luat chong rac: 'error' | 'warn'. */
export const SEVERITY = Object.freeze({
  topDirs: 'error', filesPerExtension: 'error', flatMax: 'warn', coreModules: 'warn', linesPerFile: 'warn',
  naming: 'error', orphan: 'error', emptyFile: 'error', unusedConfig: 'warn',
  refs: 'error', data: 'error', incubating: 'error', view: 'error', stray: 'error',
});

/** Luat theo loai extension (doctor/junk-check doc de ap dung). */
export const KIND_RULES = Object.freeze({
  hook: Object.freeze(['README', 'defaults-or-hook-config-non-empty', 'test', 'registered-or-none']),
  cli: Object.freeze(['domain-registered', 'uses-out', 'timeout']),
  lib: Object.freeze(['has-importer', 'test']),
  view: Object.freeze(['read-only', 'max-lines-40', 'timeout-flag', 'max-bytes-flag']),
});

/** Huong import: zone nguon -> cac zone dich duoc phep. plugin->plugin va *->plugins bi cam. */
export const IMPORT_RULES = Object.freeze({
  core: Object.freeze(['core']),
  cli: Object.freeze(['core', 'cli']),
  tools: Object.freeze(['core', 'tools']),
  // hooks = composition root duy nhat (Dot 5): dispatcher import module vung nhom de goi handle() (build: hook user-shim); vung nhom van chi core + self (khong vong).
  hooks: Object.freeze(['core', 'hooks/_shared', 'hooks:self', 'observe', 'constrain', 'build']),
  plugins: Object.freeze(['core', 'plugins:self']),
  // vung nhom moi: chi core + chinh nhom minh (<zone>:self = cung thu muc con). build doc skills/ nhu DU LIEU (fs), khong import.
  observe: Object.freeze(['core', 'observe:self']),
  constrain: Object.freeze(['core', 'constrain:self']),
  evolve: Object.freeze(['core', 'evolve:self']),
  build: Object.freeze(['core', 'build:self']),
  tests: Object.freeze(['core', 'cli', 'hooks', 'tools', 'tests', ...GROUP_ZONES]), // test lien vung (harness/tests/)
});

/**
 * Chinh sach test: file *.test.mjs cua mot vung duoc import xuong vung THAP HON hoac CUNG bac
 * (core=0 < cli,tools=1 < hooks,plugins=2), ke ca khac nhom cung vung. Test cua core van chi duoc import core.
 * Test can cheo vung cao hon -> dat o harness/tests/.
 */
const TEST_RANK = Object.freeze({ core: 0, cli: 1, tools: 1, hooks: 2, plugins: 2, observe: 2, constrain: 2, evolve: 2, build: 2 });
/** Vung co nhom (group = thu muc con cap 1). */
const GROUPED = new Set(['hooks', 'plugins', ...GROUP_ZONES]);
const isTestFile = (p) => /\.test\.mjs$/.test(String(p || ''));

/**
 * Phan loai duong dan tuong doi (harness/...) thanh {zone, group, sub}; null neu ngoai harness.
 * zone core/cli/tools gom MOI thu muc con (sub = thu muc con cap 1, null neu file nam o goc zone).
 */
export function zoneOf(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  const parts = p.split('/');
  if (parts[0] !== 'harness' || !TOP_DIRS.includes(parts[1])) return null;
  const zone = parts[1];
  const group = GROUPED.has(zone) && parts[2] ? parts[2] : null;
  const sub = group === null && parts.length > 3 ? parts[2] : null;
  return { zone, group, sub };
}

/** Duong dan tuong doi (tu goc hub) nam trong harness/. */
export function isInHarness(relPath) {
  return String(relPath || '').replace(/\\/g, '/').replace(/^\.?\//, '').split('/')[0] === 'harness';
}

/** Kiem mot import: tra chuoi loi ('' neu hop le). from/to la duong dan tuong doi tu goc hub. */
export function checkImport(from, to) {
  // harness/** khong duoc import ra ngoai harness/ (chan harness -> hub); zoneOf tra null cho duong dan ngoai nen kiem rieng.
  if (isInHarness(from) && String(to || '') && !isInHarness(to)) return 'import harness -> ngoai harness bi cam';
  const a = zoneOf(from);
  const b = zoneOf(to);
  if (!a || !b) return '';
  if (isTestFile(from) && a.zone !== 'core' && a.zone !== 'tests' && b.zone in TEST_RANK && TEST_RANK[b.zone] <= TEST_RANK[a.zone]) return '';
  const allowed = IMPORT_RULES[a.zone] || [];
  const target = b.zone === 'hooks' && b.group === '_shared' ? 'hooks/_shared' : b.zone;
  if (allowed.includes(target)) return '';
  if (allowed.includes(`${a.zone}:self`) && b.zone === a.zone && a.group === b.group) return '';
  return `import ${a.zone}${a.group ? '/' + a.group : ''} -> ${b.zone}${b.group ? '/' + b.group : ''} bi cam`;
}

/** Thu tu quyet dinh gate, manh -> yeu (khop thu tu rule native: deny, roi ask, roi allow). */
export const DECISION_ORDER = Object.freeze(['deny', 'ask', 'allow']);

/** Quyet dinh manh nhat trong danh sach (bo qua gia tri la); undefined neu khong co. Thuan. */
export function strongestDecision(list) {
  let best;
  for (const d of Array.isArray(list) ? list : []) {
    const i = DECISION_ORDER.indexOf(d);
    if (i >= 0 && (best === undefined || i < DECISION_ORDER.indexOf(best))) best = d;
  }
  return best;
}

/**
 * Hop dong module hook cho dispatcher (Dot 5): MOI module `export default { id, events, tools?, timeoutMs, onError, handle }`.
 * handle LA `async handle(event, input, ctx)` (dispatcher luon await). ctx: { write?: boolean, cfg|config?, root?, now?, ... }.
 * ctx.write === false: module KHONG ghi bat ky file nao (audit/gate/log/cache); chi tra `records` de dispatcher ghi.
 * ctx.write khac false (mac dinh; vo main chay truc tiep truyen true): module tu ghi nhu truoc (module thuan khong bao gio ghi, vo main ghi).
 * Ket qua: { decision?, reason?, updatedInput?, additionalContext?, block?, records?: [{sink, data, ctx?, opts?}], record? }.
 * records = viec ghi vet; sink thuoc `sinks`: gate (recordGate(data, ctx||input)), audit (writeEnvelope(data, opts)),
 * guard (them 1 dong JSONL vao nhat ky guard), worktree (them 1 dong vao data/system/worktree/hook.jsonl).
 * record (so it, giu tuong thich) = thong tin tuy module, khong phai de ghi.
 */
export const HOOK_MODULE = Object.freeze({
  required: Object.freeze(['id', 'events', 'timeoutMs', 'onError', 'handle']),
  onError: Object.freeze(['open', 'closed']), // open = loi/timeout bo qua module; closed = deny
  sinks: Object.freeze(['gate', 'audit', 'guard', 'worktree']),
  result: Object.freeze(['decision', 'reason', 'updatedInput', 'additionalContext', 'block', 'records', 'record']),
});

/** Tron tran ghi de (custom) len mac dinh; khoa la/kieu sai bi bo, tra ban moi dong bang. */
export function resolveCaps(overrides) {
  const out = { ...DEFAULT_CAPS, retention: { ...DEFAULT_CAPS.retention } };
  if (!isObj(overrides)) return Object.freeze(out);
  for (const k of Object.keys(DEFAULT_CAPS)) {
    if (k === 'retention') {
      if (isObj(overrides.retention)) {
        for (const r of Object.keys(DEFAULT_CAPS.retention)) {
          const v = overrides.retention[r];
          if (Number.isFinite(v) && v > 0) out.retention[r] = v;
        }
      }
    } else if (Number.isFinite(overrides[k]) && overrides[k] > 0) out[k] = overrides[k];
  }
  out.retention = Object.freeze(out.retention);
  return Object.freeze(out);
}

/** Tang nay co duoc tat luat loi khong (D3). */
export function canDisableCoreRule(layer) {
  return CORE_RULE_DISABLE_LAYERS.includes(layer);
}

/**
 * Ham cap cao duoc phep trung ten (co y; ngoai danh sach nay doctor bao [dup]). Moi muc BAT BUOC {name, files, reason}:
 * chi cho phep khi MOI file trung nam trong files; file moi trung se bi bao. Chi giu khi co ly do ky thuat cung.
 * main/run (diem vao CLI) khong nam day: scanCode bo qua khi file la entry (shebang/process.argv[1]/import.meta.main/isMain).
 */
export const DUP_ALLOW = Object.freeze([
  { name: 'configFiles', files: ['harness/core/config/audit-config.mjs', 'harness/constrain/bash-guard/hook.mjs', 'harness/constrain/guard/hook.mjs', 'harness/constrain/proc-orphans/hook.mjs', 'harness/constrain/worktree/hook.mjs'], reason: 'moi hook doc lap, tro dung hook.config cua chinh no (HERE khac nhau); fail-open, khong import module khac' },
  { name: 'decide', files: ['harness/constrain/bash-guard/hook.mjs', 'harness/constrain/guard/hook.mjs'], reason: 'khac luat: moi hook quyet dinh theo luat rieng; hook doc lap, fail-open, khong import hook khac' },
  { name: 'readStdin', files: ['harness/constrain/guard/hook.mjs', 'harness/constrain/model-policy/hook.mjs'], reason: 'moi hook tu doc stdin voi gioi han/timeout rieng (maxInputBytes, hardTimeoutMs); hook doc lap, fail-open' },
  { name: 'isObj', files: ['harness/core/config/constants.mjs', 'harness/core/io/paths.mjs', 'harness/constrain/guard/hook.mjs'], reason: 'contract.mjs cam import (contract.test) nen giu ban rieng; hook guard doc lap, fail-open; ban dung chung o core/io/paths.mjs' },
  { name: 'log', files: ['harness/constrain/guard/hook.mjs', 'harness/constrain/worktree/hook.mjs'], reason: 'ghi nhat ky rieng cua tung hook; hook doc lap, fail-open, khong import hook khac' },
  { name: 'rel', files: ['harness/core/checks/scan-input.mjs', 'harness/tools/adapters/_util.mjs'], reason: 'tools/adapters khong import core vi sync.test copy rieng tools/ (than ham giong het)' },
  { name: 'handle', files: ['harness/constrain/bash-guard/hook.mjs', 'harness/constrain/bash-guard/adapters/agy.mjs', 'harness/constrain/guard/hook.mjs', 'harness/constrain/model-policy/hook.mjs', 'harness/constrain/proc-orphans/hook.mjs', 'harness/constrain/worktree/hook.mjs', 'harness/observe/audit/audit.mjs', 'harness/observe/audit/adapters/agy.mjs'], reason: 'giao dien chung HOOK_MODULE handle(event, input, ctx) (+ adapter agy cung ten): moi module hook doc lap (cam import hook khac), dispatcher goi cung ten; vinh vien' },
  { name: 'run', files: ['harness/tools/adapters/agy.mjs', 'harness/tools/adapters/claude.mjs'], reason: 'giao dien adapter chung run({root,check}) do sync.mjs goi; khong phai entry CLI' },
]);