# harness-kit

<p align="center"><img src="assets/icon.svg" width="64" alt="harness-kit"></p>

A Claude Code plugin that adds a deterministic constraint layer around AI agents: guard, approval, data zones, audit, a hook dispatcher and a CLI gateway.

## Goals

- Enforce rules with code, not agent judgment: checks a machine can run are automated and warn on their own.
- Constrain agents safely: guards and approvals for risky commands, with hooks that fail open.
- Keep data organized and observable: a zoned data tree with audit logs, cost and usage views.
- Single entry point: one `harness` CLI to read data, run doctor checks and extend the system.
- Zero dependencies; requires only Node.js.

## Quick start

```
/plugin marketplace add https://github.com/synura-dev/harness-kit
/plugin install harness-kit@synura
```


No further setup is needed. The plugin provides the Claude hooks, and the `harness` CLI is on the Bash tool's PATH.

- Outside Claude (PowerShell, cmd, your own bash): the first Claude session installs a `harness` shim through the SessionStart hook; open a new terminal afterwards. Manual install: `harness install --shim [--dir D] [--dry-run] [--force]`. Disable with `HOOK_USER_SHIM_ENABLED=0`.
- agy: run `harness agy init` once per project.
- Health check: `/harness-kit:doctor` or `harness doctor`.

Notes:
- Runtime data is stored under `.harness/data` in the project (a `.gitignore` entry is added automatically). The plugin root is read-only.
- A project may define a custom workspace with `config/workspace/default.json`; hooks and the CLI then use that project's own data and config folders.
- Guards are best-effort (hooks fail open); also add deny rules in the project's settings.
- Do not enable another dispatcher of the same kind in `.claude/settings.json`, or hooks run twice.

## Repository structure

```
.claude-plugin/   plugin.json and marketplace.json
assets/           icon
bin/              harness CLI launchers (harness, harness.cmd)
commands/         slash commands (doctor)
config/           default and workspace configuration
docs/             plans and source history
harness/          core implementation
  build/          install, skills, user shim
  cli/            CLI gateway and commands
  constrain/      guard, approval, bash-guard, data-gate, verify-gate, worktree
  core/           audit, config, registry, runtime, agy, io, checks, ext
  evolve/         eval and loop tooling
  hooks/          hook dispatcher
  knowledge/      inject, vault
  observe/        audit, cost, data-check, evidence, storage, views
  tools/          adapters, sync, play
hooks/            plugin hook entry points (hooks.json, run.mjs)
skills/           bundled skills
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Release history: [CHANGELOG.md](CHANGELOG.md).
