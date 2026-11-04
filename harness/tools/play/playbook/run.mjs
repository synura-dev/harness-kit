// Playbook run: executor chinh, persist log, format ket qua, prune data/play.
import fs from 'node:fs';
import path from 'node:path';
import { workspaceRoot, isInside, dataRoot } from '../../../core/io/paths.mjs';
import { guardWrite, dataPathFor } from '../../../core/io/storage.mjs';
import { dataReadRoots } from '../../../core/registry/data-registry.mjs';
import { loadConfig } from '../../../core/config/config.mjs';
import { scriptOutsideHub } from './policy.mjs';
import { DEFAULT_LIMITS, EXIT, RETENTION_DAYS, CAPTURE_SAFE, resolveParams, subst, buildArgv } from './schema.mjs';
import { resolveSpawn, execStep, summarizeOutput, runCapture, clip } from './exec.mjs';

const RUNS_CAP = 5 * 1024 * 1024;

const newRunId = (name) => `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${name}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * Chay playbook. opts: {params, yes, dryRun, timeoutS, maxOutputBytes, hub, lookup, now}
 * @returns {Promise<{result, exitCode}>}  (nem PlaybookError khi param sai)
 */
export async function runPlaybook(pb, opts = {}) {
  const hub = opts.hub || workspaceRoot();
  const limits = { ...DEFAULT_LIMITS, ...(pb.limits || {}) };
  const timeoutS = opts.timeoutS || limits.timeout_s;
  const maxBytes = opts.maxOutputBytes || limits.max_output_bytes;
  const params = resolveParams(pb, opts.params || {}, opts.now);
  const hasMutating = pb.steps.some((s) => s.mutating);
  const allowMutating = !!opts.yes && !opts.dryRun;
  const planOnly = !!opts.dryRun;
  const runId = newRunId(pb.name);
  const t0 = Date.now();
  const deadline = t0 + timeoutS * 1000;
  const steps = [];
  const status = {};
  const caps = {};
  const fullOut = {};
  let escalate = null, final = null, truncated = null, skippedMutating = 0, warnings = 0;

  for (const s of pb.steps) {
    const rec = { id: s.id, status: 'skip', exit: null, ms: 0, summary: [] };
    steps.push(rec);
    status[s.id] = 'skip';
    if (final) { rec.summary = ['bo qua: playbook da dung']; continue; }
    if (s.when && planOnly) {
      rec.status = 'plan'; status[s.id] = 'plan';
      rec.summary = [clip(`conditional (when ${s.when.step}=${s.when.status}): ` + s.run.join(' '))];
      if (s.mutating) skippedMutating++;
      continue;
    }
    if (s.when && status[s.when.step] !== s.when.status) { rec.summary = [`bo qua: when ${s.when.step}=${status[s.when.step]} != ${s.when.status}`]; continue; }
    const b = buildArgv(s, params, caps);
    if (b.missing && planOnly && b.missing.startsWith('capture.')) { rec.status = 'plan'; status[s.id] = 'plan'; rec.summary = [clip('conditional (can ' + b.missing + '): ' + s.run.join(' '))]; if (s.mutating) skippedMutating++; continue; }
    if (b.missing) { rec.summary = [`bo qua: thieu \${${b.missing}}`]; continue; }
    if (b.error) { rec.status = 'fail'; status[s.id] = 'fail'; rec.summary = [b.error]; final = 'FAIL'; continue; }
    if (planOnly) { rec.status = 'plan'; rec.summary = [clip(b.argv.join(' '))]; status[s.id] = 'plan'; if (s.mutating) skippedMutating++; continue; }
    if (s.mutating && !allowMutating) { rec.status = 'skip'; rec.summary = ['dry-run: buoc mutating can --yes: ' + clip(b.argv.join(' '), 120)]; skippedMutating++; continue; }
    const remaining = deadline - Date.now();
    if (remaining <= 0) { final = 'TIMEOUT'; truncated = 'timeout'; rec.status = 'timeout'; status[s.id] = 'timeout'; rec.summary = ['het gioi han thoi gian playbook']; continue; }
    // cwd
    let cwd = hub;
    if (s.cwd) {
      const c = subst(s.cwd, params, caps);
      if (c.missing || c.error || Array.isArray(c.value)) { rec.summary = ['bo qua: cwd khong giai quyet duoc']; continue; }
      cwd = path.resolve(hub, c.value);
      if (!isInside(cwd, hub)) { rec.status = 'fail'; status[s.id] = 'fail'; rec.summary = ['cwd nam ngoai hub']; final = 'FAIL'; continue; }
    }
    const outside = scriptOutsideHub(b.argv, cwd, hub);
    if (outside) { rec.status = 'fail'; status[s.id] = 'fail'; rec.summary = [outside]; final = 'FAIL'; continue; }
    const sp = resolveSpawn(b.argv, { lookup: opts.lookup });
    const stepStart = Date.now();
    const stepTimeout = Math.min((s.timeout_s || timeoutS) * 1000, remaining);
    let r;
    if (sp.error) r = { exit: null, timedOut: false, error: sp.error, stdout: '', stderr: '', truncated: false };
    else r = await execStep({ cmd: sp.cmd, args: sp.args, cwd, env: { ...process.env, HUB_DIR: hub }, timeoutMs: stepTimeout, maxBytes });
    rec.ms = Date.now() - stepStart;
    rec.exit = r.exit;
    if (r.truncated && !truncated) truncated = 'output';
    const combined = r.stdout + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : '');
    fullOut[s.id] = { cmd: b.argv.join(' '), text: combined };
    let failReason = null;
    if (r.error) failReason = r.error;
    else if (r.timedOut) failReason = 'timeout';
    else {
      const e = s.expect || {};
      if (r.exit !== (e.exit ?? 0)) failReason = `exit ${r.exit} (mong doi ${e.exit ?? 0})`;
      else if (e.stdout_includes !== undefined && !r.stdout.includes(e.stdout_includes)) failReason = 'stdout thieu chuoi mong doi';
      else if (e.stdout_regex !== undefined && !new RegExp(e.stdout_regex).test(r.stdout)) failReason = 'stdout khong khop regex';
    }
    if (!failReason && s.capture) {
      const c = runCapture(s.capture, r.stdout);
      if (c.error) failReason = c.error;
      else if (!CAPTURE_SAFE.test(c.value)) failReason = 'gia tri capture chua ky tu khong an toan/qua dai';
      else caps[s.capture.name] = c.value;
    }
    rec.summary = summarizeOutput(combined, s.summarize);
    if (failReason && !rec.summary.length) rec.summary = [clip(failReason)];
    else if (failReason) rec.summary.unshift(clip(`[${failReason}]`));
    const max = s.summarize?.max_lines ?? 5;
    rec.summary = rec.summary.slice(0, max);
    if (!failReason) { rec.status = 'pass'; status[s.id] = 'pass'; continue; }
    rec.status = r.timedOut ? 'timeout' : 'fail';
    status[s.id] = rec.status;
    const onFail = s.on_fail || 'stop';
    if (onFail === 'continue') { warnings++; continue; }
    if (onFail === 'escalate') {
      final = 'ESCALATE';
      escalate = { step: s.id, reason: clip(failReason), summary: rec.summary.join('\n') };
    } else final = r.timedOut ? 'TIMEOUT' : 'FAIL';
    if (r.timedOut && !truncated) truncated = 'timeout';
  }
  if (!final) final = (planOnly || skippedMutating) ? 'DRYRUN' : warnings ? 'PASS_WITH_WARNINGS' : 'PASS';
  const durationMs = Date.now() - t0;
  const logRel = path.relative(hub, path.join(dataPathFor('play', { repoDir: hub }), `${runId}.json`)).split(path.sep).join('/');
  const result = {
    playbook: pb.name, status: final,
    steps: steps.map(({ id, status: st, exit, ms, summary: sm }) => ({ id, status: st, exit, ms, summary: sm })),
    escalate, truncated, warnings, skipped_mutating: skippedMutating, notes: [], log: logRel,
  };
  persist({ hub, runId, pb, result, fullOut, params, durationMs, maxBytes, opts: { yes: !!opts.yes, dryRun: planOnly, hasMutating } });
  return { result, exitCode: EXIT[final] };
}

function persist({ hub, runId, pb, result, fullOut, params, durationMs, maxBytes, opts }) {
  try {
    const dir = dataPathFor('play', { repoDir: hub });
    if (!guardWrite(path.join(dir, `${runId}.json`)).ok) return; // enforce: bo qua ghi
    fs.mkdirSync(path.join(dir, runId), { recursive: true });
    for (const [id, o] of Object.entries(fullOut)) {
      const body = `$ ${o.cmd}\n${o.text}`;
      const buf = Buffer.from(body, 'utf8');
      fs.writeFileSync(path.join(dir, runId, `${id}.txt`), buf.length > maxBytes ? buf.subarray(0, maxBytes).toString('utf8') + '\n[cat bot]\n' : body, 'utf8');
    }
    fs.writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify({ run_id: runId, ts: new Date().toISOString(), params: Object.keys(params), ...opts, duration_ms: durationMs, ...result }, null, 2) + '\n', 'utf8');
    const runs = path.join(dir, 'runs.jsonl');
    let size = 0; try { size = fs.statSync(runs).size; } catch {}
    if (size >= RUNS_CAP) result.notes.push(`runs.jsonl dat tran ${RUNS_CAP} byte: khong ghi them (xoa/xoay file tay)`);
    else {
      const line = { v: 1, ts: new Date().toISOString(), run_id: runId, type: 'playbook', playbook: pb.name, status: result.status, steps: result.steps.length, dry_run: opts.dryRun || (opts.hasMutating && !opts.yes), model_calls: 0, duration_ms: durationMs };
      fs.appendFileSync(runs, JSON.stringify(line) + '\n', 'utf8');
    }
  } catch (e) { result.log = null; result.persist_error = clip(e.message, 100); }
}

/** JSON hop le, ngan: moi buoc 1 dong => <= 25 dong khi so buoc <= ~15. */
export function formatResult(r) {
  const head = { playbook: r.playbook, status: r.status };
  const lines = ['{', ` "playbook": ${JSON.stringify(head.playbook)}, "status": ${JSON.stringify(head.status)},`, ' "steps": ['];
  r.steps.forEach((s, i) => lines.push(`  ${JSON.stringify(s)}${i < r.steps.length - 1 ? ',' : ''}`));
  lines.push(' ],', ` "escalate": ${JSON.stringify(r.escalate)},`, ` "truncated": ${JSON.stringify(r.truncated)}, "warnings": ${r.warnings ?? 0}, "skipped_mutating": ${r.skipped_mutating ?? 0}${r.persist_error ? `, "persist_error": ${JSON.stringify(r.persist_error)}` : ''}${r.notes && r.notes.length ? `, "notes": ${JSON.stringify(r.notes)}` : ''},`, ` "log": ${JSON.stringify(r.log)}`, '}');
  return lines.join('\n');
}

/** Don dep data/play: xoa log cu hon `days` ngay (theo mtime). Mac dinh chi liet ke (dry-run); yes=true moi xoa. Chi dong ten runId hop le. */
export function prunePlayRuns({ hub = workspaceRoot(), days, yes = false, now = Date.now(), maxEntries = 5000 } = {}) {
  let d = days;
  if (d === undefined) {
    // S7: qua loader (config/play/default.json, local.json, HARNESS_PLAY_RETENTION_DAYS); config/play.json chet da bo.
    const c = loadConfig('play', { root: hub, defaults: { retention_days: RETENTION_DAYS } }).config;
    d = Number.isInteger(c.retention_days) && c.retention_days >= 1 ? c.retention_days : RETENTION_DAYS;
  }
  const dirs = dataReadRoots('play', { repoDir: hub });
  const cutoff = now - d * 86400000;
  const RUN = /^[0-9]{14}-[a-z0-9-]+-[a-z0-9]{4}(\.json)?$/;
  const out = { mode: yes ? 'delete' : 'dry-run', days: d, candidates: 0, deleted: 0, truncated: null };
  let names = [];
  for (const dir of dirs) { try { for (const n of fs.readdirSync(dir)) names.push([dir, n]); } catch {} }
  if (names.length > maxEntries) { names = names.slice(0, maxEntries); out.truncated = 'entries'; }
  for (const [dir, n] of names) {
    if (!RUN.test(n)) continue;
    const p = path.join(dir, n);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.mtimeMs >= cutoff) continue;
    out.candidates++;
    if (yes) { try { fs.rmSync(p, { recursive: true, force: true }); out.deleted++; } catch {} }
  }
  return out;
}
