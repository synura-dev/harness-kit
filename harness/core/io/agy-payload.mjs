// Hang/ham payload agy dung chung cho adapter (audit o observe, bash-guard). KHONG import audit hay bash-guard (tranh vong).
// VERIFIED (agy 1.4.3, 2026-10-27):
//  - PreToolUse stdout `{}` = deny moi tool -> PHAI in {"decision":"allow"}.
//  - `updatedInput` bi agy chan tool (protojson unknown field) -> KHONG dung.
//  - run_command khong co tham so timeout.
//  - PostToolUse/SessionStart phai in object khong truong la.
export const ALLOW = Object.freeze({ decision: 'allow' });

export const TOOL_MAP = Object.freeze({
  run_command: 'Bash', write_file: 'Write', edit_file: 'Edit', view_file: 'Read', read_file: 'Read',
  call_mcp_tool: 'MCP', invoke_subagent: 'Agent', send_message: 'Agent',
});

/** conversationId || sessionId (bash-guard, khong lay session_id). */
export const getSid = (p) => p && (p.conversationId || p.sessionId);

/** Lenh run_command cua bash-guard: CommandLine ?? commandLine ?? command (KHONG trim/bo rong). */
export const getCommand = (args) => args.CommandLine ?? args.commandLine ?? args.command;

/** pick cua audit: thu khoa dung ten roi khong phan biet hoa thuong; chuoi khong rong, so -> chuoi. */
export function makePick(args) {
  return (...ks) => {
    for (const k of ks) {
      if (typeof args[k] === 'string' && args[k].trim()) return args[k];
      if (typeof args[k] === 'number') return String(args[k]);
    }
    const lk = Object.keys(args);
    for (const k of ks) {
      const found = lk.find((x) => x.toLowerCase() === k.toLowerCase());
      if (found && typeof args[found] === 'string' && args[found].trim()) return args[found];
      if (found && typeof args[found] === 'number') return String(args[found]);
    }
    return undefined;
  };
}
