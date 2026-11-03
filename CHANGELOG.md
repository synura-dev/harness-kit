# Changelog

GitHub releases and commit history are the source of truth going forward. This file preserves the entries that existed before publication.

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
