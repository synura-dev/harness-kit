// harness install: kiem Node/bun, build skill (harness/skills -> .claude/.agents, --adopt), doctor rut gon, in huong dan dang ky hook.
// Mac dinh GHI (apply); --dry-run chi bao. Idempotent (skills build bo qua khi hash khop). KHONG sua .claude/settings.json hay hooks.json.
// Khong import build/skills (IMPORT_RULES build:self = cung nhom con): goi CLI `skills` qua tien trinh con (--json). Doctor cung chay qua tien trinh con co timeout.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DOCTOR_TIMEOUT_MS = 30000;
const SKILLS_CLI = fileURLToPath(new URL('../skills/cli.mjs', import.meta.url));

/** Goi CLI skills (build|check) voi --json; tra du lieu da parse hoac {problems|issues} bao loi (het gio/khong parse duoc). */
function skillsCli(sub, root, args, timeoutS) {
  const r = spawnSync(process.execPath, [SKILLS_CLI, sub, ...args, '--root', root, '--json', '--timeout-s', String(timeoutS)], { encoding: 'utf8', timeout: (timeoutS + 15) * 1000 });
  try { return JSON.parse(String(r.stdout || '')); } catch { /* roi xuong loi */ }
  const why = r.error ? (r.error.code || r.error.message) : `exit ${r.status}`;
  return sub === 'build' ? { items: [], problems: [`skills build khong chay duoc: ${why}`] } : { ok: false, checked: 0, issues: [{ issue: 'skills check khong chay duoc', detail: why }] };
}

/** [{name, ok:true|false|null, detail}] ok=null = tuy chon/khong co. */
export function checkRuntime({ nodeVersion = process.versions.node, bunVersion } = {}) {
  const major = Number(String(nodeVersion).split('.')[0]);
  const out = [{ name: 'node', ok: major >= 18, detail: `${nodeVersion}${major >= 18 ? '' : ' (can >= 18)'}` }];
  let bun = bunVersion;
  if (bun === undefined) {
    const r = spawnSync('bun', ['--version'], { encoding: 'utf8', timeout: 5000, shell: process.platform === 'win32' });
    bun = r.status === 0 ? String(r.stdout).trim() : null;
  }
  out.push({ name: 'bun', ok: bun ? true : null, detail: bun || 'khong co (chi can cho `bun test`; runtime harness chi can Node)' });
  return out;
}

/** Chay doctor that, tra {ok, lines} chi giu dong [MISS]/[LOI]/[warn]; loi/het gio -> ok=false + ly do. */
export function runDoctor(root, { timeoutMs = DOCTOR_TIMEOUT_MS } = {}) {
  const f = path.join(root, 'harness', 'cli', 'commands', 'doctor.mjs');
  if (!fs.existsSync(f)) return { ok: null, lines: ['thieu harness/cli/commands/doctor.mjs'] };
  const r = spawnSync(process.execPath, [f], { cwd: root, encoding: 'utf8', timeout: timeoutMs });
  if (r.error) return { ok: false, lines: [`doctor khong chay duoc: ${r.error.code || r.error.message}`] };
  const lines = String(r.stdout || '').split(/\r?\n/).filter((l) => /^\[(MISS|LOI|warn)\]/.test(l)).slice(0, 15);
  return { ok: r.status === 0, lines };
}

const HOOK_GUIDE = [
  'Dang ky hook (lam tay, install KHONG sua settings):',
  '  1. node harness/cli/commands/doctor.mjs      -> in khoi hooks cho MAY NAY',
  '  2. Dan vao .claude/settings.json (Claude) va .agents/hooks.json (agy), roi: node harness/tools/sync.mjs --check',
];

/**
 * install({root, apply, skipDoctor, runtime, doctor}) -> {apply, steps:[{step, ok, lines[]}], ok}
 * runtime/doctor: ham tiem vao (test). Khong ghi gi ngoai skills build khi apply.
 */
export function install({ root, apply = true, skipDoctor = false, timeoutS = 60, runtime = checkRuntime, doctor = runDoctor } = {}) {
  const steps = [];
  const rt = runtime();
  steps.push({ step: 'runtime', ok: rt.every((x) => x.ok !== false), lines: rt.map((x) => `${x.ok === true ? 'OK  ' : x.ok === false ? 'MISS' : '--  '} ${x.name}: ${x.detail}`) });

  const b = skillsCli('build', root, [...(apply ? ['--apply'] : []), '--adopt'], timeoutS);
  const acts = b.items.filter((i) => i.action !== 'skip');
  const lines = [`${b.items.length} dich, ${acts.length} ${apply ? 'da ghi' : 'se ghi'}, ${b.items.length - acts.length} khop (bo qua)`];
  for (const i of acts) lines.push(`  ${i.action}: ${i.target}`);
  for (const p of b.problems) lines.push(`  LOI: ${p}`);
  if (b.truncated) lines.push(`  truncated: ${b.truncated}`);
  steps.push({ step: 'skills build', ok: !b.problems.length && !b.truncated, lines });

  if (apply) {
    const c = skillsCli('check', root, [], timeoutS);
    steps.push({ step: 'skills check', ok: c.ok, lines: c.ok ? [`sach (${c.checked} cap nguon-dich)`] : c.issues.map((i) => `${i.issue}: ${i.target || i.skill}${i.detail ? ' - ' + i.detail : ''}`) });
  }

  if (skipDoctor) steps.push({ step: 'doctor', ok: null, lines: ['bo qua (--skip-doctor)'] });
  else { const d = doctor(root); steps.push({ step: 'doctor', ok: d.ok, lines: d.lines.length ? d.lines : [d.ok ? 'khong co canh bao' : 'doctor bao loi (xem node harness/cli/commands/doctor.mjs)'] }); }

  steps.push({ step: 'hooks', ok: null, lines: HOOK_GUIDE });
  return { apply, steps, ok: steps.every((s) => s.ok !== false) };
}
