---
name: audit-review
description: "End-of-day or on-demand review of the hub audit log: repeated errors, token use, slow agents, maxTurns hits, unbounded commands, path-guessing permission prompts, main editing code. Use when asked to review audit, errors, tokens, or the day's work."
---

# Audit review

Read-only analysis. Do not edit the audit hook or data. Flags below come from `harness/observe/views/QUERY.md`; re-read them if unsure and do not invent flags.

## Commands (always with a timeout, output cut)
- Index of all harness commands: `harness` (`harness <domain> [cmd]`; plugin CLI in bin/, on the Bash PATH while the plugin is enabled).
- `harness audit [YYYY-MM-DD]` (automated review of 7 checklist items)
- Quick digests (<=40 lines, read-only): `harness audit why [--task ID|--session S|--since 1d] [--limit N]` (repeated errors by error_fp, stuck retries, abandoned work, file churn) and `audit map [--task ID|--since 1d]` (most-touched files + last verifier outcome).
- `timeout 120 node harness/observe/views/query/query.mjs --origin work --since YYYY-MM-DD --report summary --backend node | head -n 80`
- Other reports: `errors`, `slow`, `tokens`, `subagents`, `writes`, `hot-files`, `timeline --session <id>`. Query has `--timeout` seconds, `--max-rows`, `--max-bytes`; `truncated: ...` means partial, say so.
- Raw rows: `--type tool --tool Bash --ok false --limit 50 --format json`.
- Digest: `node harness/observe/views/digest.mjs YYYY-MM-DD`.
- Truoc khi khang dinh su that ve claude/agy (so event hook, co PreToolUse...): `harness knowledge query <chu de>` / `knowledge get <id>` (ghi chu da xac minh; domain memory/facts da bo), hoac kiem truc tiep; khong sao chep noi dung vao skill.

## Data rules
- tokens_in/out on Stop/SubagentStop are cumulative per session/agent: take max, never sum.
- Phantom SubagentStop (no agent_type/Start/transcript) are excluded by default; old rows may still show; ignore them. `--include-phantom` only to inspect.
- `--origin work` drops noise (bench/scratch cwd).

## Checklist
1. Repeated errors (same tool+target >=2 times, esp. Bash heredoc/python/sed -> see scratch-script-runner).
2. Subagents running >10 minutes (dur_ms / ts span).
3. Agents that hit maxTurns (turns == frontmatter maxTurns, status partial).
4. Bash commands >60s without timeout (see bg-wait-with-timeout).
5. Permission prompts caused by guessing paths; correct way: `harness projects resolve <id>` before dispatch.
6. Main session (actor=main) editing/writing project code (`--report writes`); should be delegated.
7. Token outliers (max per session x agent).

## Output
Summary <=40 lines: counts per checklist item with evidence (session id, ts), then a "Ghi nho" section with durable rules worth saving to memory/AGENTS.md (propose only; do not write them). State which numbers are verified vs unverified.
