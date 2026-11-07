# Audit agy ngang Claude (token, thoi gian, loi, ly do dung) - Implementation Plan

> SDD: moi Task mot `builder` (Sonnet, worktree rieng, maxTurns 40), tru Task 0/6 (general-purpose, khong code) va Task 7. Buoc dung `- [ ]`. Test: `bun:test`, file `.test.mjs` canh nguon; lenh hep `timeout 120 bun test <file>`. Comment trong repo: tieng Viet khong dau.

**Muc tieu:** audit harness-kit thu cua agy cung bo do nhu Claude (token in/out/cache, thoi gian tool, loi + exit code, ly do dung) ngay trong plugin, qua lop adapter co san (`harness/observe/audit/adapters/agy.mjs`). Khong ext/wrapper ngoai. Core chi them diem mo "parser usage theo dinh dang transcript"; tool moi = them adapter + parser.

**Code that (da doc, main @ c8dcda3):**
- `harness/observe/audit/audit.mjs`: `readUsage/readUsageEx/parseUsage` 42-80 (chi hieu dong `type:"assistant"` + `message.usage`); Stop/SubagentStop 284-304 (cumulative qua `readUsageEx`, delta qua `readUsageDelta`); `model = inp.model` 274; `dur_ms: num(inp.duration_ms)` 320.
- `harness/observe/audit/usage-tail.mjs`: `sumUsage` 30-47 (parser Claude), `readUsageDelta` 50-76 (offset byte theo transcript, tran 512KB/200ms, fail-open) - goi `sumUsage` cung.
- `harness/observe/audit/adapters/agy.mjs`: marker Pre 24-44; `detectError` 46-104; normalize sid/cli 125-128; usage tu payload 232-243 (agy khong co -> luon null); `audit.buildEnvelope(inp, cfg)` 253 KHONG truyen `opts` (mat `root` -> offset delta khong luu); `takePre` 267-270; session events 280-289. Khong map `transcriptPath`, khong map `modelName`.
- `harness/hooks/dispatch/agy.mjs` 19-25: goi adapter voi `{ root: auditDir() }`, timeoutMs 2500; `agy-native.mjs` spawn 3500ms < 5s hooks.json.
- `hooks.json` (goc repo, ban agy): PreToolUse matcher dong 8 chi `run_command|write_file|edit_file`.
- `harness/observe/report/defaults/cost-session.json`: bang token theo `sid`; chua co tong hop theo `cli`. Engine khai bao (`auditField` default `rec[field] ?? data[field]` -> `cli` dung duoc, khong can sua engine).
- `harness/observe/README.md` 41-44: ket luan agy 1.4.3 cu ("Post KHONG co toolResult/exit code / error rong").

**Tai lieu agy 1.5 (hooks.md, may hien agy 1.5.2):** moi payload co `conversationId, workspacePaths, transcriptPath, artifactDirectoryPath, modelName, lastUserInput`. PostToolUse co `stepIdx`, `error` ("exit status 1") khi tool loi. Stop: `executionNum, terminationReason (NO_TOOL_CALL|MAX_INVOCATIONS|MAX_FORCED_INVOCATIONS|MAX_TOKEN_BUDGET_EXCEEDED|ERROR|USER_CANCELED|TERMINAL_STEP_TYPE|TERMINAL_CUSTOM_HOOK|INJECTED_RESPONSE), error (""), fullyIdle`.

**Transcript agy that** (`~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`, them `transcript_full.jsonl`): moi dong `{step_index, source, type, status, created_at, ...}`. Buoc `type:"PLANNER_RESPONSE"` (source MODEL) co `input_tokens, cache_read_tokens, output_tokens, tool_calls`; `input_tokens` KHONG gom cache_read (vd 2381 + 9553). Buoc ket qua tool `type:"GENERIC"` co `content` bat dau `Created At: <ISO+07:00>\nCompleted At: <ISO>\n` va voi lenh `Command exited with code N.` Ca 2 file cung 35 dong token. Khong co truong model trong dong.

**Dieu chinh so voi thiet ke goc (ly do):**
1. Thoi gian tool agy lay tu `Created At/Completed At` cua buoc GENERIC trong transcript (chinh xac theo tool, giay), khong tu `created_at` chenh lech giua buoc; marker Pre giu lam du phong. Khong mo rong matcher PreToolUse.
2. Parser agy dat o file thuan moi `adapters/agy-usage.mjs` (khong fs) de Task 1 va Task 2 song song va test khong can file.
3. Ly do dung ghi o truong chung `data.stop_reason`/`data.exec_num`/`data.fully_idle` (khong ten agy_*) de tool khac dien cung truong; `status` Stop giu `stopped` nhu Claude (consumer khac loc theo no). `USER_CANCELED` -> `data.signal='interrupt'` (KPI can thiep da dem signal nay).
4. Them Task 6 (chay agy that sau merge, workspace tam) vi cac tuyen bo "ngang Claude" phai co ban ghi that.

---

### Task 0: Xac minh payload + transcript agy that (KHONG code; general-purpose, lam truoc)
Workspace tam trong scratchpad (nam duoi `C:\Users\huynh` = trustedWorkspaces, khong dung du lieu audit hub).
- [x] Chuan bi (bash, duong dan tuyet doi, `S` = scratchpad cua agent):
  ```
  W="$S/agy-ws"; mkdir -p "$W/.agents/plugins"
  git clone -q "E:/06. Projects/harness-kit" "$W/.agents/plugins/harness-kit"
  printf '# test\nDong 2\n' > "$W/README.md"
  printf '{"permissions":{"allow":["read_file(%s)"]}}' "$(cygpath -w "$W" | sed 's/\\/\\\\/g')" > "$S/agy-settings.json"
  ```
  Neu agy khong nap plugin (khong co dong capture nao), doi chieu bo cuc `E:/11. Agents/.agents/` (chi `ls`, khong doc data/) va `agy plugin list --json`.
- [x] Chay mot lan (nen, timeout cung):
  ```
  cd "$W" && HUB_AGY_CAPTURE="$S/agy-capture.jsonl" timeout 300 agy -p "Dung view_file doc README.md roi doc khong-ton-tai.md, tra loi dong 2 cua README. Khong goi subagent, khong run_command." --mode plan --settings "$S/agy-settings.json" --output-format json > "$S/agy-out.json" 2> "$S/agy-err.log"
  ```
  Khong dung `--dangerously-skip-permissions`. File khong ton tai de co mot Post loi.
- [x] Ghi nhan (chi doc file trong `$S`, transcript doc bang `head`/`grep` co gioi han):
  (a) `transcriptPath` trong payload: gia tri, file co ton tai, la `transcript.jsonl` hay `transcript_full.jsonl` hay duong khac; tong `input/cache_read/output_tokens` cac buoc MODEL so voi `usage` trong `agy-out.json` (lech %; co `thinking` tach rieng khong).
  (b) Hook co ban khi `agy -p` khong: danh sach su kien trong capture (SessionStart, PostToolUse, PostInvocation, Stop) va so lan.
  (c) Payload Post that (co `stepIdx`, `error` khi view_file loi, gia tri) va Stop that (`terminationReason, executionNum, error, fullyIdle`); `stepIdx` cua Post khop `step_index` cua buoc GENERIC nao; transcript co tang dan theo step_index (append-only) khong; `agy --help` co co tiep tuc hoi thoai (resume) khong.
  (d) Audit workspace tam: lenh `harness observe query` (hoac `node "$W/.agents/plugins/harness-kit/harness/cli/harness.mjs" observe query --raw`) - ban ghi hien tai co `tokens_in` null, `data.usage:"unavailable"`.
- [x] Ket qua: capture/out/log o lai `$S` (khong dua vao repo). Agent bao <= 30 dong; main chep tom tat vao muc "Ket qua Task 0" cuoi plan nay (commit local truoc khi dispatch Task 1-4).
- Re nhanh theo ket qua:
  - (a) sai/thieu (khong co `transcriptPath`, hoac tro file khong ton tai): Task 2 them `agyTranscriptPath(inp, home)` = `<home>/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl` neu ton tai; Task 3 dung no khi payload thieu. Tro `transcript_full.jsonl`: parser van dung (dedupe step_index). Token lech > 5% hoac co thinking rieng: Task 2 them truong `thinking` vao ket qua va ghi chu nguon dung.
  - (b) hook KHONG ban khi `-p`: Task 1-5 giu nguyen (hook ban o phien tuong tac); Task 6 doi thanh huong dan nguoi dung chay mot phien tuong tac; ghi cau hoi mo cho nguoi dung ve cach do phien `-p` (khong lam trong plan nay).
  - (c) Post khong co `error`/Stop khong co `terminationReason`: giu `detectError` hien tai; test Task 3 danh dau "theo tai lieu, chua thay that". Transcript khong append-only: Task 2 ghi watermark `step_index` (xem rui ro), bao main truoc khi code.

### Task 1: Core - diem mo parser usage theo tool (RED/GREEN) [song song Task 2, 4]
Files: `harness/observe/audit/usage-tail.mjs`, `harness/observe/audit/audit.mjs`, `harness/observe/audit/usage-tail.test.mjs`.
- [x] Test do truoc (trong `usage-tail.test.mjs`): (a) `readUsageDelta(file, {root, sum})` dung `sum` duoc truyen (parser gia tra so co dinh) va van tien offset/tran byte/timeout nhu cu; (b) `sum` nem hoac tra null -> `readUsageDelta` tra null, khong tien offset; (c) `buildEnvelope(inp, cfg, now, {root, usage:{sum}})` Stop: `data.usage`, `tokens_in/out`, `turns`, `data.tokens_cache` lay tu parser rieng ca nhanh cumulative va delta; (d) KHONG truyen `usage` -> hanh vi Claude y nguyen (cac test cu cua `usage-tail.test.mjs`, `audit.test.mjs`, `v2.test.mjs`, `standard.test.mjs` xanh khong sua); (e) parser rieng tra `msgs:0` tren ca file -> khong ghi token 0 gia (`data.usage_reason:'no_usage'`), tranh loi hien tai `parseUsage` tra 0 cho file la.
- [x] Code: `readUsageDelta` nhan `sum = sumUsage`. `readUsageEx(file, maxBytes, sum)`: co `sum` -> doc file, `sum(text)` -> map `{turns: msgs, tokens_in: input+cache_creation, tokens_out: output, tokens_cache: cache_read, model}`; khong co -> `parseUsage` cu. `buildEnvelope` doc `opts.usage?.sum` va truyen xuong ca 2 nhanh; `opts.usage.model` (tuy chon) lam model mac dinh. Loi parser -> fail-open (khong mat su kien).
- [x] Chay: `timeout 120 bun test harness/observe/audit/usage-tail.test.mjs harness/observe/audit/audit.test.mjs harness/observe/audit/v2.test.mjs`.
- Done: test moi do roi xanh; test cu xanh khong sua; diff core khong nhac ten agy.

### Task 2: Parser transcript agy, thuan (RED/GREEN) [song song Task 1, 4]
Files: tao `harness/observe/audit/adapters/agy-usage.mjs`, `agy-usage.test.mjs`. Fixture: chuoi jsonl nho tu tao trong test (khong chep file that, khong noi dung that).
- [x] Test do truoc: (a) `sumAgyUsage(text, deadline)` cong `input_tokens/output_tokens/cache_read_tokens` cua dong co so token (source MODEL), tra cung shape `sumUsage`: `{input, output, cache_read, cache_creation:0, total_tokens, msgs, model:null}`; (b) dedupe theo `step_index` (lap -> lay output lon nhat; ca transcript va transcript_full); (c) dong SYSTEM/GENERIC/JSON hong bi bo; (d) het `deadline` -> null; (e) `stepDurations(text)` -> Map `step_index -> ms` tu `Created At/Completed At` (ISO co mui gio +07:00; thieu Completed -> khong co); (f) `exitCodeOf(content)` tu `Command exited with code N.` va `exitStatusOf(err)` tu `exit status N` (khong khop -> null).
- [x] Code: chi ham thuan, prefilter chuoi (`"input_tokens"`, `Created At:`) truoc `JSON.parse`. Them `agyTranscriptPath` neu Task 0 (a) yeu cau.
- [x] Chay: `timeout 120 bun test harness/observe/audit/adapters/agy-usage.test.mjs`.
- Done: test xanh; file khong import fs/audit.

### Task 3: Noi adapter agy (RED/GREEN) [phu thuoc Task 0, 1, 2]
Files: `harness/observe/audit/adapters/agy.mjs`, `harness/observe/audit/adapters/agy.test.mjs`.
- [x] Test do truoc (tmp dir: audit root + transcript fixture tu tao): (a) Stop co `transcriptPath` -> `data.usage.input/output/cache_read` dung tong buoc MODEL; Stop thu hai chi cong buoc moi (offset luu duoi `root`); `tokens_in/out` co gia tri; (b) `modelName` -> `env.model`; (c) Stop `terminationReason:"ERROR"` hoac `error` khac rong -> `ok:false`, `data.stop_reason`, `data.exec_num`, `data.fully_idle`; `NO_TOOL_CALL` -> `ok` khong false; `USER_CANCELED` -> `data.signal:'interrupt'`; `MAX_*` -> `ok:false`; (d) Post `error:"exit status 1"` -> `ok:false`, `status:'error'`, `data.exit_code:1`, `data.error`; (e) Post khong marker nhung transcript co buoc GENERIC `step_index == stepIdx` -> `dur_ms` tu Created/Completed, `data.dur_src:'transcript'`; co marker -> `data.dur_src:'marker'`; (f) transcript thieu/hong/qua tran -> van ghi ban ghi (fail-open), `data.usage_reason` co ly do; (g) 10 test cu cua `agy.test.mjs` xanh.
- [x] Code: map `transcriptPath -> transcript_path` (chi chuoi `.jsonl`; fallback `agyTranscriptPath` neu Task 0 yeu cau), `modelName -> model`; goi `audit.buildEnvelope(inp, cfg, new Date(), { root, usage: { sum: sumAgyUsage } })` (root = `ctx.root || auditRoot()`); Stop: ghi `data.stop_reason/exec_num/fully_idle`, ok/signal theo (c); `detectError` doc `exit status N`; Post: neu chua co `dur_ms` -> marker (nhu cu) roi doc duoi transcript co tran (64KB, 100ms) tim buoc GENERIC. Xoa doan doc `inp.usage|tokens` 234-240 neu Task 0 xac nhan payload khong co (giu neu khong chac, ghi `shortcut:`).
- [x] Chay: `timeout 120 bun test harness/observe/audit/adapters/agy.test.mjs harness/observe/audit/adapters/agy-usage.test.mjs harness/observe/audit/usage-tail.test.mjs`.
- Done: test xanh; tong thoi gian hook Stop voi transcript 2MB fixture < 1500ms (test do bang `Date.now`, duoi tran 2500ms dispatcher).

### Task 4: Report tong hop theo cli (RED/GREEN) [song song Task 1, 2]
Files: tao `harness/observe/report/defaults/cost-cli.json`, `harness/observe/report/cost-cli.test.mjs`. Neu test cu dem so muc mac dinh (`grep -n "length\|sections" harness/observe/report/*.test.mjs`) thi sua dung cho do, ghi trong commit.
- [x] Test do truoc: su kien gia (claude + agy: Post ok/loi co `dur_ms`, Stop co `data.usage`, `data.stop_reason`) qua `loadSections` + engine -> hang `claude`/`agy` voi dung: phien, su kien, token vao (`sum:data.usage.input`), token ra, cache doc (`sum:data.usage.cache_read`), loi (`count` loc `ok:false`), ms (`sum:dur_ms`), dung bat thuong (`count` loc `data.stop_reason` thuoc ERROR|MAX_INVOCATIONS|MAX_FORCED_INVOCATIONS|MAX_TOKEN_BUDGET_EXCEEDED).
- [x] Muc JSON: `group_by:["cli"]`, `window_days:7`, `compare:"prev_window"`, `format:"table"`, `order` sau `cost-session` (12). Khong loc `usage_mode` (`data.usage` luon la delta). Khong sua `engine.mjs`.
- [x] Chay: `timeout 120 bun test harness/observe/report/cost-cli.test.mjs harness/observe/report/run.test.mjs harness/observe/report/engine.test.mjs`.
- Done: test xanh; `harness observe report --dry-run` in muc moi (builder trich 5 dong).

### Task 5: README observe [phu thuoc Task 0, 3]
Files: `harness/observe/README.md`.
- [ ] Thay doan agy 41-44 bang ket qua Task 0 (agy 1.5.x): payload chung, Post `error` "exit status N" -> `data.exit_code`, Stop `stop_reason/exec_num/fully_idle`, token tu transcript (`agy-usage.mjs`, delta theo offset), `dur_ms` tu transcript (`data.dur_src`). Them 3 dong "them tool moi = adapter + parser `usage.sum`" (diem mo core Task 1). Giu `HUB_AGY_CAPTURE`.
- Done: khong con cau "KHONG co toolResult/exit code / error rong"; khong doi muc Claude.

### Task 6: Xac minh that sau merge (KHONG code; general-purpose) [phu thuoc Task 1-5 da merge vao main]
- [ ] Lap lai Task 0 voi workspace tam moi (clone main sau merge), cung lenh/settings, them mot buoc doc file thanh cong.
- [ ] Kiem (qua `harness observe query`/`report --dry-run` cua plugin trong workspace tam): Stop co `data.usage.input/output` > 0 va lech <= 5% so `agy-out.json`; Post loi co `ok:false` + `data.exit_code` (neu agy cho ma); Post co `dur_ms` va `data.dur_src`; Stop co `data.stop_reason`; muc report `cost-cli` co hang `agy`.
- [ ] Sai lech: bao main (khong tu sua); main mo builder sua theo quy trinh debug (toi da 2 vong).

### Task 7: Full suite mot lan
- [ ] Trong worktree main sau merge, nen, co timeout, log ra file: `timeout 900 bun test harness dev > "<scratch>/full.log" 2>&1`; bao duoi log (pass/fail, ten test do). Khong chay lai; fail co tu truoc (vd `dev/checks/proc-check.test.mjs`) ghi ro khong thuoc plan.

## Phu thuoc / song song
Task 0 -> {1, 2, 4 song song} -> 3 (can 1+2) -> 5 -> merge -> 6 -> 7. Tap file khong chong: T1 core audit + usage-tail(+test); T2 agy-usage(+test) moi; T3 agy.mjs + agy.test.mjs; T4 report defaults + test moi; T5 README.

## Dieu cam (moi builder)
Khong push, khong sua `.gitignore`, khong install, khong co-author Claude trong commit (chi tac gia nguoi dung), khong doc `data/` cua hub, khong dung file transcript that trong test, khong mo rong matcher PreToolUse, khong chay agy (tru Task 0/6), khong `--dangerously-skip-permissions`. Bao cao <= 40 dong, kem lenh test + trich output tren HEAD worktree.

## Rui ro / shortcut
- Delta theo offset byte gia dinh transcript append-only; neu agy viet lai file (size nho lai) core reset offset 0 -> dem lai. Task 0 (c) kiem; neu khong append-only, doi sang watermark `step_index` trong state (bao main truoc).
- Thoi gian tool tu `Created At/Completed At` do giay (khong ms); agy co the doi dinh dang `content` -> parser tra null, fallback marker.
- Claude khong co ly do dung trong payload: `data.stop_reason` chi agy dien; report hien `-` cho claude.

## Ngoai pham vi
- Cham diem dung/sai cau tra loi (tinh nang chung moi tool, plan rieng).
- Loi ext-guard timeout (task rieng, xem hub-0041).
- Do token cho phien `agy -p` neu hook khong ban o che do nay (chi ghi cau hoi mo).

## Ket qua Task 0
Chay that 2026-11-07, agy 1.5.x, model gemini-4-argon-medium, `agy -p --mode plan --settings <file> --output-format json` trong workspace tam co plugin; rc=0, 72s. Bang chung o scratchpad cua phien (agy-t0/: agy-capture.jsonl, agy-out.json, audit tam).
- (a) `transcriptPath` co trong SessionStart/PostInvocation/Stop (KHONG co trong Post tool): `C:/Users/<u>/.gemini/antigravity-cli/brain/<convId>/.system_generated/logs/transcript_full.jsonl` (dau `/`), file ton tai. Tong token cac buoc PLANNER_RESPONSE = usage cua `--output-format json`: input 15143, cache_read 17707, output 1260, lech 0%. `thinking_tokens` (254) da nam trong output, khong tach dong. Transcript append-only, moi step_index mot dong, tang dan. Dong khong co model; `modelName` co o moi payload. -> Khong can `agyTranscriptPath` lam duong chinh (giu du phong neu re). Post khong co transcriptPath -> dur_ms cua Post phai lay transcript qua duong dan da biet cua phien (vd luu tu SessionStart/Stop truoc theo sid) hoac suy tu `brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`.
- (b) Hook BAN khi `agy -p`: SessionStart 1, Post 3, PostInvocation 3 (audit ghi UserPromptSubmit event_inferred), Stop 1, PreToolUse co ban cho Write. Nhanh "khong ban" khong ap dung.
- (c) Post that: `{stepIdx:2, error:"", toolCall:{name:"read_file",args:{Path}}}`; Post loi: `error:"file does not exist"` (khong co "exit status", khong exit code cho tool doc). Stop that: `{terminationReason:"NO_TOOL_CALL", executionNum:0, error:"", fullyIdle:true}`. stepIdx = step_index cua buoc GENERIC; content bat dau "Created At: ...+07:00\nCompleted At: ...". `exit status N` chi theo tai lieu (chua thay that) -> exit_code lay tu "Command exited with code N." trong transcript hoac regex `exit status N`, danh dau chua kiem.
- (d) Audit hien tai: Stop status stopped, tokens null, `data.usage_reason:'no_path'`, model null, khong stop_reason. Post loi da ok:false + data.error. dur_ms null cho Read (Pre matcher hep), Write co dur tu marker. Ban ghi hook-run gan cli:"claude" sid:"claude-nosession" (loi nhan, ngoai pham vi).
