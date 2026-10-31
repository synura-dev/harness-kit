---
name: harness-config
description: Add or change configuration for the harness core under the clean-core standard. Use when adding a new tool or hook, adding config, adding a project or target, adding a port feature, preparing to publish the harness, or when project/machine data shows up inside harness/.
---

# Harness config (clean core)

Standard (details live elsewhere, do not copy): `docs/config-standard.md`; layering code: `harness/core/config/config.mjs`.

## Standard
- harness core holds no project, machine or secret data. Built-in DEFAULTS live in code.
- Config tree: `config/<tool>/{default.json, projects/<id>.json, features/<name>.json, *.local.json}`.
- `*.example.json` is committed; `*.local.json` and real data are git-ignored.
- Layer order (later wins): code < default < project < feature < local < env.
- Project is chosen explicitly (never inferred). Clamps may only tighten, never loosen.

## Steps
(a) New tool/hook without hardcoding: put DEFAULTS in code, load via loadConfig, add `default.json` and `*.example.json`, add the `.local.json` pattern to .gitignore, add a missing-config test.
     Cơ chế ghi data: chạy `harness data register <zone>/<domain|ws>/<tool> --class <log|cache|artifact|durable> [--project ID]` trước lần ghi đầu; hệ thống tự cảnh báo nếu thiếu.
(a2) New CLI in harness/cli/: register its domain in that extension's `manifest.json` (`domain`/`domains`, `desc`, `cmds`, `default` run|index) so it appears in `harness` (index); use `harness/core/io/out.mjs` standard flags.
(b) New project (CURRENT locations, temporary, target is `projects/<id>.json`): guard -> copy the example to `config/guard/<id>.json`; release -> copy `config/release/projects/example-app.example.json` to `config/release/projects/<id>.json` (gitignored). Fill values, run the tool's `plan`/`doctor` (doctor does not print source layers yet). Examples must be neutral (`example-app`), never real project names.
(c) New tool feature: `config/<tool>/features/<name>.json` (+ example); enable it explicitly; verify with plan/doctor.
(e) Protective hooks (guard etc.): never load config raw. Use loadConfig option `protect`; project layer must not disable core rules (local only), id arrays merge by id, empty arrays do not delete rules.
(d) Before public: grep harness/ for project names, ids, hosts, absolute paths (drive letters, /home/), IPs and tokens; confirm real data is ignored; run tests with config missing (must fail clearly or use safe defaults).

## Forbidden
- Hardcoding host, path or id.
- Guessing a missing value: stop and ask.
- Renaming or moving registered hook `.mjs` files.
