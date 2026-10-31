# Source history

From the cutover (branch `source-flip`) this repo is the single source of the core code. Edit here.

History before the cutover lives in the hub repo (`E:\11. Agents`): tag `pre-flip` (commit 1ee1a0b) is the last state where `harness/` there was the source. Use `git log` in the hub for earlier history of any file.

## Seed tests
The old export dropped `*.test.mjs`. Seed tests were copied from hub `harness/` for every module that exists here (same relative path; no hub imports; a few string fixtures mention project names, harmless).

Restored (round 2): all 12 formerly excluded tests now run in plugin mode (explicit fixtures: repoDir / HARNESS_CONFIG_DIR / registryFile+extDirs / mode-aware expectations) and stay green in hub mode. Excluded count: 0 of the original 12.

Also synced from hub: evolve/loop/{policy,loop,cli}.mjs (the export predated layout config and candidates --source; the restored loop test covers them).

Round 3: tools tests now green in plugin mode with tmp fixtures: play.test (fixture hub with .agents/playbooks, run-log path via dataPathFor), prune.test (HARNESS_CONFIG_DIR -> tmp config/play/default.json), sync link-mode and broken tools.json tests (HARNESS_CONFIG_DIR -> fixture config). Assertions unchanged except the run-log location, which now follows the registry. bun test harness/tools: 40 pass, 0 fail.

Round 4 (full-core sync, plugin renamed `harness-kit`): synced from hub `harness/` HEAD (after security fixes): extension layer (core/ext ctx/ext-host/ext-supervisor, cli/ext-runner, ext commands, manifest domain `ext`), core/runtime/hook-events, guard hook (ext-config-protect, launcher-protect, Edit/Write extraction, META.tools), doctor (launcher hook, skip without .agents/, three plugin names), dispatch cfg.modules flags, data-registry manifestDataEntries/extRoots, paths, storage registry, hook-latency, sync, plus 46 seed tests. Plugin-mode test fixes: adapters/harness-groups point HARNESS_CONFIG_DIR at the fixture config; storage-guard uses a real registered key in plugin mode. Dropped two tests that target hub-only extensions (hub/tasks compact in data-guard, hub/agy agy-home in phase3-paths); they stay in the hub. Test fixture paths no longer mention the hub folder name. The workspace launcher `bin/harness.mjs` is not part of the plugin.
- Round 4b: plugin-registry/safe-id plugin-mode expectations updated (plugin now ships `ext`; registry matches hub, `runs` flat); dropped ext-data test of hub/tasks + hub/dispatch manifests (hub-only).
