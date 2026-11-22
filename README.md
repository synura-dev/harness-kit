# harness-kit

A Claude Code / agy plugin that adds a deterministic constraint layer around AI agents: guard rules, data zones, audit and a read-only MCP server. The runtime is a single native Rust binary, `harness-rs`, with no runtime dependencies.

## Install

Claude Code:

```
/plugin marketplace add synura-dev/harness-kit
/plugin install harness-kit@synura
```

agy: `agy plugin install <path>/plugins/agy` (the hook is on by default; opt out with `HARNESS_AGY=0`).

Health check: `harness-rs doctor` or the `harness_doctor` MCP tool.

## Layout

```
rust/harness/               harness-rs source (src, tests, fixtures)
plugins/claude/             Claude plugin: manifest, hooks/hooks.json, .mcp.json, bin/harness-rs
plugins/agy/                agy plugin: manifest, hooks.json, bin/harness-rs (same binary)
.claude-plugin/             marketplace.json
scripts/release.sh          build, strip, copy the binary into both plugins
scripts/check-binary.sh     verify plugin binaries match the source tree
docs/                       plans and source history
```

Both plugins ship the identical binary. Project-specific rules are optional, in `<project>/.harness/rules.toml`. Audit data goes to `<project>/.harness/audit/`.

## Configuration

| | Default (no `.harness/rules.toml`) | Opt-in via TOML |
|---|---|---|
| Guards | secret files, rm -rf outside workspace, git force push, `.harness` and plugin/launcher protection, config dumps, fail-closed on broken rules | `path_rules`, `bash_rules` (regex, shell_access, worktree_script, command_guard with `tools`, `allow_daemons`, ...), `agy_arg_scan`, `protected_paths`, `sensitive_file_names` |
| Data gate | off | `[data_gate]` (`data_dir`, default = resolved data dir) |
| WebSearch/WebFetch block | off | `[claude_web]` (`reason`) |
| Worktree hooks | `.worktrees/` | `worktree_dir = "..."` |
| Model policy | audit only (no rewriting) | JSON config `.harness/models.json` |
| Audit, observe, doctor, MCP (4 tools) | on | n/a |

Deprecated keys (still read, doctor warns): `daemon_allow` -> `allow_daemons`, `allowed_dbpath_env` -> `allowed_paths_env`, `allowed_dbpath_default` -> `allowed_paths` (plus `path_flag`, default `--path`). Full example: [docs/hub-rules.example.toml](docs/hub-rules.example.toml).

Notes:
- Guards are best-effort (hooks fail open); also add deny rules in the project's settings.
- Do not wire another dispatcher of the same kind in `.claude/settings.json`, or hooks run twice.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Release history: [CHANGELOG.md](CHANGELOG.md).
