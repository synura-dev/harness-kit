// Helper workspace: nut mo coi + nut khong an toan (doctor/scan dung).
import fs from 'node:fs';
import path from 'node:path';
import { isSafeWs } from '../../core/io/node-hook.mjs';

/** Ten thu muc con (chi ten, khong doc file) duoi workspaces/ khong nut nao tro toi. nodes rong/null -> [] (khong co hook thi bo qua rule). */
export function orphanWorkspaces(root, nodes) {
  if (!Array.isArray(nodes) || !nodes.length) return [];
  const mapped = new Set(nodes.map((n) => n && n.workspace));
  let ents = [];
  try { ents = fs.readdirSync(path.join(root, 'workspaces'), { withFileTypes: true }); } catch { return []; }
  return ents.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_') && !mapped.has(e.name)).map((e) => e.name).sort();
}

/** Nut tho tu hook (truoc khi listNodes loc) co workspace khong an toan -> [{id, workspace}]. */
export function unsafeWorkspaceNodes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((n) => n && typeof n === 'object' && n.workspace != null && !isSafeWs(n.workspace)).map((n) => ({ id: String(n.id ?? '').slice(0, 80), workspace: String(n.workspace).slice(0, 80) }));
}

