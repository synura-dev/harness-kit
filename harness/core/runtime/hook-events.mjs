// harness/core/runtime/hook-events.mjs - 14 su kien hook + timeout (giay) cua dispatcher. matcher '*' cho su kien theo tool.
export const HOOK_EVENTS = [
  ['SessionStart', 30], ['UserPromptSubmit', 4], ['PreToolUse', 3, '*'], ['PostToolUse', 3, '*'], ['PostToolUseFailure', 3, '*'],
  ['PermissionRequest', 3, '*'], ['PermissionDenied', 3, '*'], ['Notification', 3], ['SubagentStart', 3], ['Stop', 20],
  ['SubagentStop', 20], ['SessionEnd', 5], ['WorktreeCreate', 45], ['WorktreeRemove', 30],
];
