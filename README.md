# harness-kit

<p align="center"><img src="assets/icon.svg" width="64" alt="harness-kit"></p>

A Claude Code plugin that adds a deterministic constraint layer around AI agents: guard, data zones, audit, a hook dispatcher and a CLI gateway. The core runs a full loop out of the box: collect, normalize, query, warn, incident ledger, weekly report, approved proposals, flag unused.

## Goals

- Enforce rules with code, not agent judgment: checks a machine can run are automated and warn on their own.
- Constrain agents safely: guards for protected paths and harness data, with hooks that fail open; hard blocks (push, deploy, ssh) belong to Claude Code native permission rules.
- Keep data organized and observable: a zoned data tree with audit logs and usage reports.
- Single entry point: one `harness` CLI to read data, run doctor checks and extend the system.
- Zero dependencies; requires only Node.js.

## Quick start

```
/plugin marketplace add https://github.com/synura-dev/harness-kit
/plugin install harness-kit@synura
```


No further setup is needed. The plugin provides the Claude hooks, and the `harness` CLI is on the Bash tool's PATH.

- Outside Claude (PowerShell, cmd, your own bash): the first Claude session installs a `harness` shim through the SessionStart hook; open a new terminal afterwards. Manual install: `harness install --shim [--dir D] [--dry-run] [--force]`. Disable with `HOOK_USER_SHIM_ENABLED=0`.
- agy: `agy plugin install <plugin root>` and you are done. Each CLI installs on its own; agy puts the plugin's `bin/` on PATH (so `harness` works in its first session) and loads `rules/AGENTS.md` itself. The agy hook is on by default and does not read `.claude`. Opt out with `HARNESS_AGY=0` or a `.harness/agy.off` file in the project. To update, re-run `agy plugin install`.
- The hook auto-allows read-only `harness` commands from a strict allowlist. Its effect under a strict permission config is not measured yet.
- The `harness` shim is shared by all CLIs through `roots.json` (claude uses `{scan}`, agy uses `{root}`). Both CLIs share the same harness data; each writes a data-version stamp and `harness doctor` prints one warning line when they differ.
- Removed in 0.4.0: the `agy` CLI domain, the background sync hook and the `.agents` sync adapter. `harness doctor` warns in one line about leftovers (see CHANGELOG, Migration).
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
  build/          install, user shim
  cli/            CLI gateway and commands
  constrain/      guard, bash-guard, model-policy, proc-orphans, worktree
  core/           audit, config, registry, runtime, agy, io, checks, ext
  hooks/          hook dispatcher
  observe/        audit, storage, views
  tools/          adapters
hooks/            plugin hook entry points (hooks.json, run.mjs)
skills/           bundled skills
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Release history: [CHANGELOG.md](CHANGELOG.md).
