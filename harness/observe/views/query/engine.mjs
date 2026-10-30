// Engine khai bao cho backend node: checkpoint + runSpec (where/groupBy/aggs/orderBy).
export function runCheckpoint(rows, files, filters, lim, backend) {
  let targetSid = filters.session;
  if (!targetSid) {
    let maxTs = '';
    for (const r of rows) {
      if (r.session_id && r.ts && r.ts > maxTs) {
        maxTs = r.ts;
        targetSid = r.session_id;
      }
    }
  }
  const sessionRows = targetSid ? rows.filter((r) => r.session_id === targetSid) : rows;

  // 1. User Prompt gan nhat
  const promptRows = sessionRows
    .filter((r) => r.event === 'UserPromptSubmit' || r.type === 'prompt')
    .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
    .slice(0, 1)
    .map((r) => ({ ts: r.ts, actor: r.actor, summary: r.summary || 'UserPromptSubmit' }));

  // 2. Git commits / edits gan nhat
  const editLimit = Math.min(filters.limit || 5, 5);
  const editRows = sessionRows
    .filter((r) => {
      if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write_file', 'edit_file'].includes(r.tool)) return true;
      if (r.tool === 'Bash' && r.target && /git\s+commit/i.test(r.target)) return true;
      return false;
    })
    .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
    .slice(0, editLimit)
    .map((r) => ({ ts: r.ts, actor: r.actor, tool: r.tool, target: r.target, ok: r.ok }));

  // 3. Tool call bi loi hoac chua resolve
  const errLimit = Math.min(filters.limit || 5, 5);
  const resolvedIds = new Set(
    sessionRows
      .filter((r) => r.event && r.event.startsWith('PostToolUse') && r.tool_use_id)
      .map((r) => r.tool_use_id)
  );
  const unresolvedPre = sessionRows.filter((r) => {
    if (r.event !== 'PreToolUse' && r.status !== 'started') return false;
    if (r.tool_use_id) return !resolvedIds.has(r.tool_use_id);
    return false;
  });
  const failedCalls = sessionRows.filter((r) => r.ok === false || r.status === 'error' || r.event === 'PostToolUseFailure');

  const errorMap = new Map();
  for (const r of [...unresolvedPre, ...failedCalls]) {
    const k = r.tool_use_id || `${r.tool}-${r.ts}`;
    const status = r.ok === false || r.status === 'error' ? 'error' : 'unresolved';
    errorMap.set(k, { ts: r.ts, actor: r.actor, tool: r.tool, target: r.target, status });
  }
  const errorRows = [...errorMap.values()]
    .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
    .slice(0, errLimit);

  // 4. Stop summary
  const stopRows = sessionRows
    .filter((r) => r.event === 'Stop' || r.event === 'SubagentStop')
    .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
    .slice(0, 1)
    .map((r) => ({
      ts: r.ts,
      actor: r.actor,
      status: r.status,
      turns: r.turns,
      in_tok: r.in_tok,
      out_tok: r.out_tok,
      summary: r.summary,
    }));

  const sections = [
    { title: 'last_prompt', rows: promptRows },
    { title: 'edits_and_commits', rows: editRows },
    { title: 'errors_and_unresolved', rows: errorRows },
    { title: 'stop_summary', rows: stopRows },
  ];

  return { report: 'checkpoint', session_id: targetSid, backend, files: files.length, truncated: lim.truncated, sections };
}

function cond(r, c) {
  const v = r[c.f];
  let res;
  switch (c.op) {
    case 'eq': res = v === c.v; break;
    case 'ne': res = v !== c.v; break;
    case 'notnull': res = v !== null && v !== undefined; break;
    case 'isnull': res = v === null || v === undefined; break;
    case 'in': res = c.v.includes(v); break;
    default: throw new Error('op la: ' + c.op);
  }
  return res || (c.or ? cond(r, c.or) : false);
}
function cmp(a, b, dir) {
  const an = a == null, bn = b == null;
  if (an || bn) return an === bn ? 0 : an ? 1 : -1; // null luon cuoi
  const c = a < b ? -1 : a > b ? 1 : 0;
  return dir === 'desc' ? -c : c;
}
export function runSpec(rows, spec) {
  let r = rows.filter((x) => (spec.where || []).every((c) => cond(x, c)));
  if (spec.groupBy || spec.aggs) {
    const keys = spec.groupBy || [];
    const g = new Map();
    for (const x of r) {
      const k = JSON.stringify(keys.map((c) => x[c]));
      if (!g.has(k)) g.set(k, { first: x, items: [] });
      g.get(k).items.push(x);
    }
    r = [...g.values()].map(({ first, items }) => {
      const o = {};
      for (const c of keys) o[c] = first[c];
      for (const [name, a] of Object.entries(spec.aggs || {})) {
        if (a.fn === 'count') { o[name] = items.length; continue; }
        const vs = items.map((i) => i[a.field]).filter((v) => v != null);
        o[name] = vs.length === 0 ? null : a.fn === 'sum' ? vs.reduce((p, q) => p + q, 0) : vs.reduce((p, q) => (q > p ? q : p));
      }
      return o;
    });
  }
  for (const [col, dir] of [...(spec.orderBy || [])].reverse()) r = r.map((x, i) => [x, i]).sort((p, q) => cmp(p[0][col], q[0][col], dir) || p[1] - q[1]).map((p) => p[0]);
  if (spec.select) r = r.map((x) => Object.fromEntries(spec.select.map((c) => [c, x[c] ?? null])));
  if (spec.limit) r = r.slice(0, spec.limit);
  return r;
}
