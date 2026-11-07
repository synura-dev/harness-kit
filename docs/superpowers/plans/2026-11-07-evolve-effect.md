# Evolve effect measurement (harness-kit-0060) Implementation Plan

> For agentic workers: SDD, one builder per Task, sequential. Steps use `- [ ]`. Tests: bun:test, `.test.mjs` next to source (`bun test <file>`). Comments in repo language (Vietnamese no accents). Spec: `docs/superpowers/specs/2026-11-07-evolve-effect-design.md`.

**Goal:** evolve rule da apply duoc do hieu qua (rate loi / 1000 tool call), giu/rollback theo verdict, hien trong list/log.

**Real code (verified):** `harness/evolve/loop/loop.mjs` (`apply` :215-257, `appendLog` :33, `findCandidates` :67, `ctx` :27, KINDS :20), `autopilot.mjs` (CFG :15-17, `shouldRollback` :58, rollback block :150-165, oracleDays scan :172), `cli.mjs` (list/log), `core/audit/candidates.mjs` (`repeatedFailureCandidates`, gom nhom fp, `isHookRun`), `core/config/audit-config.mjs` (`limits.query_timeout_ms/max_rows/max_bytes`), `observe/audit/audit.mjs` (envelope: `type,event,ok,tool,sid,data.signal,tokens_in/out`). Fixture style: `autopilot.test.mjs` (tmp dir, `writeAudit(date,sid,recs)` -> `audit/date=D/type=tool/<sid>.jsonl`, `fail()`, `o = {hubRoot,dataBase,dataRoot,auditDir,ledgerFile,nowMs}`).

---

### Task 1: effect.mjs + baseline luc apply (RED/GREEN)
Files: create `harness/evolve/loop/effect.mjs`, `harness/evolve/loop/effect.test.mjs`; modify `harness/evolve/loop/loop.mjs` (apply: chup baseline), `harness/evolve/loop/loop.test.mjs` (1 test baseline).
- [x] Failing tests truoc (`effect.test.mjs`): (a) `verdictOf(before, after)` thuan: 0.7x -> better, 1.3x -> worse, 1.0x -> unchanged, bien chinh xac 0.7/1.3; (b) insufficient khi after `tool_calls` < `EFFECT.minToolCalls` hoac baseline `target_count` < 3; het 21 ngay -> inconclusive; (c) metric phu te hon >= 30% -> `side` co co, verdict khong doi; (d) `computeWindow(auditDir, fpGroups, from, to, opts)` tren fixture audit dir: dem dung target_count/tool_calls/sessions/tokens_per_session/corrections_per_session, loai HookRun; (e) `measureDue` hai proposal den han -> chi MOT luot doc audit (dem so lan doc qua opts hook); (f) truncated (limits timeout/maxRows nho) -> insufficient reason `truncated`; (g) proposal khong co baseline -> tinh bu tu audit neu con trong cua so, khong thi `no_baseline`; (h) proposal chua den han / da co verdict cuoi bi bo qua.
- [x] Failing test `loop.test.mjs`: sau `apply` cua rule, `proposal.effect.baseline` co `{window_days:7, from, to, target_count, tool_calls, rate_per_1000, sessions}`; kind khac khong co.
- [x] Implement `effect.mjs`: `EFFECT` defaults (windowDays 7, ratios 0.7/1.3, minToolCalls 200, minBaselineErrors 3, maxRecheckDays 21, sidePct 0.3), `computeWindow`, `verdictOf`, `measureDue(proposals, now, opts)` -> `[{id, effect}]` (khong ghi). Mot luot doc, limits tu audit-config, dung lai gom nhom/isHookRun cua candidates.mjs.
- [x] Hook baseline trong `apply` (chi `p.kind==='rule'`, sau khi apply thanh cong; loi baseline khong lam hong apply -> `effect.baseline = null` + reason).
- [x] Run: `timeout 120 bun test harness/evolve/loop/effect.test.mjs harness/evolve/loop/loop.test.mjs` (red roi green).

Done: test tren xanh; `apply` khong doi hanh vi cho kind khac.

### Task 2: Tich hop autopilot + CLI + README (RED/GREEN)
Files: `harness/evolve/loop/autopilot.mjs`, `autopilot.test.mjs`, `cli.mjs`, `cli.test.mjs`, `harness/evolve/README.md`.
- [x] Failing tests truoc (`autopilot.test.mjs`): (a) rule da apply >=7 ngay, rate giam <=0.7 -> better, KHONG rollback, `kept`; (b) rate khong doi -> rollback + ly do; (c) rate tang >=1.3 -> rollback; (d) mau nho (tool_calls < min) -> insufficient, khong hanh dong, do lai lan sau; (e) qua 21 ngay van insufficient -> inconclusive, giu; (f) moi verdict ghi dong `op:'effect'` vao `applied.jsonl` va `proposal.effect`; (g) regression bug cu: before va after cung don vi per-1000, cua so 30 ngay khong anh huong.
- [x] Failing test `cli.test.mjs`: `evolve list` co cot verdict; `evolve log` hien dong effect.
- [x] Go khoi rollback cu (autopilot.mjs:150-165) va `shouldRollback` neu khong con dung; goi `measureDue` mot lan; `better|inconclusive` -> giu, `unchanged|worse` -> `rollback(ver, {approve:true})` (chi rule muc 1) ghi ly do, `insufficient` -> khong lam gi; ton trong `timeUp()`. Ghi effect vao proposal + applied.jsonl.
- [x] `cli.mjs`: cot verdict trong list, dong effect trong log.
- [x] README `harness/evolve/README.md`: them muc do hieu qua (baseline, verdict, nguong); sua drift (README noi chi con kind `skill`, trong khi code van co `rule`/`inject`, loop.mjs KINDS :20).
- [x] Run: `timeout 120 bun test harness/evolve/loop/autopilot.test.mjs harness/evolve/loop/cli.test.mjs`.
- [x] Cuoi: full suite MOT lan, nen, co timeout: `timeout 300 bun test harness dev > <log> 2>&1` (lenh trong `dev/README.md:7`); bao ket qua.

Done: test hep xanh, full suite xanh, README khop code.
