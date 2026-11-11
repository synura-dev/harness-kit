# Vong tu cai tien do duoc (self-improvement loop) - design

Ngay: 2026-11-11. Trang thai: draft, cho duyet.
Chi dao nguoi dung (2026-11-11): "Neu da la quy trinh thi tu phat trien va tu kiem chung su phat trien cua ban than theo thoi gian." Bo sung: phai do duoc (1) su phat trien theo thoi gian va (2) kha nang tu phat trien.

## 1. Van de (bang chung)

Bao cao observe 7 ngay (main chuyen) cho thay vong evolve hien tai khong tu cai tien that:

| Trieu chung | Nguyen nhan (da xac nhan tai file:dong) |
|---|---|
| KPI1 (info fetch) khong co du lieu | `observe/report/defaults/kpi-info-fetch.json` loc `target: [...]` ("git status", ...) nhung `matchOne` trong `harness/observe/ledger/engine.mjs` (~L150-159) chi so bang tuyet doi / thuoc list; target la ca lenh nen khong bao gio khop. |
| ms/session = 0 | `defaults/cost-session.json` loc cap section `data.usage_mode: cumulative` (chi su kien Stop co); `dur_ms` chi co o PostToolUse/Failure -> `sum:dur_ms` luon 0. |
| KPI3 corrections chi 7 (dem thieu) | `harness/core/audit/signals.mjs:26,32` bo moi prompt > 120 ky tu; tin Telegram boc `<channel source="...telegram">` nen vuot 120 (suy luan). Thieu cum sua loi tieng Viet thuong gap ("toi da noi", "sao lai", "tu gio"...). |
| "87 warns, 50 fp" doc nham thanh 50 false positive | `defaults/warnings.json` cot "fp" = `count` entry ledger = so dau van tay khac nhau, khong phai false positive. Tin hieu nhieu that la ledger `ignored` vs `acted` (`observe/ledger/ledger.mjs` `resolveOutcome` ~L115-129). |
| 6 de xuat evolve deu kind rule, acted=0, cuoi cung 2026-11-08 | `evolve/loop/loop.mjs:20` `KINDS = skill|rule|inject`; khong co loai "sua goc" (hook/script/brief). `effect.mjs` `measureDue` chi do `kind==='rule' && status==='applied'`. Khong co co che ha cap rule vo ich. |
| Nguoi dung tu sua quy trinh nhieu (AGENTS.md 15x, CLAUDE.md 6x, .claude/agents 14x, 33 memory feedback tu 2026-11-01; docs-storage.md sua lai 5 lan) | Khong co chi so nao do "thay doi quy trinh" hay "sua lap"; evolve khong thay. |
| Loi lap top: "This agent is isolated in the worktree" 343x/34 phien; "Ripgrep search timed out" 62x/16 phien | Ca hai do Claude Code sinh, khong phai code harness. Isolation: hub `.claude/agents/builder.md:9` `isolation: worktree` trong khi builder phai `git -C <project> worktree add` (memory `builder-worktree-isolation.md` 2026-11-10 da ghi). Ripgrep: chua chan doan (gia dinh: Grep tren thu muc data/audit lon hoac NTFS). |
| Pattern "Bash:git x N + SubagentHandback" 137x | Merge Task lam tay; chi la de xuat, ngoai pham vi spec nay (xem 8). |

## 2. Muc tieu

1. So lieu dung: sua 3 loi do luong (KPI1, ms/session, corrections) va doi nghia cot "fp".
2. Do duoc thay doi quy trinh do nguoi dung lam (git log tren file quy tac) va sua lap.
3. Evolve de xuat duoc "sua goc" (kind `fix`, chi xep hang doi, khong tu ap) va tu ha cap rule vo ich.
4. Moi tuan mot `retro` may tu tinh: KPI, hieu qua tung thay doi, top-3 van de moi, chuoi thoi gian N tuan, chi so kha nang tu phat trien, nguong tu kiem tao task P0.
5. Nhe, co gioi han (timeout, limits, `truncated:`), fail-open, khong luu van ban prompt.

Khong muc tieu: tu sua hook/script/.claude (policy cam, giu nguyen); tu push/deploy; doc MongoDB.

## 3. Cac phuong an da can nhac

- A. Them module rieng cho tung nhom (process-changes, series, selfdev, demote, retro) va noi vao report/ledger job san co. **Chon**: tap file tach biet -> builder song song; tai dung engine report, ledger, effect, limits.
- B. Mot "retro agent" (LLM) doc report va viet nhan xet. Loai: trai nguyen tac machine-first, ton token, khong lap lai duoc.
- C. Mo rong policy cho evolve tu sua hook/brief. Loai: vung nhay cam (guard/.claude), nguoi dung chua cho phep.

## 4. Thiet ke

### 4.1 Sua do luong (Task B, A2)
- `matchOne` them toan tu tuong thich nguoc: gia tri filter dang object `{"prefix": [..]}` khop khi chuoi bat dau bang mot phan tu, hoac co phan tu do ngay sau `&& `, `; `, `| `. Gia tri cu (chuoi/list) giu nguyen nghia. Toan tu `prefix` dung chung cho ledger rules -> test hoi quy bat buoc.
- `kpi-info-fetch.json`: doi `target` sang `{"prefix": [...]}`.
- `cost-session.json`: bo filter cap section; cot token co filter rieng `data.usage_mode: cumulative`; cot ms co filter rieng tren su kien tool (`event` PostToolUse|PostToolUseFailure) hoac bo cot neu engine khong ho tro per-column cho do. Cot token tren ban ghi cumulative: kiem va ghi chu rui ro dem trung (effect.mjs `statsOf` lay max theo sid); neu engine khong co metric "max theo sid", them metric `sum_max_per_session` nho (trong Task B) hoac ghi `shortcut:`.
- `warnings.json`: doi nhan cot "fp" -> "fingerprints"; them cot `ignored` va `acted` (count co filter status) neu nguon ledger co truong do.
- `promptSignal`: (1) bo boc `<channel ...>...</channel>` va khoi `<system-reminder>` truoc khi do dai; (2) chi xet toi da 300 ky tu dau sau khi bo boc (thay vi bo ca prompt > 120); (3) them cum: `toi da noi|da bao|sao lai|lai nua|tu gio (tro di)?|dung co|khong duoc` (cum co ngu canh, tranh "dung" don le vi trung "dung/dung"); (4) gia tri tra ve giu `'correction' | null`. Test chong duong tinh gia ("dung cho", "dung lai file", "Sai Gon", "tu gio den mai").

### 4.2 Thay doi quy trinh (Task A1) - `harness/observe/report/process-changes.mjs`
- `processChanges({ projectDir, sinceDays=28, paths, timeoutMs=8000, maxCommits=500, nowMs })`: `spawnSync git -C <dir> log --since=<iso> --name-only --format=%H%x09%cI` co timeout; khong phai repo/khong co git -> `{ items: [], truncated: 'no_git' }`.
- `paths` mac dinh: `AGENTS.md`, `CLAUDE.md`, `.claude/agents/`, `.agents/agents/`, `.claude/memory/`; config ghi de qua `<project>/.harness/report/process-changes.json` (tuy chon, mac dinh du).
- Tra ve: `{ weeks: [{ week, changes, files }], files: [{ path, edits, last_ts }], repeat: [{ path, edits }] (edits >= 2 trong 14 ngay), truncated }`. Chi ten file va so lan, khong noi dung diff.
- Report: section moi `defaults/kpi-process-changes.json` voi nguon moi `process` (run.mjs nap truoc nhu `loadTasks`). Neu engine khong nhan nguon moi, run.mjs dua ket qua vao inventory-like rows.

### 4.3 Evolve "fix" va ha cap (Task C1, C2)
- C1: `KINDS` them `fix`. De xuat fix khong ghi file nao: `change = { target: null, fix_target: { area: hook|script|brief|doc|config, path: '<text>' }, after: <mo ta + bang chung> }`, `target_metric: { fp | metric, baseline_value, window_days }`, `status: proposed -> approved (TTY/nguoi) -> applied (nguoi/main danh dau sau khi sua tay) -> measured`. `autopilot.LEVEL_BY_KIND.fix = 2` (chi xep hang doi review, khong bao gio tu ap). `measureDue` mo rong: do moi kind co `target_metric` va status `applied`; kind khac rule KHONG rollback tu dong, chi ghi verdict.
- C2: `harness/evolve/loop/demote.mjs`: voi moi rule origin evolve trong `<dataDir>/evolve/rules/`: neu trong 14 ngay `warned >= 5`, `acted == 0`, `ignored/warned >= 0.5` -> autopilot-applied: rollback qua `loop.rollback`; con lai: chi ghi `demote_suggested` vao applied.jsonl. Khong dung rule protected, rule mac dinh cua plugin, rule `<project>/.harness/rules` cua nguoi dung. Goi tu `observe/ledger/job.mjs` sau autopilot, toi da 1 lan/24h, tran 10 rule/lan.

### 4.4 Chuoi thoi gian (F1) - `harness/evolve/loop/series.mjs`
- File append-only `<dataDir>/evolve/retro/kpi-series.jsonl`, moi dong `{ week: 'YYYY-Www', ts, rev, kpi: { <ten>: number|null }, selfdev: {...} }`. Khong ghi de: tinh lai cung tuan -> them dong `rev+1`; doc lay dong cuoi moi tuan.
- `trend(series, key, n=8)`: `{ values, spark (▁▂▃▄▅▆▇█, null -> ' '), slope (OLS/tuan), vs_prev_pct, vs_baseline_pct, direction: up|down|flat }` (flat khi |slope| < 5% trung binh). Baseline lay tu `ledger/report-baseline.json` neu co.
- Gioi han: doc toi da 2 MB / 200 dong cuoi; dong hong bo qua.

### 4.5 Chi so kha nang tu phat trien (F2) - `harness/evolve/loop/selfdev.mjs`
Ham thuan (input da doc san, khong I/O) -> de test:
| Chi so | Cong thuc | Nguon | Huong tot |
|---|---|---|---|
| `self_initiated_rate` | thay doi do he thong (evolve `apply` + fix `applied` trong tuan) / (do + so commit file quy tac cua A1) | `applied.jsonl`, proposals, A1 | tang |
| `time_to_fix_h` | trung vi gio: ledger `first_ts` -> proposal `applied` ts; va -> verdict ts (`time_to_verify_h`) | ledger, proposals, effect | giam |
| `effective_rate` | verdict `better` / so da do xong; kem `rollback_rate` = rolled_back / applied | effect results, applied.jsonl | tang / giam |
| `repeat_correction_rate` | (corrections+interrupt)/phien tu A2; kem `repeat_files` tu A1 | audit signal, A1 | giam |
| `repeat_errors_resolved` | ledger repeated-error `resolved` / (open+warned+resolved) | ledger | tang |
Gioi han da biet: commit deu ghi ten nguoi dung (quy tac khong co-author) nen khong tach "agent sua" vs "nguoi sua" bang git author; quy uoc: moi thay doi file quy tac qua git = do nguoi chi dao (user-directed), moi thay doi qua evolve = tu khoi xuong. Ghi ro trong retro.

### 4.6 Retro hang tuan (Task D + F3) - `harness/evolve/loop/retro.mjs`, lenh `harness evolve retro`
- Tinh: KPI tu `buildReport` (run.mjs), A1, selfdev; append series; tinh trend.
- Bao cao `<dataDir>/evolve/retro/<week>.json|md`: KPI + sparkline/do doc/so voi tuan truoc & nen; bang hieu qua moi thay doi da ap (keep/rollback goi y); top-3 van de moi (ledger/candidates/A1 repeat), moi van de kem `key` on dinh.
- F3 nguong tu kiem: neu chi so tong hop selfdev (hoac >= 2 chi so trong bang 4.5) `flat` hoac xau di 2 tuan lien -> tao task P0 (summary bat dau `[P0] self-improvement stalled: ...`) va ghi muc "Tu kiem" trong bao cao.
- `--apply`: `spawnSync harness projects add-task --project harness-kit --summary ...` va `harness knowledge add ...` (timeout 10s moi lenh, fail-open), dedupe theo `key` luu `<dataDir>/evolve/retro/emitted.json`, tran 3 task + 1 task P0/tuan. Khong `--apply` -> in van ban cho main.
- Kich: sau weekly report (`kickReport` / `cli --weekly`) hoac ledger job, guard 1 lan/isoWeek. Mac dinh trigger tu dong chay `retro` khong `--apply` (chi ghi file); `--apply` tu dong bat bang config (cho nguoi dung quyet, muc 7).
- Gioi han: `RETRO = { timeoutS: 30, maxIssues: 3, maxTasksPerWeek: 4, seriesWeeks: 8 }`, het han -> `truncated: timeout`.

### 4.7 Phia hub (Task E, ngoai repo harness-kit)
- `/media/networld/11. Agents/.claude/agents/builder.md:9` bo `isolation: worktree` hoac them agent `project-builder` khong isolation; AGENTS.md ghi ro. Can nguoi dung duyet (dung `.claude/**`).
- Ripgrep timeout: chan doan truoc bang `harness observe query` nhom theo cwd/target cua loi; neu do data/audit: them `.rgignore` cho `data/`, `.harness/data/`, `node_modules/`.

## 5. Du lieu va quyen rieng tu
- Khong luu van ban prompt (giu prompt_hash/prompt_kw nhu cu). Retro/series/knowledge chi chua so, ten file, fp, mau da redact (`redact()` cua loop.mjs).
- Git log chi lay hash, ngay, ten file. Khong noi dung diff.
- `harness knowledge add` chi nhan tom tat so lieu.

## 6. Kiem thu
- TDD cho moi ham logic (`node --test <file>`), fixture tam (`fs.mkdtempSync`), khong cham data that.
- Test hoi quy `matchOne` cho toan bo dang filter cu.
- Test duong tinh gia cho `promptSignal`.
- Full suite mot lan cuoi dot.

## 7. Cau hoi / gia dinh
- Nguong mac dinh (gia dinh): sua lap = >= 2 lan sua cung file trong 14 ngay; ha cap = warned >= 5 & acted = 0 & ignored/warned >= 0.5 trong 14 ngay; flat = |do doc| < 5%; tu kiem = 2 tuan lien.
- Retro tu `--apply` (tao task/knowledge) hay chi in? Mac dinh: chi ghi file; bat `--apply` tu dong khi nguoi dung dong y.
- Co `--priority` trong `harness projects add-task` khong: chua kiem -> dung tien to `[P0]` trong summary.
- Co phep sua hub `.claude/agents/builder.md` (Task E) khong.

## 8. Ngoai pham vi
- Tu dong hoa merge Task (pattern git x N, 137x): de xuat rieng (playbook `harness play merge-task`), spec sau.
