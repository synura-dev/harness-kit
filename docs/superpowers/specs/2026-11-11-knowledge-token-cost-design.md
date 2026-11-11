# Đo và giảm hao token tri thức/context (knowledge-token-cost) - design

Ngày: 2026-11-11. Repo: harness-kit (main 481294a, plugin 0.4.7). Một Task phụ ở hub (`hub/knowledge`).

## Câu hỏi người dùng
"harness có tối ưu tri thức không (trùng lặp nội dung, hao token)? có đo được hao token lần đầu dùng và lần sau dùng trong 1 vấn đề hay nhiều vấn đề không?"

Trả lời ngắn hiện trạng: CHƯA. `knowledge check` chỉ bắt trùng id knowledge<->memory và link hỏng; `evolve/usage/dupes.mjs` chỉ so mô tả skill (Jaccard token); không có đo chi phí theo vấn đề, không đo context nạp sẵn, không phát hiện trùng nội dung.

## Mục tiêu
1. Khoá vấn đề (problem key) tất định cho từng đoạn phiên, không cần người dùng gắn task.
2. Chi phí lần đầu vs lần lặp theo từng vấn đề và gộp nhiều vấn đề; theo "họ" vấn đề (ledger fp).
3. ROI tri thức theo doc id (lần lấy, token phục vụ, tiết kiệm ước tính); danh sách ứng viên retire (người duyệt qua TTY).
4. Thuế context (token nạp sẵn mỗi phiên/subagent), theo tuần, cảnh báo tăng; liệt kê đoạn trùng giữa CLAUDE.md/AGENTS.md/MEMORY.md/memory/agent .md.
5. Phát hiện trùng gần đúng nội dung (tất định, biết dấu tiếng Việt) -> đề xuất gộp dạng evolve `kind fix`, đo hiệu quả bằng chuỗi KPI; không bao giờ tự xoá.
6. Nối vào retro tuần: khoá series ổn định, selfdev, F3 tính cả tăng thuế context.

Không làm: gọi model; sửa/xoá nội dung tri thức tự động; đọc file knowledge thô (chỉ qua `harness knowledge ...`).

## Dữ kiện đã xác minh (file:dòng)
- Stop/SubagentStop: `tokens_in = input + cache_creation`, `data.tokens_cache = cache_read`, `tokens_out`, `turns` là LŨY KẾ (harness/observe/audit/audit.mjs:302, README observe:21). `data.usage` = delta kể từ Stop trước `{input, output, cache_read, cache_creation, msgs}` (audit.mjs:304-311, usage-tail.mjs:29-40). => có tách cache theo lượt.
- README observe:77 (mục cost) nói "cache-creation không được audit ghi" - MÂU THUẪN với code audit.mjs:82 (cộng vào tokens_in). Sửa doc ở Task 0.
- KHÔNG ghi kích thước output tool (README observe:33: không ghi `tool_response`). Bash: `target` = lệnh đã redact cắt 160 ký tự, `data.cmd_line` 100 ký tự, `data.cmd_head` (audit.mjs:231-250). => doc id của `harness knowledge get <id>` đọc được từ target; token phục vụ thì KHÔNG.
- `data.task_id` = env `HUB_TASK_ID` hoặc payload (audit.mjs:161-162); thực tế gần như rỗng (brief).
- `data.error_fp` trên lỗi tool (audit.mjs:165-173); `data.files_touched` cho Edit/Write (175-178).
- UserPromptSubmit (type `prompt`, audit-config.mjs:33): `data.prompt_hash`, `data.prompt_kw` (<= 8 từ chuẩn hoá, không nguyên văn; core/audit/signals.mjs:13-22).
- `cwd` (240 ký tự) có trong mọi envelope -> nhận worktree `.worktrees/<x>` hoặc `.claude/worktrees/<x>`.
- ~81% SubagentStop là phantom, không token (README observe:25) => chi phí subagent bị thiếu, phải ghi rõ.
- Report engine: SOURCES cố định `audit|candidates|ledger|inventory|process` (report/engine.mjs:12); `windowInputs` lọc events theo cửa sổ (engine.mjs:142-151); `kpiSnapshot` chỉ lấy CỘT ĐẦU mỗi hàng, khoá = `row.key` (engine.mjs:192). Retro `pickKpi` chỉ lấy section `kpi-*`, bỏ khoá có tuần/đường dẫn/đuôi file (retro.mjs:50-56).
- Retro đọc audit 7 ngày một lần (retro.mjs:40); selfdev là hàm thuần (selfdev.mjs:17-51); F3 = có >= 1 chỉ số xấu -> worse (selfdev.mjs:58-64).
- evolve `kind fix` cần candidate từ audit lỗi (`findCandidates`, loop.mjs:155-197); đo hiệu quả theo fp (effect.mjs:169-200, `measureDue` đã nhận `p.target_metric`).
- Hub knowledge ext: lệnh `check,index,fact,search,get,eval,guard,add,import,review,tags,tidy,retire,graph,role,links`; `graph --json` trả id/title/tags; `get <id> --json`; KHÔNG có lệnh xuất hàng loạt nội dung; inject role SubagentStart trần `maxBytes 3072` (hub/knowledge/manifest.json:1).

## Audit đo được / không đo được
| Đại lượng | Đo được? | Ghi chú |
|---|---|---|
| Token theo lượt main (input/output/cache_read/cache_creation) | Có | `data.usage` delta ở Stop |
| Token subagent | Một phần | SubagentStop không phantom; phantom ~81% = thiếu |
| Số lượt, số tool call, thời gian tường (prompt -> Stop) | Có | |
| Lần lấy tri thức + doc id | Có | Bash target `harness knowledge get|search` (cắt 160 ký tự) |
| Token tri thức đã phục vụ | KHÔNG (đến khi Task 0 thêm `data.out_len`) | trước đó: ước từ `--budget N` nếu có, còn lại null |
| Context nạp sẵn đầu phiên | KHÔNG (đến khi Task 0 thêm `data.usage.first_ctx`) | tĩnh: ước bytes/4 từ file |
| Nội dung prompt/vấn đề | KHÔNG | chỉ `prompt_kw` 8 từ + hash |

## Thiết kế

### A. Khoá vấn đề (`harness/observe/report/problems.mjs`)
Đoạn (segment) = từ một UserPromptSubmit đến UserPromptSubmit kế tiếp cùng `sid` (sự kiện trước prompt đầu = đoạn 0). Khoá theo thứ tự ưu tiên, lấy cái đầu tiên tìm thấy trong đoạn:
1. `task:<id>` - `data.task_id` hoặc Bash target khớp `harness projects (set-task|add-task|task|get-task)\b.*--(id|task) <id>`; precision cao.
2. `plan:<slug>` - Read/Edit/Write target hoặc `files_touched` khớp `docs/superpowers/(plans|specs)/YYYY-MM-DD-<slug>(-design)?.md`; slug bỏ ngày và `-design` để spec+plan cùng khoá; cao.
3. `branch:<x>` - cwd chứa `/.worktrees/<x>` hoặc `/.claude/worktrees/<x>`, BỎ `agent-[0-9a-f]{6,}` (tên ngẫu nhiên của Agent tool); trung bình.
4. `err:<fp>` - `data.error_fp` đầu tiên của đoạn; trung bình.
5. `kw:<3 từ prompt_kw đầu, sắp xếp>`; thấp (va chạm/ lệch).
Đoạn không có khoá nào thừa khoá đoạn trước cùng sid (câu hỏi nối tiếp). Họ (family): `err` -> id entry ledger chứa fp (readLedger), còn lại = loại khoá + slug (vd `plan:knowledge-token-cost`). Kèm `precision: high|mid|low` và tỉ lệ phủ `key_coverage` = đoạn có khoá high|mid / tổng đoạn.
Giới hạn nêu trong báo cáo: một đoạn nhiều vấn đề -> lấy khoá đầu; câu hỏi lặp trong CÙNG phiên không được tính là lần lặp; subagent phantom không có token.

### B. Lần đầu vs lần lặp (`harness/observe/report/cost-repeat.mjs`)
Lần xuất hiện (occurrence) = (khoá, sid): phiên đầu tiên chạm khoá = lần đầu, phiên sau = lặp. Chi phí lần xuất hiện = tổng các đoạn của khoá trong phiên đó: `tokens = input + cache_creation + output`, `cache_read` riêng, `eff_tokens = tokens + 0.1 * cache_read` (trọng số giá cache đọc, hằng số trong LIMITS), lượt (msgs), tool call (PostToolUse/Failure), info-fetch (tiền tố của `kpi-info-fetch.json` + `harness knowledge`), wall_ms (prompt đầu -> Stop cuối). Subagent: SubagentStop cùng sid có SubagentStart trong đoạn, lấy MAX lũy kế theo `agent_id` (không cộng).
Lần đầu nằm ngoài cửa sổ: chỉ mục bền `<report data>/problems-index.json` `{key: {first_ts, first_sid, first_eff_tokens, family}}`, trần 2000 khoá, xoá > 90 ngày, ghi atomic, CHỈ ghi khi `persistIndex` (report `--weekly`, retro `--apply` không `--current`); dry-run không ghi. Lần đầu chạy: `--bootstrap-days 28` (trần = retention audit 30).
Gộp: `ratio(khoá) = median(eff lặp) / eff lần đầu`; KPI: `repeat_vs_first_ratio` (median các ratio, chỉ khoá có lặp, high|mid), `tokens_per_problem` (median eff/lần), `problems`, `repeat_share`, `key_coverage`, `cache_read_share`. Theo họ: cùng bảng nhóm theo family.

### C. ROI tri thức (`harness/observe/report/knowledge-roi.mjs`)
Theo doc id: số lần get, số phiên, token phục vụ (`data.out_len/4` từ Task 0; không có -> `--budget N`; không có -> null, ghi "chưa đo"). Tiết kiệm ước tính = median eff của lần xuất hiện CÙNG họ không lấy doc - median có lấy doc; cần >= 3 mỗi bên, thiếu -> null. Cờ: `fetched_no_saving` (>= 3 lần get, tiết kiệm <= 0), `never_fetched` (id từ `harness knowledge graph --json --limit 2000` qua proc.mjs, timeout 10s, fail-open; không có lần get trong 28 ngày). Retire vẫn là TTY của người: retro gom MỘT issue khoá ổn định `knowledge:retire-candidates` (tối đa 20 id trong summary).

### D. Thuế context (`harness/observe/report/context-tax.mjs`)
Tĩnh (từ file của dự án, theo quy ước, không config): `<p>/CLAUDE.md` + `@import` một cấp, `<p>/.claude/memory/MEMORY.md` (200 dòng đầu, như Claude nạp), mô tả skill (`inventorySkills` frontmatter description), role checklist mỗi agent (`harness knowledge role <agent>`, cắt 3072 byte = trần inject) nhân số SubagentStart trong tuần. Ước token = ceil(bytes UTF-8 / 4), ghi nhãn "ước". Đo thực: `data.usage.first_ctx` của Stop đầu mỗi phiên main (Task 0) -> median tuần; hệ số hiệu chỉnh = đo thực / ước tĩnh.
Trùng lặp: băm dòng chuẩn hoá (lowercase, gập dấu + `đ->d`, bỏ ký hiệu đầu dòng markdown, gộp khoảng trắng, dòng >= 30 ký tự) trên CLAUDE.md, AGENTS.md, MEMORY.md, `.claude/memory/*.md`, `.claude/agents/*.md`, `.agents/agents/*.md` -> danh sách nhóm `file:dòng`.
KPI: `static_tokens`, `rules_tokens`, `memory_index_tokens`, `skills_desc_tokens`, `role_tokens_per_subagent`, `first_ctx_tokens`, `dup_lines`.

### E. Trùng gần đúng nội dung (`harness/evolve/usage/content-dupes.mjs` + lệnh)
Chia khối theo heading/bullet; chuẩn hoá như D; 5-shingle từ; chỉ mục ngược shingle -> cặp ứng viên -> Jaccard chính xác; ngưỡng 0.6; trần 3000 khối, 50 cặp, timeout. Gập dấu làm va chạm thanh điệu (ma/mà/má) - 5-shingle giảm; ghi trong giới hạn. Nguồn: file như D + knowledge qua `harness knowledge export --json` (Task H1 ở hub; thiếu lệnh -> bỏ nguồn, ghi `knowledge: no_export`). Lệnh `harness evolve dupes [--project P] [--threshold 0.6] [--limit 20] [--propose] [--json] [--timeout-s 20]`. `--propose` tạo proposal `kind fix` area `doc` không cần candidate audit (`proposeMetricFix`), `target_metric {kpi: 'kpi-context-tax.static_tokens', better: 'down'}`, id ổn định `p_dup_<sha8(a|b)>_fix`; không ghi file đích.

### F. Retro
- Engine: thêm source `derived` (`def.derive` = `cost-repeat|knowledge-roi|context-tax`), hàm do run.mjs cấp `all.derived[name]({events: all.events, from, to, ctx})` -> hàng `{k, v, ...}`. Section `kpi-*` dùng `group_by ["k"]`, metric `sum:v` => khoá series `kpi-cost-repeat.repeat_vs_first_ratio`... (không tuần/đường dẫn: qua bộ lọc `pickKpi`).
- selfdev: thêm `context_tax_tokens` (better down) và `repeat_vs_first_ratio` (better down) đọc từ `kpi` truyền vào; F3: tăng thuế context = chỉ số xấu -> `worse`.
- Hiệu quả proposal theo metric: `metricVerdict(series, kpi, appliedWeek, better)` (tuần apply vs 2 tuần sau; better nếu <= 0.95x, worse >= 1.05x, còn lại unchanged; thiếu điểm -> insufficient).
- Issue mới (dedupe theo key qua map `best` sẵn có): `context:growth` khi `static_tokens` vs_prev > +5%; `knowledge:retire-candidates`.

### G. Đo mức dùng mode / tuân thủ định tuyến (Claude haiku/sonnet/opus, main, agy)
Yêu cầu bổ sung: "đo mức độ sử dụng mode, ví dụ trong 1 phiên hoặc công việc cần agy nhưng không xài đến...; để tối ưu và đo được mức tối ưu cho cả agy". Luật chuẩn = hub AGENTS.md mục Subagent: haiku chạy/đọc/test/ops; sonnet builder + review thường; opus planner, review rủi ro, review cuối đợt; agy tra web, đọc rất lớn (> 100k token), ý kiến thứ hai; main tự làm khi <= 2 lệnh đọc; builder ~25 lượt.

Dữ kiện audit (đã xác minh):
- Agent tool: `target = subagent_type`, `data.isolation`, `data.prompt_len` (harness/core/config/audit-config.mjs:57); Task tool: `subagent_type`, `prompt_len` (:58). KHÔNG ghi `model` yêu cầu khi dispatch (không có trong `data` của rule; audit.mjs:270 còn loại khoá `model` khỏi event_data).
- Model THỰC TẾ: trường `model` ở Stop/SubagentStop lấy từ transcript (audit.mjs:287, 307, 315); phantom SubagentStop (~81%) không có.
- `agent_type` ở SubagentStart/Stop (audit.mjs:289-295); `turns` lũy kế ở SubagentStop.
- WebSearch/WebFetch có record riêng (audit-config.mjs:55-56). Read chỉ ghi `offset/limit` (:48), KHÔNG có kích thước nội dung; `data.out_len` hiện chỉ cho Bash (audit.mjs:254-258, Task 0 đã có).
- agy: adapter `harness/observe/audit/adapters/agy.mjs` đặt `cli='agy'` (:131), `model` từ `modelName` (:133), suy `UserPromptSubmit`/`Stop`/`PostToolUse` (:158-176), map tool về Bash/Read/Write/Edit (:182-200), usage qua `agy-usage.mjs` (`sumAgyUsage`). => Segment/khoá vấn đề của Task 3 áp dụng được cho phiên agy (cùng envelope).

Thiết kế (`harness/observe/report/routing.mjs`, source `derived`):
1. Đơn vị = (a) mỗi dispatch subagent (Agent/Task PreToolUse ghép SubagentStart/Stop cùng sid theo thứ tự + agent_type), (b) mỗi Segment main (Task 3), (c) mỗi Segment phiên `cli=agy`.
2. Lớp việc tất định (ưu tiên trên xuống): `web_lookup` (có WebSearch/WebFetch) > `large_read` (tổng `out_len` Read/Grep/Glob/Bash >= 400k ký tự, xấp xỉ 100k token) > `plan` (agent_type planner hoặc Write `docs/superpowers/plans|specs`) > `code_edit` (Edit/Write) > `review` (agent_type reviewer) > `test_run` (Bash khớp `bun test|npm test|tsc`) > `read_small`.
3. Mode kỳ vọng: web_lookup/large_read -> agy; plan -> opus; review -> opus nếu rủi ro (plan slug/files_touched khớp `/auth|perm|guard|deploy|secret|migrat|security/i`), còn lại sonnet; code_edit -> sonnet; test_run/read_small trong subagent -> haiku; Segment main <= 2 lệnh đọc không dispatch -> main (đúng); >= 3 lệnh đọc không dispatch -> lệch `main_overread`.
4. Mode thực tế: `cli=agy` -> agy; còn lại họ model (haiku|sonnet|opus) từ `model` ở Stop/SubagentStop; thiếu (phantom) -> `unknown`, loại khỏi mẫu số, báo `unknown_share`.
5. Lệch: `missed_agy` (kỳ vọng agy, thực tế Claude, gồm main tự WebSearch/WebFetch), `overuse_opus`, `underuse_haiku` (sonnet/opus khi kỳ vọng haiku), `under_model` (thấp hơn kỳ vọng opus/sonnet), `builder_over_turns` (> 25; > 40 đếm riêng), `main_overread`. Chi phí chênh ước = eff_tokens x (giá(thực) - giá(kỳ vọng)) / giá(thực), bảng giá TƯƠNG ĐỐI hằng số trong LIMITS (`{haiku:1, sonnet:3, opus:5, agy:0}`; agy = 0 vì quota riêng - giả định, nhãn "ước").
6. agy vs Claude theo lớp việc: n, median eff_tokens, median wall_ms, error_rate (PostToolUseFailure / tool call), `redo_rate` (khoá vấn đề của Segment agy xuất hiện lại trong Segment Claude <= 24h sau có Edit/Write hoặc dispatch lại cùng lớp), `cost_per_problem`.
7. Liên kết lần gọi agy từ Claude: Bash `cmd_head` = `agy` trong Segment Claude -> `delegated_agy`; phiên agy cùng khoá vấn đề hoặc bắt đầu trong khung Segment đó -> cùng occurrence; có `data.task_id` (HUB_TASK_ID, audit.mjs:161) thì ưu tiên.

Bổ sung audit (Task 12, cộng thêm, chỉ số): `data.model` + `data.run_in_background` cho Agent tool_input (model YÊU CẦU, chuỗi ngắn); `data.out_len` cho PostToolUse Read/Grep/Glob/WebFetch/WebSearch (độ dài, không nội dung; hình `tool_response` từng tool CHƯA xác minh - builder kiểm trên payload thật); agy: kiểm Stop agy có `model` + usage (agy.test.mjs, agy-usage.test.mjs), thiếu thì thêm ở adapter.

KPI (section `kpi-routing`, `kpi-agy`; khoá series = `<section>.<k>`): `kpi-routing.compliance_rate` (up), `.missed_agy`, `.overuse_opus`, `.underuse_haiku`, `.main_overread`, `.builder_over_turns`, `.excess_cost_share`, `.unknown_share` (down), `.under_model` (down, chất lượng); `kpi-agy.share` (trung tính, không vào selfdev), `.cost_per_problem`, `.redo_rate`, `.error_rate` (down). Retro: top-3 ca lệch, khoá ổn định `routing:<loại lệch>:<lớp việc>`, thành issue; thay luật định tuyến (AGENTS.md/agent .md) qua `proposeMetricFix` với `target_metric {kpi:'kpi-routing.<x>', better}` để `metricVerdict` đo tác dụng.

Không đo được (ghi rõ trong báo cáo): "ý kiến thứ hai" (không có tín hiệu tất định); review cuối đợt vs thường; model yêu cầu khi dispatch trước Task 12; ~81% subagent phantom không có model thực tế; `large_read` trước Task 12 chỉ tính Bash.

## Rủi ro bắt buộc
- Quyền phía server: không có server; lệnh mới chỉ đọc, trừ ghi `problems-index.json` và file proposal (đã có cơ chế). `harness evolve dupes --propose` không áp dụng; apply/retire vẫn TTY.
- Thao tác lên chính mình: báo cáo đọc audit có sự kiện của chính lần chạy report/retro - lọc `origin noise`/HookRun như engine (engine.mjs:145).
- Dữ liệu nhạy cảm: `out_len`/`first_ctx` chỉ là số; không ghi nội dung tool_response/prompt; doc id lấy từ target đã redact; content-dupes in `file:dòng` + điểm, KHÔNG in nội dung khối vào audit/retro/knowledge (proposal `after` chỉ mô tả + đường dẫn).
- Hiệu năng: audit 476k token/phiên -> nhiều sự kiện; mọi hàm có `timeoutMs`/`maxEvents`, trả `truncated: timeout|max_events`.

## Câu hỏi / giả định
- Giả định: "lần lặp" = phiên khác cùng khoá; không gộp theo khoảng thời gian trong một phiên.
- Giả định: MEMORY.md nằm ở `<p>/.claude/memory/MEMORY.md` (đúng với hub); dự án khác dùng đường dẫn auto-memory mặc định của Claude thì chưa đo (ghi `memory: not_found`).
- Giả định: bytes/4 là ước; tiếng Việt có dấu thường > 4 token/... nên dùng hệ số hiệu chỉnh từ `first_ctx`.
- Cần người dùng: duyệt hash ext knowledge sau Task H1 (TTY, ngoài phiên).
