// Mac dinh/cau hinh audit nay o core/config/audit-config.mjs (dung chung cho observe/views). Giu duong dan nay cho hook + doctor.
export * from '../../core/config/audit-config.mjs';

// Hook registration data (source of truth; no matcher = none). Used to generate the settings hooks block.
export const hook_events = {
  PreToolUse: { matcher: '*', timeout: 3 }, PostToolUse: { matcher: '*', timeout: 3 }, PostToolUseFailure: { matcher: '*', timeout: 3 },
  SessionStart: { timeout: 3 }, SessionEnd: { timeout: 3 }, Stop: { timeout: 5 }, SubagentStart: { timeout: 3 }, SubagentStop: { timeout: 5 },
  UserPromptSubmit: { timeout: 3 }, PermissionRequest: { matcher: '*', timeout: 3 }, PermissionDenied: { matcher: '*', timeout: 3 }, Notification: { timeout: 3 },
  // Worktree*: do worktree-hook xu ly (ORDER trong hooks/dispatch/modules.mjs khong co audit); timeout khop .claude/settings.json.
  WorktreeCreate: { timeout: 45 }, WorktreeRemove: { timeout: 30 },
};
