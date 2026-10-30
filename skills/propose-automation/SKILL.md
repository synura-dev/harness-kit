---
name: propose-automation
description: Decide when and how to create a hook or schedule so the hub improves itself. Use when the user says "from now on / every time X", when the same manual step has repeated about 3 times, or when a recorded fact needs periodic re-checking.
---

# Propose Automation

Create hooks and schedules on demand, not in advance. Propose first; never install silently.

## Steps

1. **Trigger.** One of: the user states a standing rule ("from now on when X": needs a hook, memory alone cannot enforce it); a manual step repeated about 3 times; an unconfirmed or aging fact in memory.
2. **Pick the mechanism** (verified 2026-10-20, see memory `hooks-and-scheduling-facts`; re-check if the docs may have changed):
   - React to an event, e.g. session end or before a tool call: hook in settings.json.
   - Recurring, needs local files/MCP, machine on: desktop scheduled task, or session cron (dies when the session closes, expires after 7 days).
   - Recurring, machine may be off, no local files: cloud `/schedule` (min 1 hour, fresh clone).
3. **Propose** in at most 6 lines: purpose, mechanism, exact trigger or cron, what it will run, risk, how to remove. Hooks run commands with the user's privileges, so wait for approval.
4. **Start safe:** notification or log-only first; add blocking or editing behavior only after the user trusts it.
5. **Create** via the `update-config` skill (hooks/settings) or the schedule/cron tools; do not hand-edit settings.json if a skill covers it.
   - Cơ chế ghi data: chạy `harness data register <zone>/<domain|ws>/<tool> --class <log|cache|artifact|durable> [--project ID]` trước lần ghi đầu; hệ thống tự cảnh báo nếu thiếu.
6. **Register** in `AUTOMATIONS.md` at the hub root: name, type, purpose, created date, review-by date, status.
7. **Review:** on each review-by date, check the log; keep, tune or delete. Record the outcome in the register.

## Rules

- Anything unverified about hooks/scheduling must be labeled "not confirmed" or checked with docs first (see memory `verify-before-asserting`).
- Prefer the cheapest model and fewest tools for the automation itself.
