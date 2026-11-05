// Backend duckdb (CLI hoac @duckdb/node-api).
import { spawnSync } from '../../../core/runtime/proc.mjs';
import { createRequire } from 'node:module';

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
export function baseSql(files, f) {
  const list = files.map((x) => q(x.path.replace(/\\/g, '/'))).join(', ');
  const w = [];
  if (f.session) w.push('session_id = ' + q(f.session));
  if (f.cli) w.push('cli = ' + q(f.cli));
  if (f.tool) w.push('tool = ' + q(f.tool));
  if (f.event) w.push('event = ' + q(f.event));
  if (f.project) w.push('project = ' + q(f.project));
  if (f.actor) w.push('actor = ' + q(f.actor));
  if (!f.includePhantom) w.push("COALESCE(phantom, 'false') <> 'true'");
  if (f.origin) w.push("COALESCE(origin, 'work') = " + q(f.origin));
  if (f.ok !== undefined && f.ok !== null) w.push('ok = ' + (String(f.ok) === 'true' ? 'true' : 'false'));
  if (f.agent) w.push(f.agent === 'main' ? "actor = 'main'" : `(agent_id = ${q(f.agent)} OR agent_type = ${q(f.agent)})`);
  // v1 + v2 trong 1 lan doc: cot thieu -> NULL; COALESCE gom ten cu/moi.
  return `ev AS (SELECT * FROM (SELECT type::VARCHAR AS type, date::VARCHAR AS date, ts, COALESCE(v, 1) AS v, event,
 COALESCE(sid, session_id) AS session_id,
 COALESCE(agent_id, agent.id) AS agent_id, COALESCE(agent_type, agent.type) AS agent_type,
 COALESCE(actor, CASE WHEN agent IS NULL AND agent_id IS NULL AND agent_type IS NULL THEN 'main' ELSE 'sub' END) AS actor,
 project, cwd, tool, target, target_kind, ok, dur_ms, turns,
 COALESCE(tokens_in, TRY_CAST(json_extract_string(data, '$.input_tokens') AS DOUBLE)) AS in_tok,
 COALESCE(tokens_out, TRY_CAST(json_extract_string(data, '$.output_tokens') AS DOUBLE)) AS out_tok,
 COALESCE(cli, json_extract_string(data, '$.cli'), 'claude') AS cli, TRY_CAST(json_extract_string(data, '$.step_idx') AS DOUBLE) AS step_idx,
 json_extract_string(data, '$.tool_use_id') AS tool_use_id,
 status, model, summary, COALESCE(origin, 'work') AS origin, json_extract_string(data, '$.phantom') AS phantom
 FROM read_json([${list}], format='newline_delimited', hive_partitioning=true, ignore_errors=true,
 columns={v:'INTEGER', ts:'VARCHAR', event:'VARCHAR', cli:'VARCHAR', sid:'VARCHAR', session_id:'VARCHAR', agent:'STRUCT(id VARCHAR, type VARCHAR)', agent_id:'VARCHAR', agent_type:'VARCHAR', actor:'VARCHAR', project:'VARCHAR', cwd:'VARCHAR', tool:'VARCHAR', target:'VARCHAR', target_kind:'VARCHAR', ok:'BOOLEAN', dur_ms:'DOUBLE', turns:'DOUBLE', tokens_in:'DOUBLE', tokens_out:'DOUBLE', status:'VARCHAR', model:'VARCHAR', summary:'VARCHAR', origin:'VARCHAR', data:'JSON'},
 hive_types={'date':'VARCHAR','type':'VARCHAR'})) t ${w.length ? 'WHERE ' + w.join(' AND ') : ''}${f.dedupe === true ? ' QUALIFY row_number() OVER (PARTITION BY cli, session_id, agent_id, tool_use_id, event, tool, target, substr(ts, 1, 19)) = 1' : ''})`;
}
const dbVal = (v) => (typeof v === 'bigint' ? Number(v) : v === undefined ? null : v);
const normRows = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, dbVal(v)])));

let napi;
function loadNapi() {
  if (napi !== undefined) return napi;
  try { napi = createRequire(import.meta.url)('@duckdb/node-api'); } catch { napi = null; }
  return napi;
}
export function duckdbAvailable() {
  try { if (spawnSync('duckdb', ['--version'], { encoding: 'utf8' }).status === 0) return 'cli'; } catch {}
  return loadNapi() ? 'napi' : null;
}
export async function duckRun(kind, sql, lim) {
  const left = lim ? Math.max(1, lim.deadline - Date.now()) : undefined;
  if (kind === 'cli') {
    const p = spawnSync('duckdb', ['-json'], { input: sql + ';' + String.fromCharCode(10), encoding: 'utf8', maxBuffer: lim ? Math.max(1 << 20, lim.maxBytes) : 1 << 28, timeout: left });
    if (p.error && (p.error.code === 'ETIMEDOUT' || p.signal)) { if (lim) lim.truncated = 'timeout'; return []; }
    if (p.error && p.error.code === 'ENOBUFS') { if (lim) lim.truncated = 'max_bytes'; return []; }
    if (p.status !== 0) throw new Error('duckdb cli: ' + p.stderr);
    return normRows(p.stdout.trim() ? JSON.parse(p.stdout) : []);
  }
  const inst = await loadNapi().DuckDBInstance.create(':memory:');
  const con = await inst.connect();
  let timer;
  const work = con.runAndReadAll(sql).then((res) => res.getRowObjects());
  const out = lim ? await Promise.race([work, new Promise((r) => { timer = setTimeout(() => r(null), left); })]) : await work;
  clearTimeout(timer);
  if (out === null) { lim.truncated = 'timeout'; try { con.interrupt?.(); } catch {} work.catch(() => {}); return []; }
  try { con.closeSync?.(); inst.closeSync?.(); } catch {}
  return normRows(out);
}
