---
name: bg-wait-with-timeout
description: Wait for a background job, log or done-file safely with a hard timeout instead of polling. Use when a command may run longer than ~30-60s, when waiting for a build/test/server, a log line, or a done marker file.
---

# Background wait with timeout

Evidence: audit 24-26/10 had 12 shell commands >60s with no timeout. Every wait must be bounded.

## Rules
1. Anything that may exceed ~30s: run with `run_in_background` (Bash tool) and write output to a log file. You are notified on exit; do not poll or sleep in the foreground.
2. Always wrap with a limit: `timeout 600 <cmd> > log.txt 2>&1` (or the tool's `timeout` option, max 600000 ms).
3. To wait on a marker, bound the loop:
   `timeout 300 bash -c 'until [ -f done ]; do sleep 10; done'; echo exit=$?` (exit 124 = timed out; report it, do not retry blindly).
4. Cut output before reading: `tail -n 40 log.txt`, `head -n 40`, `grep -m 20 pattern log.txt`. Never cat a whole log.
5. Run long tests once, log to file, no second launch; no two suites on the same DB.
6. Before the final report, stop every background process you started (check by PID you recorded) and say so.
7. On timeout: report `truncated: timeout` with the last 20 log lines; do not extend silently.
