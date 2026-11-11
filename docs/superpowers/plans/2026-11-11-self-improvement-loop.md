# Self-improvement loop - Implementation Plan

> For agentic workers: SDD, one builder per Task, worktree trong repo harness-kit. Steps dung `- [ ]`. Test: `timeout 120 node --test <file>` (node:test, `.test.mjs` canh source). Comment theo ngon ngu repo (tieng Viet khong dau). Commit local, khong push, khong co-author.

**Goal:** Sua do luong, do thay doi quy trinh, cho evolve de xuat "fix" + tu ha cap rule vo ich, va retro hang tuan co chuoi thoi gian + chi so kha nang tu phat trien + nguong tu kiem.

**Spec:** `docs/superpowers/specs/2026-11-11-self-improvement-loop-design.md`

**Architecture:** Module moi tach file (process-changes, series, selfdev, demote, retro) noi vao report engine, ledger job, evolve loop san co. Moi I/O co timeout/limit va `truncated:`; fail-open.

**Thu tu / song song:**
- Dot 1 (song song, tap file roi nhau): T1, T2, T3, T4, T5, T6, T7.
- Dot 2: T8 (can T1-T7 da merge).
- Dot 3: T9 (docs + full suite mot lan).
- T10 (hub, ngoai repo) doc lap, can nguoi dung duyet.

---

### Task 1: promptSignal bat du cau sua loi (A2) (RED/GREEN)
**Files:** `harness/core/audit/signals.mjs`, `harness/core/audit/signals.test.mjs`
- [x] Test do: prompt boc `<channel source="plugin:telegram">... sai roi ...</channel>` dai > 120 -> `'correction'`; `toi da noi la...`, `sao lai sua file do`, `tu gio dung lam vay` -> `'correction'`.
- [x] Test chong duong tinh gia (phai `null`): `dung cho test`, `dung lai file cu`, `Sai Gon`, `tu gio den mai`, `sua lai README`, prompt 2000 ky tu khong co cum.
- [x] Sua: ham `unwrap(raw)` bo `<channel ...>`/`</channel>` va khoi `<system-reminder>...</system-reminder>`; xet `strip(unwrap(raw)).slice(0, 300)`; bo early return `> CORRECTION_MAX` (doi thanh cat 300). Them cum co ngu canh vao `CORRECTION_PHRASE`/`CORRECTION_START` (xem spec 4.1).
- [x] Giu chu ky `promptSignal(prompt) -> 'correction'|null`; test cu van xanh.
- [x] Commit `audit signals: bo boc channel, them cum sua loi tieng Viet`.
**Done-when:** `timeout 120 node --test harness/core/audit/signals.test.mjs` -> `# fail 0`.

### Task 2: Toan tu filter `prefix` + sua KPI1, ms/session, nhan fp (B) (RED/GREEN)
**Files:** `harness/observe/ledger/engine.mjs`, test engine ledger canh no (builder Glob `harness/observe/ledger/*.test.mjs`, them vao file test engine hien co hoac tao `engine.test.mjs`), `harness/observe/report/defaults/kpi-info-fetch.json`, `harness/observe/report/defaults/cost-session.json`, `harness/observe/report/defaults/warnings.json`, test report engine canh `harness/observe/report/engine.mjs`.
- [x] Test do `matchOne`: `{prefix:['git status']}` khop `git status --short`, `cd x && git status`, khong khop `xgit status`; regression: chuoi bang tuyet doi, list, null giu nguyen ket qua cu.
- [x] Sua `matchOne` (~L150-159): nhanh object co `prefix` (mang chuoi, tran 50 phan tu, so sanh tren 2000 ky tu dau).
- [x] Test report: fixture audit Bash `git status --short` -> KPI1 > 0; fixture co PostToolUse `dur_ms` + Stop cumulative -> ms/session > 0 va token khong doi so voi truoc.
- [x] `kpi-info-fetch.json`: target -> `{"prefix": [...]}`. `cost-session.json`: filter cumulative chuyen vao tung cot token; cot ms co filter su kien tool. Neu token cumulative bi cong trung (nhieu Stop cung sid): ghi `shortcut:` va mo ta trong commit (khong mo rong pham vi).
- [x] `warnings.json`: cot "fp" doi nhan "fingerprints"; them cot `ignored`/`acted` neu ledger rows co `status` (count + filter).
- [x] Commit `observe: filter prefix, sua KPI1/ms per session, doi nhan fingerprints`.
**Done-when:** `timeout 120 node --test harness/observe/ledger/ harness/observe/report/` -> `# fail 0`.

### Task 3: Chi so thay doi quy trinh tu git (A1) (RED/GREEN)
**Files:** tao `harness/observe/report/process-changes.mjs`, `harness/observe/report/process-changes.test.mjs`, `harness/observe/report/defaults/kpi-process-changes.json`; sua `harness/observe/report/run.mjs` (chi phan nap input).
- [x] Test do (repo git tam qua `git init` trong `mkdtemp`, commit gia voi `GIT_COMMITTER_DATE`): dem theo tuan, `repeat` khi >= 2 lan sua cung file trong 14 ngay, bo file ngoai `paths`, thu muc khong phai repo -> `truncated: 'no_git'`, `maxCommits` cat -> `truncated: 'max_commits'`.
- [x] Viet `processChanges({projectDir, sinceDays, paths, timeoutMs, maxCommits, nowMs})` theo spec 4.2 (`spawnSync` co `timeout`, `maxBuffer` 4 MB; them `-c safe.directory=<dir>` cho NTFS).
- [x] `run.mjs`: nap ket qua giong `loadTasks` (fail-open), dua vao report qua nguon `process` (hoac rows inventory neu engine khong mo rong nguon - chon cach it dung engine nhat, ghi ly do trong commit).
- [x] Section `kpi-process-changes.json`: changes/tuan, so file sua lap.
- [x] Commit `report: chi so thay doi quy trinh tu git log`.
**Done-when:** `timeout 120 node --test harness/observe/report/process-changes.test.mjs` -> `# fail 0`.

### Task 4: Evolve kind `fix` + do hieu qua tong quat (C1) (RED/GREEN)
**Files:** `harness/evolve/loop/loop.mjs`, `harness/evolve/loop/autopilot.mjs`, `harness/evolve/loop/effect.mjs`, cac `.test.mjs` canh 3 file do.
- [x] Test do: `propose(cid, {kind:'fix', fixTarget:{area:'brief', path:'.claude/agents/builder.md'}})` tao proposal `status: proposed`, `change.target: null`, khong ghi file nao, co `target_metric.baseline_value`; `apply` kind fix KHONG ghi dich, chi doi status khi co co `--manual-done`; autopilot xep fix vao review-queue (level 2), khong bao gio auto-apply; `measureDue` do proposal fix applied, verdict ghi vao proposal, khong rollback.
- [x] Sua: `KINDS` them `fix`; `buildChange` nhanh fix (khong qua `classifyTarget`, vi khong ghi file); `LEVEL_BY_KIND.fix = 2`; `measureDue` loc `status==='applied' && (kind==='rule' || p.target_metric)`; rollback tu dong van chi cho rule autopilot.
- [x] Test cu cua loop/autopilot/effect van xanh.
- [x] Commit `evolve: kind fix (chi hang doi) + do hieu qua moi de xuat co target_metric`.
**Done-when:** `timeout 180 node --test harness/evolve/loop/loop.test.mjs harness/evolve/loop/autopilot.test.mjs harness/evolve/loop/effect.test.mjs` -> `# fail 0` (builder Glob ten file test thuc neu khac).

### Task 5: Tu ha cap rule evolve vo ich (C2) (RED/GREEN)
**Files:** tao `harness/evolve/loop/demote.mjs`, `harness/evolve/loop/demote.test.mjs`; sua `harness/observe/ledger/job.mjs` (chi 1 cho goi, sau autopilot).
- [x] Test do: rule origin evolve, autopilot-applied, 14 ngay warned 6 / acted 0 / ignored 4 -> goi rollback (stub); rule khong do autopilot -> chi ghi `demote_suggested`; rule protected / mac dinh plugin / `<project>/.harness/rules` -> bo qua; warned 4 -> khong lam gi; tran 10 rule/lan; guard 24h.
- [x] Viet `demoteRules({ledgerEntries, rules, nowMs, cfg})` thuan + wrapper I/O co timeout 10s.
- [x] `job.mjs`: goi sau autopilot trong try/catch (fail-open).
- [x] Commit `evolve: tu ha cap rule evolve khong hieu qua`.
**Done-when:** `timeout 120 node --test harness/evolve/loop/demote.test.mjs` -> `# fail 0`.

### Task 6: Chuoi thoi gian KPI append-only (F1) (RED/GREEN)
**Files:** tao `harness/evolve/loop/series.mjs`, `harness/evolve/loop/series.test.mjs`.
- [x] Test do: `appendSnapshot(file, {week, kpi, selfdev})` chi append, cung tuan -> `rev+1`; `readSeries` lay dong cuoi moi tuan, bo dong hong, tran 200 dong / 2 MB -> `truncated`; `trend(series, key, 8)` cho spark dung do dai, `slope` OLS, `vs_prev_pct`, `vs_baseline_pct`, `direction` flat khi |slope| < 5% trung binh; null an toan.
- [x] Viet module theo spec 4.4 (ham `isoWeek(date)` dung chung, export).
- [x] Commit `evolve: chuoi KPI theo tuan + trend`.
**Done-when:** `timeout 120 node --test harness/evolve/loop/series.test.mjs` -> `# fail 0`.

### Task 7: Chi so kha nang tu phat trien (F2) (RED/GREEN)
**Files:** tao `harness/evolve/loop/selfdev.mjs`, `harness/evolve/loop/selfdev.test.mjs`.
- [x] Test do (input fixture thuan): `self_initiated_rate`, `time_to_fix_h` (trung vi), `time_to_verify_h`, `effective_rate`, `rollback_rate`, `repeat_correction_rate`, `repeat_errors_resolved` dung cong thuc spec 4.5; mau 0 -> `null` (khong chia 0); moi chi so kem `better: 'up'|'down'`.
- [x] Viet `selfdevMetrics({ appliedLog, proposals, ledgerEntries, effects, processChanges, signals, weekStartMs, weekEndMs })` thuan; `compositeDirection(trends)` tra `improving|flat|worse` (>= 2 chi so cung chieu xau/ngang).
- [x] Commit `evolve: chi so kha nang tu phat trien`.
**Done-when:** `timeout 120 node --test harness/evolve/loop/selfdev.test.mjs` -> `# fail 0`.

### Task 8: `harness evolve retro` + nguong tu kiem (D + F3) (RED/GREEN) - sau T1-T7
**Files:** tao `harness/evolve/loop/retro.mjs`, `harness/evolve/loop/retro.test.mjs`; sua CLI evolve va `manifest.json` cua domain evolve (builder Glob `harness/evolve/**/cli*.mjs`, `harness/evolve/**/manifest.json`); sua `harness/observe/report/run.mjs` HOAC `harness/observe/ledger/job.mjs` (mot cho kich, guard isoWeek).
- [x] Test do (data dir tam): retro ghi `<week>.json|md` + append series; top-3 van de co `key` on dinh; bang hieu qua thay doi; 2 tuan lien selfdev `flat|worse` -> 1 task `[P0] self-improvement stalled: ...` trong ke hoach emit; `--apply` goi runner (stub) toi da 3 + 1 P0/tuan, dedupe qua `emitted.json`; khong `--apply` -> khong goi runner; runner loi/timeout -> van ghi bao cao (fail-open); het `timeoutS` -> `truncated: 'timeout'`.
- [x] Viet `retro({ apply, nowMs, dataDir, runner })` theo spec 4.6; runner mac dinh `spawnSync(process.execPath, [cli, 'projects', 'add-task', ...], {timeout: 10000})` va `knowledge add` (co flag thuc kiem bang `harness knowledge --help` neu co, nguoc lai chi in).
- [x] CLI `harness evolve retro [--apply] [--json]` + dang ky manifest (limit/timeout, `--raw`).
- [x] Kich tu dong 1 lan/isoWeek, KHONG `--apply` tru khi config `retro.autoApply: true`.
- [x] Commit `evolve: retro hang tuan, chuoi thoi gian, nguong tu kiem P0`.
**Done-when:** `timeout 180 node --test harness/evolve/loop/retro.test.mjs` -> `# fail 0`; `timeout 60 node harness/cli/harness.mjs evolve retro --json` tren data dir tam tra JSON co `kpi`, `trend`, `selfdev`, `issues`.

### Task 9: Docs + full suite mot lan (sau T8)
**Files:** `harness/evolve/README.md`, `harness/observe/report/README.md`, `CHANGELOG.md`.
- [ ] README evolve: kind fix, demote, retro, series, selfdev, nguong. README report: toan tu prefix, nguon process, doi nhan fingerprints.
- [ ] CHANGELOG muc moi.
- [ ] Full suite mot lan, nen, log ra file: `timeout 900 node --test > /tmp/<scratch>/full.log 2>&1`; bao `# pass/# fail`.
- [ ] Commit `docs: self-improvement loop`.
**Done-when:** full suite `# fail 0` (trich dong tong ket).

### Task 10 (hub, ngoai repo harness-kit; can nguoi dung duyet)
**Files:** `/media/networld/11. Agents/.claude/agents/builder.md`, `/media/networld/11. Agents/AGENTS.md`, co the `/media/networld/11. Agents/.rgignore`.
- [ ] Main chay `harness observe query` nhom loi "Ripgrep search timed out" theo cwd/target (scout khong co Bash) de xac nhan nguyen nhan truoc khi them `.rgignore`.
- [ ] Bo `isolation: worktree` khoi builder.md (hoac them `project-builder`), AGENTS.md ghi ro builder project tu tao worktree trong repo du an.
- [ ] Sau 1 tuan: retro phai thay fp "isolated in the worktree" giam (do bang `effect` qua proposal kind fix tao cho thay doi nay).
**Done-when:** sau thay doi, 7 ngay audit co loi isolation < 10% muc nen 343/tuan.
