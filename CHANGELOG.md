# Changelog

GitHub releases and commit history are the source of truth going forward. This file preserves the entries that existed before publication.

## Unreleased
- BREAKING: removed the knowledge module. `harness knowledge ...` (vault gateway: put/get/links/query/context/map/index/check/prune/migrate) and the `knowledge-inject` hook (UserPromptSubmit/SessionStart/SubagentStart context injection) are gone; the dispatcher keeps only `audit` on UserPromptSubmit/SubagentStart. The harness is a mechanism layer and no longer holds knowledge content; read/write notes via your own tool (e.g. `harness obsidian`).
- BREAKING: `evolve propose --kind fact` removed (facts were written through the knowledge gateway); only `--kind skill` remains. Config key `factDir` and env `HARNESS_KNOWLEDGE_ROOT` are no longer read.
- Data: the `memory` registry entry (`data/knowledge/memory`) is removed; existing directories become unregistered (data scan warns, no data is deleted). The `knowledge` data zone is kept (tasks, evolve, eval write under `data/knowledge/`).
- Feat(guard): new `protectedPaths` rule (`protected-path`). Empty by default; extend via guard config (machine `guard.local.json`/`local.json`, project `project.json` or `config/guard/projects/<id>.json`; layers merge, add-only). Bash/PowerShell/run_command text or Edit/Write/MultiEdit file_path mentioning a protected path (case-insensitive, `\\` / `/` / `/e/...` forms normalized) is denied, except a single `harness obsidian ...` / `node ...harness... obsidian ...` command.
- Guard hardening: protectedPaths normalizes `./`, `x/../`, trailing dots/spaces and PowerShell backticks; the `harness obsidian` exemption now requires a bare `harness` first token or `node` + this plugin's own bin, and is refused with `( ) { }`. A broken guard config file is no longer silent: `config-broken` warning (audit + stderr) and a `harness doctor` ERROR. Blocked Edit/Write now log the hash/len of file_path.

## 0.2.2
- Fix: extension gateway forwards `--json` and other flags correctly (GATEWAY_ONLY_FLAGS).
- Fix: knowledge context/map exclude unpinned web-source notes; label [nguon ngoai].
- Chore: .gitignore update.

## 0.2.1
- Fix: data CLI commands (archive, scan orphan-ws, workspace routing) no longer load the node hook when `HUB_DATA_DIR` equals the workspace's default data directory; only a real override (sandbox/test) skips it.
- Fix: `harness data tree` reads the merged registry (manifest + per-workspace tool entries + derived entries) instead of reporting an empty registry.

## 0.2.0
- Fixed-location `harness` shim for user shells (`%USERPROFILE%\.harness-kit\bin`); doctor warns when running inside an MSIX package or when the shim sits under LOCALAPPDATA/APPDATA.
- Per-workspace data routing through the hub hook (`workspaceFor` / `listNodes`); registry built from tool manifests; `config/data/workspaces/*.json` deprecated (still read, emits `deprecated-config`).
- `runs.jsonl` (written on every run) and `harness data query`.
- `harness data scan`: detects orphan workspaces.
- `harness data archive`.
- `harness register --project` requires an approved extension (ext trust).

## 0.1.1
- Release gate fixes, skill frontmatter, agy CLI shim.
