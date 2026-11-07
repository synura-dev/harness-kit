// Duong agy (agy-native: applyWorkspaceEnv) va duong Claude (dispatcher, khong goi applyWorkspaceEnv) phai ra CUNG data root + auditRoot cho mot workspace.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyWorkspaceEnv, dataRoot } from '../../core/io/paths.mjs';
import { auditRoot } from '../../core/audit/audit-write.mjs';

const KEYS = ['CLAUDE_AUDIT_DIR', 'HUB_DATA_DIR', 'HARNESS_CONFIG_DIR', 'CLAUDE_PROJECT_DIR', 'HUB_DIR', 'HARNESS_PLUGIN_DIR'];
const PLUGIN = path.resolve(import.meta.dir, '..', '..', '..');
/** Chay fn voi process.env = nen sach + env, tra ket qua; khoi phuc env. */
function withEnv(env, fn) {
  const saved = { ...process.env };
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try { return fn(); } finally { for (const k of Object.keys(process.env)) delete process.env[k]; Object.assign(process.env, saved); }
}
const roots = (env) => withEnv(env, () => ({ data: path.resolve(dataRoot(null)), audit: path.resolve(auditRoot()) }));
const mkWs = (marker) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-parity-'));
  if (marker) { fs.mkdirSync(path.join(ws, 'config', 'workspace'), { recursive: true }); fs.writeFileSync(path.join(ws, 'config', 'workspace', 'default.json'), '{}'); }
  return ws;
};

for (const marker of [false, true]) {
  test(`parity data dir + auditRoot: agy-native (applyWorkspaceEnv) == dispatcher Claude, workspace ${marker ? 'co' : 'khong co'} dau hieu`, () => {
    const ws = mkWs(marker);
    const agyEnv = { HARNESS_PLUGIN_DIR: PLUGIN, CLAUDE_PROJECT_DIR: ws };
    applyWorkspaceEnv(agyEnv, ws);
    const claudeEnv = { CLAUDE_PROJECT_DIR: ws };
    const a = roots(agyEnv); const c = roots(claudeEnv);
    expect(a.data).toBe(c.data);
    expect(a.audit).toBe(c.audit);
    expect(a.data).toBe(path.resolve(marker ? path.join(ws, 'data') : path.join(ws, '.harness', 'data')));
  });
}
