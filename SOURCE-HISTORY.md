# Source history

From the cutover (branch `source-flip`) this repo is the single source of the core code. Edit here.

History before the cutover lives in the hub repo (`E:\11. Agents`): tag `pre-flip` (commit 1ee1a0b) is the last state where `harness/` there was the source. Use `git log` in the hub for earlier history of any file.

## Seed tests
The old export dropped `*.test.mjs`. Seed tests were copied from hub `harness/` for every module that exists here (same relative path; no hub imports; a few string fixtures mention project names, harmless).

Excluded because they assume hub mode (this repo is plugin mode: `.claude-plugin/plugin.json` exists) or hub data/config not shipped here:
- core/config/config, core/io/paths, core/io/safe-id, core/registry/data-registry, core/registry/plugin-registry
- cli/commands/config, cli/commands/doctor
- constrain/model-policy/hook, constrain/worktree/hook
- hooks/dispatch/run, observe/storage/data, evolve/loop/loop

Follow-up: make these tests pass explicit repoDir/mode so they run in plugin mode, then restore them from hub tag `pre-flip`.
