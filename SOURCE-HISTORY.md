# Source history

From the cutover (branch `source-flip`) this repo is the single source of the core code. Edit here.

History before the cutover lives in the hub repo (`E:\11. Agents`): tag `pre-flip` (commit 1ee1a0b) is the last state where `harness/` there was the source. Use `git log` in the hub for earlier history of any file.

## Seed tests
The old export dropped `*.test.mjs`. Seed tests were copied from hub `harness/` for every module that exists here (same relative path; no hub imports; a few string fixtures mention project names, harmless).

Restored (round 2): all 12 formerly excluded tests now run in plugin mode (explicit fixtures: repoDir / HARNESS_CONFIG_DIR / registryFile+extDirs / mode-aware expectations) and stay green in hub mode. Excluded count: 0 of the original 12.

Also synced from hub: evolve/loop/{policy,loop,cli}.mjs (the export predated layout config and candidates --source; the restored loop test covers them).

Round 3: tools tests now green in plugin mode with tmp fixtures: play.test (fixture hub with .agents/playbooks, run-log path via dataPathFor), prune.test (HARNESS_CONFIG_DIR -> tmp config/play/default.json), sync link-mode and broken tools.json tests (HARNESS_CONFIG_DIR -> fixture config). Assertions unchanged except the run-log location, which now follows the registry. bun test harness/tools: 40 pass, 0 fail.
