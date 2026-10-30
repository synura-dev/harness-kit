---
name: scratch-script-runner
description: Run multi-line scripts, heredocs, python patches or in-place edits on Windows safely via a scratch file. Use instead of heredoc / python -c / sed -i inside Bash whenever the script is more than one short line.
---

# Scratch script runner

Evidence: ~20 of 158 Bash errors were heredoc/python/sed quoting problems, often retried 2-3 times.

## Rules
1. Do not use heredocs, `python -c "..."`, multi-line quoting or `sed -i` in Bash (quoting breaks across PowerShell/Git Bash on Windows).
2. Write the script with the Write tool into the session scratchpad (absolute path), never into the project unless it is a deliverable.
3. Run it: `node <abs-file>` or `python -I <abs-file>` (`-I` isolated mode). Pass inputs as arguments, not by cd into untrusted dirs.
4. Wrap with a timeout (`timeout 60 node file`) and bound output (`| head -n 60`); have the script print a short summary, not full dumps.
5. For file edits to the project use the Edit tool, not sed/python patches. Use scripts only for bulk/computed changes, and print what changed.
6. On failure, fix the file and rerun once; read the first error lines (`head -n 20`) instead of retrying the same command.
7. Use forward slashes or quoted absolute paths; paths with spaces (e.g. "D:/My Project") must be quoted.
