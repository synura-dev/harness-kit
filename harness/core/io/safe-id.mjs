// safeId dung chung (audit run_id va ten file data/runs/<id> luon khop nhau) + duong dan runs (data/runs), khong I/O.
import path from 'node:path';
import { workspaceRoot } from './paths.mjs';
import { dataPathFor } from './storage.mjs';
import { dataReadRoots } from '../registry/data-registry.mjs';

// Giu A-Za-z0-9 _ . - ; bo ky tu khac; cat toi da max (mac dinh 80).
export const safeId = (id, max = 80) => String(id ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, max);

export const runsDir = (root = workspaceRoot()) => dataPathFor('runs', { repoDir: root });
/** Cac goc doc runs (moi truoc, legacy sau; chi ton tai). */
export const runsReadDirs = (root = workspaceRoot()) => dataReadRoots('runs', { repoDir: root });
export const logPath = (root, id) => path.join(runsDir(root), `${(safeId(id) || 'run')}.log`);
