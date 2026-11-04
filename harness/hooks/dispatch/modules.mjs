// Bang module + thu tu cho dispatcher (Dot 5.2b). hooks/ = composition root duy nhat: import dong tung module theo su kien (khong nap thua).
// Thu tu moi su kien o ORDER (plan HARNESS-SLIM muc 2). gate:true = module quyet dinh (deny cat chuoi gate sau no; audit van chay).
export const DEFAULTS = {
  enabled: true,
  maxInputBytes: 1048576, // stdin qua tran -> fail-open + ghi vet (khong doc tiep)
  stdinTimeoutMs: 1500,
  // bat/tat module tuy chon: modules.<id>.enabled=false -> bo qua. Mac dinh tat ca BAT. Loi (guard, audit, worktree-hook) khong tat duoc.
  modules: {},
  // tran thoi gian TONG moi su kien (ms), < `timeout` trong settings. Het -> tra phan da co, bo module chua chay.
  budgetsMs: {
    PreToolUse: 2500, PostToolUse: 2500, PostToolUseFailure: 2500, SubagentStart: 2500, PermissionRequest: 2500, PermissionDenied: 2500,
    Notification: 2500, SessionEnd: 2500, UserPromptSubmit: 2800, Stop: 14000, SubagentStop: 14000, SessionStart: 27000,
    WorktreeCreate: 42000, WorktreeRemove: 27000,
  },
};

const AUDIT = { id: 'audit', load: () => import('../../observe/audit/audit.mjs') };
const GUARD = { id: 'guard', gate: true, load: () => import('../../constrain/guard/hook.mjs') };
const DATA_GATE = { id: 'data-gate', gate: true, load: () => import('../../constrain/data-gate/hook.mjs') };
const APPROVAL = { id: 'approval', gate: true, load: () => import('../../constrain/approval/hook.mjs') };
const BASH_GUARD = { id: 'bash-guard', gate: true, load: () => import('../../constrain/bash-guard/hook.mjs') };
const MODEL_POLICY = { id: 'model-policy', gate: true, load: () => import('../../constrain/model-policy/hook.mjs') };
const VERIFY_GATE = { id: 'verify-gate', load: () => import('../../constrain/verify-gate/hook.mjs') };
const PROC_ORPHANS = { id: 'proc-orphans', load: () => import('../../constrain/proc-orphans/hook.mjs') };
const DATA_CHECK = { id: 'data-check', load: () => import('../../observe/data-check/hook.mjs') };
const WORKTREE = { id: 'worktree-hook', load: () => import('../../constrain/worktree/hook.mjs') };
const USER_SHIM = { id: 'user-shim', load: () => import('../../build/user-shim/hook.mjs') };
const DIFF_REVIEW = { id: 'diff-review', load: () => import('../../observe/diff-review/hook.mjs') };

/** su kien -> danh sach entry theo thu tu chay. Su kien khong co = dispatcher in {} (khong lam gi). */
export const OPTIONAL = Object.freeze(['data-check', 'proc-orphans', 'model-policy', 'verify-gate', 'user-shim']);

export const ORDER = Object.freeze({
  PreToolUse: [GUARD, DATA_GATE, APPROVAL, BASH_GUARD, MODEL_POLICY, AUDIT],
  PostToolUse: [AUDIT, DATA_CHECK],
  PostToolUseFailure: [AUDIT],
  PermissionRequest: [AUDIT],
  PermissionDenied: [AUDIT],
  Notification: [AUDIT],
  SubagentStart: [AUDIT, DIFF_REVIEW],
  SessionEnd: [AUDIT],
  Stop: [AUDIT, VERIFY_GATE, PROC_ORPHANS],
  SubagentStop: [AUDIT, VERIFY_GATE, PROC_ORPHANS],
  SessionStart: [AUDIT, WORKTREE, DATA_CHECK, USER_SHIM],
  UserPromptSubmit: [AUDIT],
  WorktreeCreate: [WORKTREE],
  WorktreeRemove: [WORKTREE],
});


/** Nap module cua mot su kien: [{id, gate, mod}]; module loi nap/khong hop le -> {id, gate, error}. Khong nem. */
export async function loadModules(event, { only = '', validate, order = ORDER, modules = {} } = {}) {
  const out = [];
  for (const e of order[event] || []) {
    if (only && e.id !== only) continue;
    if (OPTIONAL.includes(e.id) && modules && modules[e.id] && modules[e.id].enabled === false) continue;
    try {
      const mod = (await e.load()).default;
      const errs = typeof validate === 'function' ? validate(mod) : [];
      out.push(errs.length ? { id: e.id, gate: !!e.gate, error: 'bad-module' } : { id: e.id, gate: !!e.gate, mod });
    } catch { out.push({ id: e.id, gate: !!e.gate, error: 'load-failed' }); }
  }
  return out;
}

/** Module co ung voi su kien + ten tool khong (events + tools regex). */
export function applies(mod, event, input) {
  if (!mod || !Array.isArray(mod.events) || !mod.events.includes(event)) return false;
  if (mod.tools instanceof RegExp) {
    const t = input && typeof input.tool_name === 'string' ? input.tool_name : '';
    if (!mod.tools.test(t)) return false;
  }
  return true;
}
