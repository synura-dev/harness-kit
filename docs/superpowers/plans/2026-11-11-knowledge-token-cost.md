# Knowledge token cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Mỗi Task = một builder trong worktree riêng (`git -C "/media/networld/06. Projects/harness-kit" worktree add ".worktrees/<task>" -b <branch>`); Task H1 làm trong repo hub. Bước dùng checkbox (`- [ ]`).

**Goal:** Đo tất định hao token theo vấn đề (lần đầu vs lần lặp, một/nhiều vấn đề), ROI tri thức, thuế context, trùng nội dung; nối vào report tuần + retro, không gọi model, không tự xoá.

**Architecture:** Audit thêm 2 số đo (`data.out_len`, `data.usage.first_ctx`). Report engine thêm source `derived` gọi các hàm thuần (`problems` -> `cost-repeat`, `knowledge-roi`, `context-tax`), xuất section `kpi-*` khoá ổn định -> retro series/selfdev/F3. Trùng nội dung ở `evolve/usage/content-dupes.mjs` + lệnh `harness evolve dupes-content` (tên `dupes-content` thay `dupes` của spec để không trùng `usage/dupes.mjs`), `--propose` tạo proposal `kind fix` đo bằng metric.

**Tech Stack:** Bun, ESM `.mjs`, `bun:test`; spawn qua `harness/core/runtime/proc.mjs`; giới hạn theo `limits` trong `defaults.mjs` (trả `truncated: timeout|max_*`).

Spec: `docs/superpowers/specs/2026-11-11-knowledge-token-cost-design.md`.

## Quy tắc chung cho mọi builder
- Kiểm hình dạng dữ liệu theo CODE GHI audit (`harness/observe/audit/audit.mjs`, `usage-tail.mjs`), không theo fixture cũ. Đường dẫn trong plan đã xác minh ở mức thư mục; nếu file test khác tên, Glob trong `harness/<nhóm>/` rồi dùng file đúng, ghi vào báo cáo.
- Khoá series/KPI KHÔNG chứa số tuần, đường dẫn, tên file (bộ lọc `pickKpi` retro.mjs:50-56 sẽ bỏ).
- Trước khi thêm section/khoá: `Grep "sections|length\\)\\.toBe|toHaveLength|Object.keys" ` trong `harness/observe/report/*.test.mjs` và `harness/evolve/loop/retro.test.mjs`; cập nhật mọi test cứng số đếm (retro.test.mjs:25,53-57,117,121,228 đã biết).
- Không ghi nội dung prompt/tool_response/khối văn bản vào audit, retro, knowledge, proposal; chỉ số, hash, `file:dòng`.
- Helper mới đăng ký trong `manifest.json` của nhóm (`files`) nếu nhóm đó liệt kê file.
- TDD: viết test đỏ trước, chạy test hẹp, rồi code cho xanh. Commit local, không push, không co-author, tick checkbox Task của mình trong commit.
- Trần ~25 lượt tool/Task; báo cáo <= 40 dòng.

## Thứ tự / song song
- Nhóm 1 (song song): Task 0, Task 1, Task H1 (hub).
- Nhóm 2: Task 2 (cần 1).
- Nhóm 3: Task 3 (cần 2) -> Task 4 (cần 3).
- Nhóm 4 (song song, cần 2; Task 5 cần 3): Task 5, Task 6, Task 7.
- Nhóm 5 (song song): Task 8 (cần 7), Task 9 (cần 4, 6).
- Nhóm 6: Task 10 kiểm dữ liệu thật (haiku) -> Task 11 full suite một lần.

---

### Task 0: Audit ghi `out_len` và `first_ctx` (chỉ số, không nội dung)

**Files:**
- Modify: `harness/observe/audit/audit.mjs` (PostToolUse Bash ~:229-250)
- Modify: `harness/observe/audit/usage-tail.mjs` (`sumUsage` :29-40)
- Test: `harness/observe/audit/audit.test.mjs`, `harness/observe/audit/usage-tail.test.mjs`
- Modify: `harness/observe/README.md` (:21-33 thêm 2 trường; :77 sửa câu "cache-creation không được audit ghi" thành đúng: `tokens_in` gồm cache_creation, `data.usage` tách riêng)

- [x] Test đỏ: PostToolUse Bash với `tool_response {stdout:'abc', stderr:'de'}` -> `data.out_len === 5`; response chuỗi -> độ dài chuỗi; không response -> không có trường; KHÔNG có `stdout` trong record (assert `JSON.stringify(rec)` không chứa 'abc').
- [x] Test đỏ: `sumUsage` trên 2 message assistant -> `first_ctx = input + cache_creation + cache_read` của message ĐẦU trong delta; delta rỗng -> không có `first_ctx`.
- [x] Code: tính độ dài trên giá trị đã có trong payload, không lưu chuỗi; cắt trần `Number.MAX_SAFE_INTEGER` không cần, chỉ `Math.min(len, 1e9)`.
- [x] Cập nhật README.
- [x] Done-when: `timeout 60 bun test harness/observe/audit/audit.test.mjs harness/observe/audit/usage-tail.test.mjs` -> 0 fail.
- [x] Commit `audit: ghi out_len Bash va usage.first_ctx (chi so)`.

### Task 1: Hợp đồng Segment + LIMITS

**Files:**
- Create: `harness/observe/report/cost-contract.mjs`
- Test: `harness/observe/report/cost-contract.test.mjs`

- [x] Export `LIMITS = {maxEvents: 200000, maxSegments: 5000, maxProblems: 2000, timeoutMs: 15000, lookbackDays: 28, indexTtlDays: 90, cacheReadWeight: 0.1, minSide: 3, maxDupPairs: 50, maxBlocks: 3000}`.
- [x] Export `emptySegment()`, `effTokens(t)` = `input + cache_creation + output + cacheReadWeight*cache_read`, `median(arr)` (rỗng -> null), `foldText(s)` (lowercase, `đ->d`, NFD bỏ dấu, gộp khoảng trắng) - dùng chung cho D/E.
- [x] Shape Segment (JSDoc): `{sid, start_ts, end_ts, prompt_kw, keys:{task,plan,branch,fp,kw}, problem, precision, family, tokens:{input,output,cache_read,cache_creation}, eff_tokens, turns, tools, fetches, kfetch:[ids], wall_ms, sub_tokens}`.
- [x] Test: effTokens, median chẵn/lẻ/rỗng, foldText ("Đường dẫn" -> "duong dan").
- [x] Done-when: `timeout 30 bun test harness/observe/report/cost-contract.test.mjs` -> 0 fail.
- [x] Commit.

### Task 2: Engine source `derived`

**Files:**
- Modify: `harness/observe/report/engine.mjs` (SOURCES :12, `windowInputs` :142-151)
- Modify: `harness/observe/report/run.mjs` (`buildReport` :85-105: cấp `derived` map, chỉ tính khi có section dùng, như process :101-102)
- Modify: `harness/observe/report/README.md` (mô tả source `derived`, `derive`)
- Test: `harness/observe/report/engine.test.mjs`, `harness/observe/report/run.test.mjs`

- [x] Test đỏ: section `{source:'derived', derive:'x', group_by:['k'], metric:'sum:v', format:'kpi'}` với `opts.derived = {x: ({events,from,to}) => [{k:'a',v:2}]}` -> hàng key `a` giá trị 2; derive không tồn tại -> section rỗng + `empty_note`, không throw; hàm throw -> fail-open, ghi `error: derive_failed`.
- [x] Test: `kpiSnapshot` cho section này ra khoá `<id>.a`.
- [x] Code engine + run (`opts.derived` cho phép test tiêm; mặc định import lazy 3 module Task 4/6/7 - module chưa có thì bỏ qua, fail-open).
- [x] Grep test số đếm SOURCES/section; cập nhật.
- [x] Done-when: `timeout 60 bun test harness/observe/report/engine.test.mjs harness/observe/report/run.test.mjs` -> 0 fail.
- [x] Commit.

### Task 3: Khoá vấn đề `problems.mjs`

**Files:**
- Create: `harness/observe/report/problems.mjs`
- Test: `harness/observe/report/problems.test.mjs`

- [x] `segment(events, {limits})` -> `{segments, truncated}`: tách theo sid, cắt tại type `prompt`; token = cộng `data.usage` các Stop trong đoạn; subagent = MAX lũy kế `tokens_in/out` theo `agent_id` của SubagentStop có SubagentStart trong đoạn (cộng các agent, không cộng lặp cùng agent); tools = số PostToolUse/PostToolUseFailure; fetches = Bash target khớp tiền tố `kpi-info-fetch.json` hoặc `harness knowledge (get|search)`; `kfetch` = id sau `knowledge get`.
- [x] Khoá ưu tiên task > plan > branch (bỏ `agent-[0-9a-f]{6,}`) > err > kw; đoạn không khoá thừa khoá đoạn trước cùng sid; `precision` high|mid|low; family (err -> id ledger entry chứa fp qua tham số `ledger`, khác -> `<loại>:<slug>`).
- [x] Lọc sự kiện noise như engine (`origin noise`/HookRun).
- [x] Test (fixture dựng theo field thật của audit.mjs): 2 prompt 1 sid; plan path spec+plan cùng slug; worktree `agent-a970ef` bị bỏ; thừa khoá; phantom SubagentStop không token -> sub_tokens 0; vượt `maxSegments` -> `truncated:'max_segments'`.
- [x] Done-when: `timeout 30 bun test harness/observe/report/problems.test.mjs` -> 0 fail.
- [x] Commit.

### Task 4: Lần đầu vs lần lặp `cost-repeat.mjs` + section

**Files:**
- Create: `harness/observe/report/cost-repeat.mjs`
- Create: `harness/observe/report/defaults/kpi-cost-repeat.json`, `harness/observe/report/defaults/cost-by-family.json` (format table)
- Modify: `harness/observe/report/run.mjs` (cờ `persistIndex` khi `--weekly`; `--bootstrap-days N`)
- Test: `harness/observe/report/cost-repeat.test.mjs`

- [ ] `costRepeat({events, from, to, index, persist, now})` -> rows `{k, v}`: `repeat_vs_first_ratio`, `tokens_per_problem`, `problems`, `repeat_share`, `key_coverage`, `cache_read_share`; `byFamily` rows cho bảng.
- [ ] Index `problems-index.json` trong thư mục dữ liệu report (dùng helper đường dẫn sẵn có của report, không hardcode): trần 2000, TTL 90 ngày, ghi atomic (temp + rename), chỉ khi `persist`.
- [ ] Test: khoá xuất hiện phiên 1 (1000 eff) và phiên 2,3 (400, 600) -> ratio 0.5; lần đầu nằm trong index cũ -> phiên trong cửa sổ đều là lặp; `persist:false` không tạo file (tmp dir); chỉ khoá high|mid vào ratio.
- [ ] Grep + cập nhật test số section (run/noext/engine).
- [ ] Done-when: `timeout 60 bun test harness/observe/report/cost-repeat.test.mjs harness/observe/report/run.test.mjs` -> 0 fail.
- [ ] Commit.

### Task 5: ROI tri thức `knowledge-roi.mjs` + section

**Files:**
- Create: `harness/observe/report/knowledge-roi.mjs`, `harness/observe/report/defaults/knowledge-roi.json` (table), `harness/observe/report/defaults/kpi-knowledge.json`
- Test: `harness/observe/report/knowledge-roi.test.mjs`

- [ ] Per id: gets, sessions, served_tokens (`out_len/4` -> `--budget N` -> null), saving (median eff cùng family không/có id, >= `minSide` mỗi bên, else null), cờ `fetched_no_saving`, `never_fetched`.
- [ ] Danh sách id: `harness knowledge graph --json --limit 2000` qua `proc.mjs` timeout 10s, tiêm được trong test (`listIds` param); lỗi -> bỏ `never_fetched`, ghi `ids: unavailable`.
- [ ] KPI: `fetches`, `served_tokens_measured_share`, `retire_candidates`.
- [ ] Test: parse `harness knowledge get 2026-11-07-agent-allocation --budget 800` -> id + 800; target bị cắt 160 ký tự vẫn không crash; mẫu nhỏ -> saving null.
- [ ] Done-when: `timeout 30 bun test harness/observe/report/knowledge-roi.test.mjs` -> 0 fail.
- [ ] Commit.

### Task 6: Thuế context `context-tax.mjs` + section

**Files:**
- Create: `harness/observe/report/context-tax.mjs`, `harness/observe/report/defaults/kpi-context-tax.json`, `harness/observe/report/defaults/context-dupes.json` (list)
- Test: `harness/observe/report/context-tax.test.mjs`

- [ ] Tĩnh (theo quy ước, không config): CLAUDE.md + `@import` một cấp; `.claude/memory/MEMORY.md` 200 dòng đầu (thiếu -> `memory: not_found`); mô tả skill qua `inventorySkills` (evolve/loop/prune.mjs:101); role mỗi agent qua `harness knowledge role <agent>` (proc.mjs, timeout, cắt 3072 byte, fail-open) x số SubagentStart cửa sổ.
- [ ] Đo thực: median `data.usage.first_ctx` Stop đầu mỗi sid main; `calibration = first_ctx/static`.
- [ ] Trùng dòng: băm `foldText` dòng >= 30 ký tự qua CLAUDE.md, AGENTS.md, MEMORY.md, `.claude/memory/*.md`, `.claude/agents/*.md`, `.agents/agents/*.md`; xuất `file:dòng` (không nội dung).
- [ ] KPI khoá: `static_tokens`, `rules_tokens`, `memory_index_tokens`, `skills_desc_tokens`, `role_tokens_per_subagent`, `first_ctx_tokens`, `dup_lines`.
- [ ] Test trên thư mục tạm: 2 file chung 1 dòng dài -> dup_lines 1, output không chứa nội dung dòng; tiếng Việt có/không dấu cùng nhóm.
- [ ] Done-when: `timeout 30 bun test harness/observe/report/context-tax.test.mjs` -> 0 fail.
- [ ] Commit.

### Task 7: Trùng gần đúng nội dung `content-dupes.mjs`

**Files:**
- Create: `harness/evolve/usage/content-dupes.mjs`
- Test: `harness/evolve/usage/content-dupes.test.mjs`

- [x] Chia khối theo heading/bullet; `foldText`; 5-shingle từ; chỉ mục ngược -> cặp ứng viên -> Jaccard; ngưỡng 0.6; trần `maxBlocks`, `maxDupPairs`, `timeoutMs` -> `truncated`.
- [x] Nguồn file như Task 6 + knowledge qua `harness knowledge export --json` (proc.mjs, timeout; lệnh chưa có/lỗi -> `knowledge: no_export`).
- [x] Thứ tự cặp tất định (như dupes.mjs:20-24). Output `{a:{file,line}, b:{file,line}, score}`.
- [x] Test: 2 đoạn gần giống (đổi 1 từ) -> score >= 0.6; khác dấu thanh cùng chữ (ma/mà) đoạn ngắn < 5 từ -> không thành shingle; truncated khi vượt.
- [x] Done-when: `timeout 30 bun test harness/evolve/usage/content-dupes.test.mjs` -> 0 fail.
- [x] Commit.

### Task 8: Lệnh `harness evolve dupes-content` + `proposeMetricFix`

**Files:**
- Modify: `harness/evolve/loop/cli.mjs` (:11 danh sách lệnh), `harness/evolve/loop/loop.mjs` (cạnh `proposeFix` :178-197)
- Modify: `harness/evolve/manifest.json` (commands/files nếu liệt kê)
- Test: `harness/evolve/loop/loop.test.mjs` (hoặc test cli hiện có)

- [ ] `dupes-content [--project P] [--threshold 0.6] [--limit 20] [--propose] [--json] [--timeout-s 20]`.
- [ ] `proposeMetricFix({a,b,score})` -> proposal `kind:'fix'`, area `doc`, id `p_dup_<sha8(a|b)>_fix`, `target_metric:{kpi:'kpi-context-tax.static_tokens', better:'down'}`; trùng id -> bỏ qua; không ghi file đích, không xoá.
- [ ] Test: propose 2 lần cùng cặp -> 1 proposal; không có nội dung khối trong proposal JSON.
- [ ] Done-when: `timeout 60 bun test harness/evolve/loop/loop.test.mjs` -> 0 fail.
- [ ] Commit.

### Task 9: Retro, selfdev, hiệu quả theo metric

**Files:**
- Modify: `harness/evolve/loop/selfdev.mjs` (:17-51), `harness/evolve/loop/retro.mjs` (issues :151-180), `harness/evolve/loop/effect.mjs` (`measureDue` :169)
- Test: `harness/evolve/loop/selfdev.test.mjs`, `harness/evolve/loop/retro.test.mjs`, `harness/evolve/loop/effect.test.mjs`

- [ ] selfdev thêm `context_tax_tokens` và `repeat_vs_first_ratio` (better down) từ kpi; thiếu -> bỏ qua (không flat giả).
- [ ] Retro issue `context:growth` (static_tokens vs_prev > +5%), `knowledge:retire-candidates` (>= 1 id); dedupe qua map `best` sẵn có; apply vẫn cap 3 task + 1 P0.
- [ ] `metricVerdict(series, kpi, appliedWeek, better)`: <= 0.95x better, >= 1.05x worse, còn lại unchanged, thiếu điểm insufficient; `measureDue` rẽ nhánh khi `target_metric.kpi`.
- [ ] Cập nhật test số đếm retro (:25,53-57,117,121,228) - đếm lại sau khi thêm khoá.
- [ ] Done-when: `timeout 60 bun test harness/evolve/loop/selfdev.test.mjs harness/evolve/loop/retro.test.mjs harness/evolve/loop/effect.test.mjs` -> 0 fail.
- [ ] Commit.

### Task H1 (repo hub, `isolation: worktree`): `harness knowledge export --json`

**Files:**
- Create: `/media/networld/11. Agents/hub/knowledge/export-cmd.mjs`, `/media/networld/11. Agents/hub/knowledge/export-cmd.test.mjs`
- Modify: `/media/networld/11. Agents/hub/knowledge/knowledge.mjs` (dispatch), `/media/networld/11. Agents/hub/knowledge/manifest.json` (cmds, commands mode read, files - danh sách lệnh nằm trên MỘT dòng)

- [ ] `export --json [--limit 500] [--max-bytes 4194304] [--timeout-s 10]` -> `[{id, title, tags, body}]`, dừng êm `truncated: max_bytes|limit|timeout`.
- [ ] Test: limit và max-bytes cắt đúng; mode read.
- [ ] Done-when: `timeout 30 bun test hub/knowledge/export-cmd.test.mjs` -> 0 fail.
- [ ] Commit. Sau merge: NGƯỜI DÙNG chạy approve hash ext trong terminal riêng (TTY).

### Task 10: Kiểm trên dữ liệu thật hub (haiku, chỉ chạy, không sửa)

- [ ] `CLAUDE_PROJECT_DIR="/media/networld/11. Agents" timeout 120 harness observe report --days 7 --dry-run --out - > /tmp/kc-report.md 2>&1`; có các mục cost-repeat, knowledge-roi, context-tax; không mục nào `derive_failed`.
- [ ] `CLAUDE_PROJECT_DIR="/media/networld/11. Agents" timeout 120 harness evolve retro --json > /tmp/kc-retro.json` (dry-run); có khoá `kpi-cost-repeat.repeat_vs_first_ratio`, `kpi-context-tax.static_tokens`; không có `problems-index.json` mới (dry-run).
- [ ] `timeout 60 harness evolve dupes-content --project "/media/networld/11. Agents" --json --limit 10` -> có `pairs`, `truncated` rõ.
- [ ] Báo: key_coverage, số problems, ratio, static vs first_ctx (calibration), top 5 cặp trùng (`file:dòng`).
- [ ] Done-when: 3 lệnh exit 0, output trích trong báo cáo.

### Task 11: Full suite một lần (cuối đợt, chạy nền)

- [ ] `cd "/media/networld/06. Projects/harness-kit" && timeout 900 bun test > /tmp/kc-full.log 2>&1`; trích dòng tổng pass/fail.
- [ ] Done-when: 0 fail; fail -> scout đọc log, trả về Task gây lỗi.
