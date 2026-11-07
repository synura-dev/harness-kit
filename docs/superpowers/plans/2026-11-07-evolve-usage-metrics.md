# Evolve usage metrics (harness-kit-0059) Implementation Plan

> For agentic workers: SDD, one builder per Task. Steps use `- [ ]`. Tests: `node --test <file>` (repo uses node:test, `.test.mjs` next to source). Comments in repo language (Vietnamese no accents).

**Goal:** make `harness evolve scan --kind deprecate` report real usage: real data window, distinct sessions, correct last_ts, generic collector with per-kind detectors (skill detector reads Claude transcripts + audit), maintenance filter, `source`-driven actions, context cost.

**Real code (verified):** `harness/evolve/loop/prune.mjs` (`readUsageEvents`, `countUsage`, `Acc`, `buildCandidates`, `inventory*`, `PRUNE`), `prune-cli.mjs` (summary), `harness/observe/ledger/sources.mjs` (`pruneSource`), `observe/ledger/defaults/{deprecate,cap}.json`, tests `evolve/loop/prune.test.mjs`. Today: usage only from hub audit jsonl (`MARK` prefilter; Skill = `PreToolUse` tool Skill only); items from `buildCandidates` hard-set `sessions:0`/`last_ts:null`; `src.hookrun_since` is computed but never gates status; the pending clock (`pending_since`) starts at first sight regardless of how short the real data window is.

**Data decision:** both. Audit (hook) events stay for command/hook/agent. Skills/agents/slash are read from Claude transcripts `~/.claude/projects/**/*.jsonl` (audit misses sessions where the hook was off; plugin-authoring's 32 Skill calls exist only there). Bounded reads: `limits {timeoutMs, maxBytes, maxFiles}`, substring prefilter before JSON.parse, `truncated: timeout|max_bytes|max_files`; truncated => no deprecate proposals (existing `skipDeprecate`).

**Generic event:** `{kind,id,ts,session,project,channel:'tool'|'slash'|'read'|'preload',source:'project'|'plugin'|'account'|'builtin'}`.

Layout: new `harness/evolve/usage/` (`collect.mjs` generic counter + window + maintenance filter, `transcripts.mjs`, `detectors/skill.mjs`, `detectors/index.mjs`, `source.mjs`, `cost.mjs`, tests alongside). `prune.mjs` calls it; keep its exports stable.

---

### Task 1: Generic counter with sessions, last_ts, window (RED/GREEN)
Files: create `harness/evolve/usage/collect.mjs`, `collect.test.mjs`.
- [x] Failing tests first: (a) 3 events, 2 distinct `session` -> `sessions===2`, `count===3`; (b) `last_ts` = max ts even when events arrive unordered; (c) `window` per origin = `{earliest, latest, n}` from the earliest event; (d) missing session id is not counted as a session.
- [x] Implement `countEvents(events)` -> `{items: Map<"kind:id",{count,sessions,first_ts,last_ts,channels,projects}>, window:{[origin]:{earliest,latest,n}}}`; events carry `origin` (audit|transcript|gateway).
- [x] Run: `node --test harness/evolve/usage/collect.test.mjs` (red, then green).

### Task 2: Wire counter into prune.mjs; honest window gating (RED/GREEN)
Files: `harness/evolve/loop/prune.mjs`, `prune.test.mjs`, `prune-cli.mjs`.
- [x] Failing tests: (a) `buildCandidates` with `window.earliest` younger than `days` never yields `pending`/`propose_remove` for that kind: status `insufficient_window` with `window_days`, no `pending_since` written; (b) used components carry real `sessions`/`last_ts`; (c) `pruneCandidates` result has per-origin `sources.<name>.earliest` and `window_days`; (d) existing tests still pass.
- [x] Replace `Acc` in `countUsage` by the Task 1 counter (same signature); `hookrun_since` now gates the `hook` kind; pass `window` to `buildCandidates`; the pending clock starts only once window >= `days`.
- [x] CLI summary: replace "/ 30 ngay" with real window per source (`du lieu thuc: audit tu X (N ngay), transcript tu Y`); print `insufficient_window` items.
- [x] Run: `node --test harness/evolve/loop/prune.test.mjs`.

### Task 3: Transcript reader, bounded (RED/GREEN)
Files: create `harness/evolve/usage/transcripts.mjs`, `transcripts.test.mjs`.
- [x] Failing tests with tmp fixture dirs: (a) only files with mtime >= window start are read; (b) `maxBytes`/`maxFiles` exceeded -> `truncated:'max_bytes'|'max_files'`; (c) `timeoutMs:1` on a big fixture -> `truncated:'timeout'`; (d) bad JSON lines skipped; (e) yields `{session: sessionId, project, ts, turn, msg}` only for lines passing the substring prefilter (`"Skill"`, `<command-name>`, `SKILL.md`, `.md"`, `skills:`).
- [x] Implement `readTranscripts({roots,fromMs,nowMs,limits})` (stream by line like `readUsageEvents`; default root `os.homedir()/.claude/projects`, overridable; limits in `PRUNE.limits`).
- [x] Run: `node --test harness/evolve/usage/transcripts.test.mjs`.

### Task 4: Skill detector (RED/GREEN)
Files: create `harness/evolve/usage/detectors/skill.mjs`, `skill.test.mjs`, `detectors/index.mjs`.
- [x] Failing tests, one per channel: (a) assistant `tool_use` `Skill` input `{skill:"plugin-authoring"}` and `"plugin:skill"` form -> `channel:'tool'`, id = last segment; (b) user text with `<command-name>/knowledge-store</command-name>` -> `channel:'slash'`; (c) `tool_use` Read with `file_path` `.../knowledge-store/SKILL.md` (both `\` and `/`) -> `channel:'read'`; (d) subagent spawned (Agent `subagent_type`) whose definition frontmatter has `skills: [a, b]` -> `channel:'preload'` per skill; (e) non-skill Read ignored; (f) fixture of 32 plugin-authoring Skill calls over two days -> count 32 (regression for the 0-use bug).
- [x] Detector interface `detect(msg, ctx) -> event[]`; `index.mjs` registers `{skill, agent, command, hook}`; only skill is new, the others wrap the existing audit logic in the same interface. No skill-specific code in the collector.
- [x] Run: `node --test harness/evolve/usage/detectors/skill.test.mjs`.

### Task 5: Maintenance filter (RED/GREEN)
Files: `harness/evolve/usage/collect.mjs`, `collect.test.mjs`.
- [x] Failing tests: (a) one turn with 5 `read` events on distinct definition files (SKILL.md / agent .md) -> all 5 dropped as maintenance (counted in `maintenance_dropped`, not in usage); (b) 4 reads kept; (c) a `tool` or `slash` event in the same turn is never dropped; (d) threshold configurable (`maintenanceReads`, default 5).
- [x] Implement generic `filterMaintenance(events,{threshold})` grouped by session+turn, only channel `read`, kind-agnostic.
- [x] Run: `node --test harness/evolve/usage/collect.test.mjs`.

### Task 6: Source classification and action (RED/GREEN)
Files: create `harness/evolve/usage/source.mjs`, `source.test.mjs`; edit `prune.mjs` inventory and `buildCandidates`.
- [x] Failing tests: `classifySource(path, roots)` -> project (under project `.claude`), plugin (under plugin root/cache), account (no local file, claude.ai-managed, flagged in inventory), builtin (list from a defaults json, not hardcoded per skill). `buildCandidates` item `action`: project -> `delete_in_repo`; plugin -> `edit_plugin_repo` (+ plugin name); account -> `disable_on_claude_ai`; builtin -> `report_only` and NEVER status `propose_remove`.
- [x] Inventory entries gain `source`; CLI prints the action per item.
- [x] Run: `node --test harness/evolve/usage/source.test.mjs harness/evolve/loop/prune.test.mjs`.

### Task 7: Context cost per kind (RED/GREEN)
Files: create `harness/evolve/usage/cost.mjs`, `cost.test.mjs`; edit `prune.mjs`, `prune-cli.mjs`.
- [x] Failing tests: `estimateTokens(text)` = ceil(chars/4) (documented `shortcut:`); skill/agent: `desc_tokens` from frontmatter description (loaded every session) and `body_tokens` (when loaded); command: description from manifest; rule: its text; hook: 0. `costPerUse = (desc_tokens*sessions + body_tokens*count)/max(count,1)`; ranking descending, 0-use items ranked by `desc_tokens`.
- [x] Add `cost` to items and a ranked `--cost` section in CLI (top 15, line-capped).
- [x] Run: `node --test harness/evolve/usage/cost.test.mjs`.

### Task 8: Wire detectors into pruneCandidates (RED/GREEN)
Files: `prune.mjs`, `prune.test.mjs`, `harness/observe/ledger/sources.mjs`, `sources.test.mjs`.
- [x] Failing integration test (tmp audit dir + tmp transcript dir): skill used only in a transcript -> not deprecate; used only via SKILL.md Read (<5 per turn) -> not deprecate; 20 reads in one turn -> treated unused; transcript read truncated -> `truncated` set and no deprecate items.
- [x] `pruneCandidates` merges audit + transcript events through detectors, reports one `truncated` (first cause), new option `o.transcriptRoots`; `pruneSource` passes defaults.
- [x] Run: `node --test harness/evolve/loop/prune.test.mjs harness/observe/ledger/sources.test.mjs`.

### Task 9 (extra): Per-project usage
Files: `collect.mjs`, `prune-cli.mjs`, tests.
- [x] Failing test: per-item `projects` map `{name: count}` from event `project`; CLI `--by-project` prints top projects per item (capped).
- [x] Run: `node --test harness/evolve/usage/collect.test.mjs harness/evolve/loop/cli.test.mjs`.

### Task 10 (extra): Doctor check for skill copy hash drift
Files: builder locates the doctor check convention (`grep -rn "doctor" harness --include=manifest.json -l`), adds a `skill-drift` check + test there.
- [x] Failing test: tmp trio `.claude/skills/x`, `.agents/skills/x`, plugin-cache copy; identical -> ok; one differs -> warn naming the copy; missing copy -> info. Hash = sha1 of CRLF-normalized files; reads bounded (maxFiles, timeout).
- [x] Run: `node --test <that check's test file>`.

### Task 11 (extra): Near-duplicate description warning
Files: create `harness/evolve/usage/dupes.mjs`, `dupes.test.mjs`.
- [x] Failing test: token-set Jaccard >= 0.7 between two skill/agent descriptions -> pair warned; lower -> none; output capped (top 10 pairs; n > 200 -> `truncated: max_items`).
- [x] Surface as `trung mo ta:` lines in the CLI summary.
- [x] Run: `node --test harness/evolve/usage/dupes.test.mjs`.

### Task 12: Docs + full suite once
- [x] Update `harness/observe/ledger/README.md` and the evolve manifest help (flags `--cost`, `--by-project`, window fields, `source` actions).
- [ ] Full suite once, background, with timeout, log to a file: `timeout 900 node --test harness > <scratch>/full.log 2>&1`; builder reports the log tail; no rerun.
- [ ] Reviewer (Opus) pass on the branch.

## Out of scope
Quality / trigger accuracy of skills (reviewer agent).

## Open questions (non-blocking, defaults chosen)
1. Skill cap 20 (now 33): default keep and only report; user may raise `PRUNE.caps.skill`.
2. Builtin list location: default `harness/evolve/usage/defaults/builtin.json`.
3. Transcript root default `~/.claude/projects`; other machines may need `o.transcriptRoots`.
