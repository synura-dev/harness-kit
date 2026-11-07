# Changelog

GitHub releases and commit history are the source of truth going forward. This file preserves the entries that existed before publication.

## 0.3.11
- ext-inject: placeholder `{agent_type}` trong `inject.args`, nap ngu canh theo vai tro o SubagentStart (cache theo vai tro 30 phut, tran rieng moi ext kep 30 dong/3KB, fail-open).

## 0.3.10
- ext-guard fail-open khi timeout: dispatcher va ext-guard khong con deny khi guard/module het gio hoac loi spawn (cho qua + canh bao + audit `rule=fail-open`); chi chan khi co tin hieu vi pham ro (hash ext lech/chua duyet: kiem het truoc khi spawn; guard exit 2: tra ngay, guard chay song song nen ext treo khong lam mat deny that). Thong bao va hanh vi nhat quan.
- agy-sync: hook SessionStart cua Claude tu chay `agy plugin install "<cache plugin>"` (nen, chi nang cap, chi khi phien khoi dong) khi ban agy cu hon ban plugin Claude; khoa + gian thoi gian thu lai; tat bang `HARNESS_AGY_AUTOSYNC=0`.
- worktree hook dung wrapper spawn `core/runtime/proc.mjs` (proc-check xanh lai).

## 0.3.9
- agy: harness-kit la plugin agy native (`.antigravity-plugin/plugin.json` + `hooks.json` o goc -> `harness/hooks/dispatch/agy-native.mjs`, workspace lay tu stdin `workspacePaths`). Cai global mot lan: `agy plugin install "<thu muc plugin Claude>"`; bat theo du an bang `enabledPlugins["harness-kit@synura"]: true` trong `.claude/settings.json` (khong bat -> hook cho qua, khong ghi gi). Bo shim `.agents/harness-agy-shim.mjs`, `.agents/hooks.json`, `harness agy init --legacy`, module agy-heal; khong sinh ban chep `.agents/skills`. `harness agy init` kiem cai global, lech version, du an da bat. Playbook co bien dung san `${harnessBin}` (`node ${harnessBin} <lenh>`).

## 0.3.8
- Sua loi ext-guard fail-open trong phien that: hook nhan `CLAUDE_PLUGIN_DATA=<data>/<ten>-<marketplace>` con CLI (khong co bien nay) dung `<data>/<ten>`, nen hook doc registry ext rong va cho qua moi tool. `pluginLayerDirs` nay suy id `<ten>@<marketplace>` (ky tu ngoai `[A-Za-z0-9_-]` -> `-`) tu duong dan cache nhu Claude Code; dung thu muc cu `<data>/<ten>` khi primary chua co `config/ext/local.json` (CLI va hook cung mot thu muc, khong migrate). guard-health canh bao `ext-registry-split` khi thu muc cu con registry ma dang dung thu muc khac. Root ngoai cache (HARNESS_PLUGIN_DIR, --plugin-dir) giu hanh vi cu.

## 0.3.7
- Sua loi du lieu lac `<ws>/.harness/data`: quy tac workspace co dau hieu (config/workspace|hub/default.json => data `<ws>/data`, config `<ws>/config`) nay nam o loi (`dataDir`, `ensureDataIgnore`, `loadConfig`), khong chi o wrapper; them `harness data adopt --legacy-harness` + canh bao `harness doctor`.

## 0.3.6
- Sua loi ext-guard: stdin khong toi ext (ext-host spawnSync khong co input, ext-supervisor dat stdin 'ignore') nen ext guard nhan JSON rong va exit 2 cho moi tool. Hop dong: `harness <ext> ...` voi env HARNESS_STDIN_FORWARD=1 (ext-guard dat) chuyen NGUYEN stdin (toi da 1MB) toi ext qua ext-host -> ext-supervisor -> ext-runner; ext doc process.stdin. Khong co env thi stdin ext rong nhu cu (khong treo). Test tich hop ext-guard -> bin/harness -> ext tam.

## 0.3.5
- Sua loi ext-guard: matcher bi ep neo `^(?:...)$` nen `^mcp__obsidian__` khong khop tool that (mcp__obsidian__vault_delete) va bi cho qua. Nay dung tim kiem (new RegExp(matcher)) nhu matcher hook Claude Code; them test voi ten tool that + test tich hop qua hooks/run.mjs.

## 0.3.4
- observe usage dem err dung (PostToolUseFailure); ext khai bao guard (PreToolUse, exit 2 chan) qua hook ext-guard: chan khi co tin hieu vi pham ro (hash lech, exit 2); timeout/exit khac/loi/het budget => fail-open kem canh bao (sua o ban sau), registry khong doc duoc => fail-open co audit. Khai bao ghim trong registry luc ext register/approve (prompt TTY in THEM/DOI/GO GUARD); ext remove cua ext co guard bat buoc TTY. AUDIT PreToolUse co budget rieng toi thieu 300ms. Timeout PreToolUse hooks.json 3s -> 8s: du cho node boot + guard loi + spawn ext (~1.2s cold Windows) + audit; budget dispatcher 2500ms (+3000ms rieng cho ext-guard chi khi khop matcher), khong khop thi nhanh nhu cu.

### Han che da biet (0.3.4)
- Agent ghi thang file registry (<plugin data>/config/ext/local.json) la duong lach: guard loi chan lenh Bash/PowerShell va Write/Edit co duong dan chua `config/ext/local.json` (da kiem: EXT_CONFIG_RE trong constrain/guard/hook.mjs, ap cho ca duong dan plugin), nhung duong dan ghep dong (vd node -e noi chuoi) hoac `cd` roi ghi duong dan tuong doi (`config/ext/local.json`) khong bi bat: guard theo van ban lenh khong bat duoc duong dan ghep luc chay. Lenh node/bun/deno nap `ext-registry`/`ext-trust` (ke ca import(/require() bi chan. Bien phap goc la quyen he dieu hanh tren file registry, ngoai pham vi harness.

## 0.3.3
- observe usage (dem lenh/ext/hook + loi); repeated-pattern bo lenh don va chuoi Edit/Write; observe ledger close; ext remove.

## 0.3.2
- loop-fix 0049-0055 (merged from lf/int).

## 0.3.1
- proc-orphans: no warning while another subagent of the same session is still running (SubagentStart/SubagentStop track live agents); the pid-set dedupe is now actually applied, keyed per recipient (main or subagent), and changing pid sets are throttled to one warning per 15 minutes (throttleSec). Stops the repeated Stop-hook nudges during long background subagents.

## 0.3.0
- Slimmer core: runtime reduced from 17,959 to about 11,300 lines. Removed approval, verify-gate, diff-review, evidence, contract and storage mv; dev tooling moved into dev/.
- Hard blocks now rely on native permissions (PowerShell included) instead of custom guard logic; medium security findings fixed in 8 fix(security) commits.
- PID ledger is append-only; proc-orphans no longer reports the same process repeatedly.

## 0.2.3
- Release of the changes previously listed under Unreleased (ledger, evolve patterns, guard protectedPaths, knowledge module removal).
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
