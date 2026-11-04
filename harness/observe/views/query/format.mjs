// Dinh dang ket qua: table / md / jsonl.
export function formatTable(res) {
  const out = [];
  for (const s of res.sections) {
    if (res.sections.length > 1) out.push(`== ${s.title} ==`);
    if (!s.rows.length) { out.push('(trong)'); continue; }
    const cols = Object.keys(s.rows[0]);
    const cell = (v) => (v === null ? '' : String(v));
    const w = cols.map((c) => Math.max(c.length, ...s.rows.map((r) => cell(r[c]).length)));
    out.push(cols.map((c, i) => c.padEnd(w[i])).join('  '));
    for (const r of s.rows) out.push(cols.map((c, i) => cell(r[c]).padEnd(w[i])).join('  '));
  }
  if (res.truncated) out.push(`truncated: ${res.truncated}`);
  return out.join('\n');
}

export function formatMd(res) {
  if (res.report === 'checkpoint') {
    const sid = res.session_id ? ` (${res.session_id})` : '';
    const out = [`# audit checkpoint${sid}`, ''];
    for (const s of res.sections) {
      out.push(`## ${s.title}`);
      if (!s.rows.length) {
        out.push('- (trong)', '');
        continue;
      }
      for (const r of s.rows) {
        if (s.title === 'last_prompt') {
          out.push(`- [${r.ts || ''}] ${r.actor || 'main'}: ${r.summary || 'prompt'}`);
        } else if (s.title === 'edits_and_commits') {
          out.push(`- [${r.ts || ''}] ${r.tool || ''} ${r.target || ''}${r.ok !== null ? ` (ok: ${r.ok})` : ''}`);
        } else if (s.title === 'errors_and_unresolved') {
          out.push(`- [${r.ts || ''}] ${r.tool || ''} ${r.target || ''} [${r.status || 'error'}]`);
        } else if (s.title === 'stop_summary') {
          out.push(`- [${r.ts || ''}] ${r.summary || r.status || 'stopped'}`);
        } else {
          out.push(`- ${JSON.stringify(r)}`);
        }
      }
      out.push('');
    }
    if (res.truncated) out.push(`truncated: ${res.truncated}`);
    return out.join('\n').trimEnd();
  }
  const out = [`# audit ${res.report}`, ''];
  const cell = (v) => (v === null || v === undefined ? '' : String(v).replace(/\|/g, '\\|').replace(/\s+/g, ' '));
  for (const s of res.sections) {
    out.push(`## ${s.title}`, '');
    if (!s.rows.length) { out.push('(trong)', ''); continue; }
    const cols = Object.keys(s.rows[0]);
    out.push(`| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`);
    for (const r of s.rows) out.push(`| ${cols.map((c) => cell(r[c])).join(' | ')} |`);
    out.push('');
  }
  if (res.truncated) out.push(`truncated: ${res.truncated}`);
  return out.join('\n');
}

export function formatJsonl(res) {
  const out = [];
  for (const s of res.sections) for (const r of s.rows) out.push(JSON.stringify(res.sections.length > 1 ? { _section: s.title, ...r } : r));
  if (res.truncated) out.push(`truncated: ${res.truncated}`);
  return out.join('\n');
}
