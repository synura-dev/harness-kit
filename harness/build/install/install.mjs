// harness install: kiem Node/bun, doctor rut gon, in huong dan dang ky hook.
// Mac dinh GHI (apply); --dry-run chi bao. KHONG sua .claude/settings.json hay hooks.json.
// Doctor chay qua tien trinh con co timeout.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from '../../core/runtime/proc.mjs';
import { fileURLToPath } from 'node:url';
import { REPO_DIR } from '../../core/io/paths.mjs';
import { syncUserShim } from '../../core/runtime/user-shim.mjs';

const DOCTOR_TIMEOUT_MS = 30000;
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
  '  2. Dan vao .claude/settings.json (Claude) va .agents/hooks.json (agy)',
];

/**
 * install({root, apply, skipDoctor, runtime, doctor}) -> {apply, steps:[{step, ok, lines[]}], ok}
 * runtime/doctor: ham tiem vao (test). Khong ghi gi khi apply.
 */
export function install({ root, apply = true, skipDoctor = false, timeoutS = 60, runtime = checkRuntime, doctor = runDoctor } = {}) {
  const steps = [];
  const rt = runtime();
  steps.push({ step: 'runtime', ok: rt.every((x) => x.ok !== false), lines: rt.map((x) => `${x.ok === true ? 'OK  ' : x.ok === false ? 'MISS' : '--  '} ${x.name}: ${x.detail}`) });

  if (skipDoctor) steps.push({ step: 'doctor', ok: null, lines: ['bo qua (--skip-doctor)'] });
  else { const d = doctor(root); steps.push({ step: 'doctor', ok: d.ok, lines: d.lines.length ? d.lines : [d.ok ? 'khong co canh bao' : 'doctor bao loi (xem node harness/cli/commands/doctor.mjs)'] }); }

  steps.push({ step: 'hooks', ok: null, lines: HOOK_GUIDE });
  return { apply, steps, ok: steps.every((s) => s.ok !== false) };
}

/**
 * installShim({dir, apply, force, ...tiem}) -> {ok, dir, files, path, removed, lines[]}: ban tay cua hook SessionStart build/user-shim,
 * cung logic core/runtime/user-shim.mjs syncUserShim (ghi shim, them thu muc vao PATH user, xoa shim cu cua ta). Chay lai khong doi gi.
 */
export function installShim({ dir = null, apply = true, force = false, pluginRoot = REPO_DIR, ...inj } = {}) {
  const s = syncUserShim({ dir: dir && path.resolve(dir), apply, force, pluginRoot, ...inj });
  const lines = [`thu muc: ${s.dir}`, `chay: ${s.cacheDir ? `ban harness-kit moi nhat trong ${s.cacheDir}` : `co dinh ${path.join(pluginRoot, 'bin', 'harness')} (khong thay cache plugin)`}`];
  const verb = { create: apply ? 'tao' : 'se tao', update: apply ? 'cap nhat' : 'se cap nhat', same: 'khop (bo qua)', foreign: 'LOI file la cung ten, khong ghi de (them --force)' };
  for (const f of s.files) lines.push(`  ${verb[f.action]}: ${f.file}`);
  if (s.path) lines.push({ present: `PATH: da co (${s.path.where})`, planned: `PATH: se them vao ${s.path.where}`, added: `PATH: da them vao ${s.path.where} (mo terminal moi de dung)`, error: `LOI PATH (${s.path.where}): ${s.path.error}` }[s.path.state]);
  for (const f of s.removed) lines.push(`  ${apply ? 'da xoa' : 'se xoa'} shim cu: ${f}`);
  if (!s.blocked) lines.push(`go: xoa ${s.files.map((f) => `"${f.file}"`).join(' va ')}; bo ${s.dir} khoi PATH user`);
  return { ...s, lines };
}
