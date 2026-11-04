// Ghi envelope audit (layout v2) + goc du lieu audit. Dung chung cho hooks khac, khong phu thuoc hooks/audit.
import fs from 'node:fs';
import path from 'node:path';
import { guardWrite, dataPathFor } from '../io/storage.mjs';
import { ensureDataIgnore } from '../io/paths.mjs';
import { dataReadRoots } from '../registry/data-registry.mjs';

// Goc GHI: CLAUDE_AUDIT_DIR (compat) || path dang ky cua key 'audit' (registry).
export const auditRoot = () => process.env.CLAUDE_AUDIT_DIR || dataPathFor('audit', { quiet: true });
// Cac goc DOC (moi + legacy, chi goc ton tai). CLAUDE_AUDIT_DIR dat thi chi goc do.
export const auditReadRoots = () => {
  if (process.env.CLAUDE_AUDIT_DIR) return [process.env.CLAUDE_AUDIT_DIR];
  const r = dataReadRoots('audit');
  return r.length ? r : [auditRoot()];
};

// Layout v2: <root>/date=YYYY-MM-DD/type=<type>/<sid>.jsonl
const MAX_PARTS = 50; // tran so file phan vung moi (ngay,type,sid)
export function partitionFile(root, env, max, add = 0) {
  const dir = path.join(root, `date=${env.ts.slice(0, 10)}`, `type=${env.type}`);
  ensureDataIgnore(); fs.mkdirSync(dir, { recursive: true });
  for (let n = 0; n < MAX_PARTS; n++) {
    const f = path.join(dir, n === 0 ? `${env.sid}.jsonl` : `${env.sid}.${n}.jsonl`);
    try { const sz = fs.statSync(f).size; if (sz === 0 || sz + add <= max) return f; } catch { return f; }
  }
  return path.join(dir, `${env.sid}.${MAX_PARTS - 1}.jsonl`); // het cho: writeEnvelope tu choi ghi them
}

export function writeEnvelope(env, cfg, root = auditRoot()) {
  const max = cfg.max_file_bytes || 5242880;
  const line = JSON.stringify(env) + '\n';
  const len = Buffer.byteLength(line);
  const f = partitionFile(root, env, max, len);
  try { const sz = fs.statSync(f).size; if (sz > 0 && sz + len > max) return; } catch {} // kiem lai ngay truoc append
  guardWrite(f); // audit luon chi warn (checkWrite ha enforce->warn)
  fs.appendFileSync(f, line);
}
