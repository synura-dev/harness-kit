// node harness/cli/harness.mjs adapters [--json]  — bang hook x CLI sinh tu manifest.json cua tung hook (+ doi chieu settings.json / hooks.json).
// --write-readme: sinh bang vao harness/README.md (giua marker GENERATED:adapters).
// --write-arch: sinh khoi cau truc harness vao docs/ARCHITECTURE.md (giua marker generated:begin/end).
// Quy uoc: adapter CLI khac nam o <hook>/adapters/<cli>.mjs; hook.mjs la native (claude). Read-only, chi canh bao (khong fail). Gia tri adapters: native | <duong dan trong thu muc hook> | none | n/a (+note).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommon, emit } from '../harness/core/io/out.mjs';
import { buildReport, formatAdaptersTable, syncReadme } from './adapters-report-core.mjs';
import { syncArchitecture } from '../harness/core/registry/plugin-registry.mjs';

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const t = setTimeout(() => { console.error('truncated: timeout'); process.exit(2); }, 10000);
  const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
  if (process.argv.includes('--write-readme')) {
    const r = syncReadme(root, true);
    console.log(r.problem ? 'LOI: ' + r.problem : r.changed ? 'ghi harness/README.md' : 'harness/README.md da khop');
    clearTimeout(t); process.exit(r.problem ? 1 : 0);
  }
  if (process.argv.includes('--write-arch')) {
    const r = syncArchitecture(root, true);
    console.log(r.problem ? 'LOI: ' + r.problem : r.changed ? 'ghi docs/ARCHITECTURE.md' : 'docs/ARCHITECTURE.md da khop');
    clearTimeout(t); process.exit(r.problem ? 1 : 0);
  }
  const rep = buildReport(root);
  const c = parseCommon(process.argv.slice(2));
  if (c.json || c.raw || c.maxBytes) emit({ summary: formatAdaptersTable(rep.rows) + '\n' + rep.warnings.map((w) => '[warn] ' + w).join('\n'), data: rep }, c);
  else {
    console.log(formatAdaptersTable(rep.rows));
    rep.warnings.forEach((w) => console.log('[warn]', w));
  }
  clearTimeout(t);
}
