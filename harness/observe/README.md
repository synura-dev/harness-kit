# observe

Nhóm Quan sát: ghi và đọc bằng chứng khách quan (audit sự kiện, evidence test/tsc/build/hash/health, digest/prune). Thiết kế: `docs/HARNESS-DESIGN.md` mục 4.
Mỗi extension ở `observe/<tên>/manifest.json`. Đăng ký domain cổng: `kind: "cli"` + `domain` (bắt buộc); có `domains` thì đăng ký từng mục `{<domain>: file | {file, desc?, cmds?, default?}}` (bỏ qua `domain`). Kind khác (hook/lib/view) không thành domain.
Import: chỉ `core` và chính nhóm con của mình (`observe:self`).
`audit/` (hook audit) đã chuyển từ `hooks/audit` (Đợt 4; bản cũ là stub spawn). `views/` = domain `observe` (gộp audit-review, audit-tools, runs, data; cost/evidence là module `kind: "lib"` (không phải domain), gọi qua `observe cost|evidence`). Tên cũ `audit`, `audit-query`, `runs`, `data`, `cost`, `evidence` là `aliases` trong manifest (bảng ánh xạ lệnh con `aliasMap`, không còn file shim).

## audit (agent GHI) - schema v2

Hook ghi mỗi sự kiện thành 1 dòng JSON (envelope v2), không bao giờ chặn (try/catch, exit 0, không in gì, chỉ node built-in, timeout hook 3s; Stop/SubagentStop 5s vì đọc transcript).

### Bố cục
`<root>/date=YYYY-MM-DD/type=<type>/<sid>.jsonl` (quá `max_file_bytes` -> `<sid>.1.jsonl`, `.2.jsonl`...). Digest: `<root>/digest/YYYY-MM-DD.md`. `<root>/.state/` chỉ chứa `prune.marker` (hook audit không ghi gì vào đó).
`root` = `$CLAUDE_AUDIT_DIR` (tương thích) hoặc `$HUB_DATA_DIR/audit` hoặc `<hub>/data/audit`.
Layout cũ `type=<t>/date=<d>/<sid>.jsonl` không còn được ghi; query/prune vẫn đọc (back-compat). Chuẩn hóa bằng script migrate-layout (da go khoi harness) (MẶC ĐỊNH DRY-RUN, chỉ in kế hoạch; thêm `--apply` để chuyển). Chạy `--apply` khi không còn hook phiên bản cũ đang ghi. Chuyển bằng link+unlink sang `date=<d>/type=<t>/<tên file>`, không bao giờ ghi đè/append đích. Đích đã có: cùng hash (sha256) -> `duplicate`, giữ nguyên nguồn, không xóa; khác nội dung -> nguồn thành `<sid>.legacy.jsonl` (rồi `.legacy.2`...). Lưu ý: `.legacy` vẫn có thể sinh nếu hook đang append vào đích; duplicate được giữ nguyên, bị quét lại mỗi lần chạy và khiến mã thoát 2; tên `.legacy` thử tối đa 1000 lần rồi ghi lỗi file đó. Bỏ qua `.state`/`digest`, chỉ xóa thư mục cũ khi rỗng; lỗi IO từng file ghi nhận rồi chạy tiếp. Mã thoát: 0 sạch; 2 còn duplicate/dry-run có xung đột/truncated; 1 lỗi IO hoặc cờ lạ. Giới hạn: `--max-files N` (mặc định `limits.migrate_max_files`=2000), `--timeout giây` (mặc định `limits.query_timeout_ms`); chạm trần in `truncated: max-files|timeout`, chạy lại để tiếp tục.

### Envelope v2 (phẳng, khóa ổn định)
`v:2, ts, type, event, sid, agent_id, agent_type, actor(main|sub), project, cwd, tool, target, target_kind(path|command|url|other), ok, dur_ms, turns, tokens_in, tokens_out, status, model, summary(<=120 ký tự), data{}`.
- `ok`: PostToolUse=true (false nếu `tool_response.interrupted`), PostToolUseFailure=false, event khác=null. `status`: started|ok|error|interrupted|stopped|<reason>|<source>.
- `project`: dưới `base_path` (config, mặc định rỗng) -> thư mục cấp 1 sau base_path; cwd là worktree `<p>/.claude/worktrees/<x>` -> `<p>`; còn lại basename(cwd).
- `tokens_in` = input_tokens + cache_creation_input_tokens; `data.tokens_cache` = cache_read; `tokens_out` = output_tokens; `turns` = số message assistant (dedupe `message.id`). Chỉ có ở Stop (từ `transcript_path`) và SubagentStop (từ `agent_transcript_path`). Giá trị là LŨY KẾ trong phiên/agent đó (Stop bắn mỗi lượt) -> lấy max, đừng cộng. Transcript quá `transcript_max_bytes` (8MB) hoặc không đọc được -> null + `data.usage="unavailable"`.
- Trường cộng thêm (v vẫn 2): `origin` (cuối envelope) = `noise` nếu `cwd` khớp regex trong `noise_cwd` (mặc định MỘT regex có ranh giới thư mục `(^|/)(bench|scratch[^/]*|zz-eval[^/]*|mcp-test)(/|$)`: workbench/benchmark-app là work; worktree KHÔNG phải nhiễu; mảng `noise_cwd` trong config GHI ĐÈ cả mảng, không nối; không phân biệt hoa thường; regex hỏng bị bỏ qua) còn lại `work`; CHỈ gắn nhãn, không bỏ ghi; dòng cũ không có `origin` được query tính lại từ cwd bằng cùng regex. `HUB_RUN_KIND` đặt giá trị bất kỳ (kể cả "work") đều thành noise. Ghi đè `noise_cwd` qua audit.config.json.
- Bash (trong `data`, tính trên lệnh đã redact TRƯỚC khi cắt `target` ở `bash_target_max`=160): `cmd_head` (token lệnh đầu, bỏ tiền tố `cd <path> &&`), `cd_prefix` (bool), `target_truncated` (bool). `target` không đổi.
- `data.out_len` (PostToolUse Bash): độ dài `stdout`+`stderr` (hoặc chuỗi response), trần 1e9; chỉ số, không lưu nội dung; không có response thì không có trường. `data.usage.first_ctx` (Stop/SubagentStop delta): input + cache_creation + cache_read của message assistant ĐẦU trong delta (kích thước context lúc vào); delta rỗng thì không có.
- `usage_reason` (cùng `data.usage="unavailable"`): `no_path` (payload không có đường dẫn) | `not_found` (file không tồn tại; với SubagentStop thường do `agent-<id>.jsonl` không có ở đường dẫn payload) | `too_big` | `parse_fail` (không phải .jsonl/không đọc được). Không ghi đường dẫn.
- PHANTOM: SubagentStop không có `agent_type` (và không có SubagentStart cùng `agent_id`) -> `data.phantom=true`, `data.usage="unavailable"`, `usage_reason="no_transcript"`, KHÔNG đọc transcript (đo thực: ~81% SubagentStop, không có Start/Tool event/transcript; suy luận chưa xác minh: agent nội bộ của harness). query/digest MẶC ĐỊNH loại dòng phantom; `--include-phantom` để xem. Dòng cũ chưa có nhãn nên vẫn xuất hiện.
- SubagentStop thiếu `agent_transcript_path`: thử `dirname(transcript_path)/<session_id>/subagents/agent-<agent_id>.jsonl` (không retry/đợi).
- Env `HUB_RUN_KIND` (bench|eval|play|...) -> `data.run_kind` và `origin=noise`. Chưa kiểm chứng end-to-end (hook kế thừa env tiến trình cha theo docs; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` sẽ lọc); chỉ test đơn vị qua spawn.
- Payload đã xác minh (d.ts/docs): PostToolUse không có exit_code (Bash lỗi -> PostToolUseFailure, `error` "Exit code N"); PermissionDenied có `tool_name, tool_input, tool_use_id, reason`; audit chỉ quan sát, không ghi/không đổi quyết định của PermissionRequest.
- SubagentStop thiếu `agent_type` nhưng có Start: tra ngược dòng SubagentStart cùng `agent_id` trong file `date=<hôm nay>/type=subagent/<sid>*.jsonl` (đọc đuôi tối đa `agent_lookup_max_bytes`=1MB; không tạo file trạng thái; không thấy -> null).
- Đã bỏ các trường không có consumer: `description_len, content_len, text_len, old_string_len, new_string_len, data.output_mode, data.run_in_background` (dòng cũ vẫn có).
- `PermissionDenied` có trong `hook_events` (khối hooks do `node harness/cli/commands/doctor.mjs` in ra; áp vào settings là việc thủ công).
- `dur_ms`: lấy từ `duration_ms` của payload (PostToolUse/Failure); thiếu thì `null` (không tự đo; query/digest bỏ qua null). PostToolUseFailure có `duration_ms` (xem mục payload) nhưng vẫn có thể null.
- Không ghi nội dung (content/old_string/new_string/tool_response/prompt): chỉ `*_len`, `data.exit_code`. NGOẠI LỆ: PostToolUseFailure ghi `data.error` (payload `error`, đã redact, gộp khoảng trắng, cắt `error_max`=200; 0 = tắt) và nối vào `summary` sau " | " (summary vẫn <=120). `data.error_len` giữ độ dài gốc.
- SubagentStop: payload thật KHÔNG có `status`/`turns` (đã xác minh) nên `status`="stopped" cố định; `turns` lấy từ transcript (nếu đọc được). Nếu payload tương lai có `status`/`turns` thì ghi `data.payload_status`/`data.payload_turns` (chưa từng thấy thực tế). Phát hiện chạm maxTurns: so `turns` với maxTurns của agent; chưa có tín hiệu trực tiếp.
- digest: mặc định loại phantom (nhãn `data.phantom` + dòng cũ chưa nhãn: agent chỉ có SubagentStop, không agent_type, 0 tool, không token); `digest.mjs DATE --include-phantom` để xem.

### Cấu hình (mặc định trong code, config chỉ ghi đè)
`defaults.mjs` là nguồn sự thật; `audit.config.json` (hiện chỉ `{"retention_days":30}`) ghi đè, `audit.config.local.json` ghi đè cục bộ (gitignore); env `CLAUDE_AUDIT_RETENTION_DAYS`, `CLAUDE_AUDIT_MAX_FILE_BYTES`. Khóa mới: `base_path`, `transcript_max_bytes`, `limits.digest_max_rows`. Config thiếu/hỏng -> mặc định.
Thêm loại mới (không sửa code): `events` (event->type), `tools` (`match`, `target`, `kind`, `data`, `len`), `redact`, `sensitive_files`, `retention_days`, `max_file_bytes`.

### agy: payload that va loi (agy 1.5.x, kiem that 2026-11-07)
- `HUB_AGY_CAPTURE=<file>` (mac dinh TAT): adapters/agy.mjs ghi them stdin tho da redact, moi dong 1 payload.
- Payload chung: conversationId, workspacePaths, transcriptPath (SessionStart/PostInvocation/Stop; Post tool co o ban 1.5 thuc te, T0 tung ghi khong co -> neu thieu adapter suy `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`, convId chi `[\w-]+`), modelName -> `model`.
- Post: `error` chuoi tu do (vd "file does not exist") -> ok:false + `data.error`. Exit code khac 0 (tu "exit status N" theo tai lieu, chua thay that; khong doc transcript o Post) -> ok:false, status error, `data.exit_code`.
- Stop: terminationReason/executionNum/fullyIdle -> `data.stop_reason`/`exec_num`/`fully_idle`; ERROR, MAX_* -> ok:false; USER_CANCELED -> `data.signal` interrupt.
- Token: lay tu transcript qua parser `adapters/agy-usage.mjs` (`sumAgyUsage`), delta theo offset trong `data.usage`. `tokens_in/out` o Stop la cong don ca transcript -> bao cao dung `data.usage` (muc report `cost-cli` tach theo cli).
- `dur_ms`: Post chi co khi co marker Pre (chi run_command/write_file/edit_file) -> `data.dur_src` = `marker`; con lai null (Post ban TRUOC khi agy ghi buoc GENERIC vao transcript nen khong doc duoc dur/exit code o Post; ban 1.5 thuc te Post CO transcriptPath). Thoi gian tool agy tong hop o Stop: `data.usage.tool_ms` (+ `tool_steps`), do phan giai giay, theo delta moi Stop; report `cost-cli` cot "ms tool (transcript)".
- Them tool moi: (1) adapter rieng cho tool do; (2) parser tinh token truyen vao `buildEnvelope` qua `opts.usage.sum`; (3) core `audit.mjs`/`usage-tail.mjs` khong biet ten tool, khong sua.

### Bật
`node harness/cli/commands/doctor.mjs` in khối `hooks` đúng đường dẫn máy (danh sách event/matcher/timeout ở `hook_events` trong `defaults.mjs`; đã thêm `Stop`). Cần node trong PATH.

### Đọc / digest / prune
Công cụ đọc/digest/prune/migrate/bench đã chuyển sang `harness/observe/views/` (lệnh `node harness/cli/harness.mjs observe query|digest|prune`, xem QUERY.md). Config + mặc định: `harness/core/config/audit-config.mjs` (re-export qua `defaults.mjs`).

### Xác minh (chạy thật `claude -p --model haiku`, 2026-10-25, hook capture stdin)
Đã xác minh bằng payload thật:
- Chung: `session_id, transcript_path, cwd, prompt_id, hook_event_name`; `permission_mode`, `effort{level}` ở hầu hết event; subagent thêm `agent_id, agent_type`.
- PreToolUse: `tool_name, tool_input, tool_use_id`. PostToolUse: thêm `tool_response` (Bash: `stdout, stderr, interrupted, isImage, noOutputExpected`; Agent: `status:"async_launched", agentId, resolvedModel`) và **`duration_ms`**.
- Lỗi tool KHÔNG đi qua PostToolUse mà là event riêng **PostToolUseFailure**: `error` ("Exit code 2\n..."), `is_interrupt`, `duration_ms`.
- Stop: `stop_hook_active, last_assistant_message, background_tasks, session_crons, transcript_path`; SubagentStop: thêm `agent_transcript_path` (file `<session>/subagents/agent-<id>.jsonl`). Không có trường token/turns/model trong payload hook.
- Transcript .jsonl: dòng `type:"assistant"` có `message.id, message.model, message.usage{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`; 1 `message.id` lặp nhiều dòng (mỗi content block) -> dedupe theo id (lấy output_tokens lớn nhất).
- SessionStart: `source`; UserPromptSubmit: `prompt`, `prompt_id`; SessionEnd: `reason` (thấy `other`), không có `transcript_path`.
- Stop/SubagentStop vẫn bắn khi subagent chạy nền (Stop chính bắn trước khi subagent xong; sau đó Stop thứ 2).
Chưa xác minh: trường `model` trong payload hook (không thấy ở SessionStart/Stop thật; model lấy từ transcript); `message`/`notification_type` của Notification; PermissionRequest/Denied; hành vi `matcher` cho event không phải tool; định dạng transcript có ổn định giữa các phiên bản Claude Code hay không (nên đọc phòng thủ, đã làm).
Query DuckDB: SQL v1+v2 (gồm cột `origin`, lọc phantom) CHƯA KIỂM CHỨNG: không chạy được ở máy này (không có duckdb). Backend mặc định là Node thuần (`--backend auto` chỉ dùng duckdb nếu có), đã test, không phụ thuộc duckdb.


## cost

Tóm tắt tất định token/chi phí từ audit (chỉ ĐỌC). Domain cổng: `cost`.

- `node harness/cli/harness.mjs cost summary [--since 7d|24h|YYYY-MM-DD] [--by model|role|day|session]`: tổng in/out/cache, số lượt, cost ước tính, số lượt `cheaper_possible`.
- `node harness/cli/harness.mjs cost top [--limit N] [--since D]`: lượt tốn nhất (role, model, thời lượng, `cheaper_possible`).
- Chung: `--timeout-s` (10), `--read-max-bytes` (64MB), `--max-bytes`, `--json`. Báo `truncated: timeout|max_bytes`.

Nguồn: `data/audit/date=D/type=subagent` (SubagentStop: model, turns, tokens_in/out, `data.tokens_cache`; thời lượng = Stop - Start cùng agent_id) và `type=session` (Stop của main, token TÍCH LUY theo phiên: lấy bản ghi cuối mỗi phiên). Đọc qua `readAuditEvents` của core. `tokens_in` gồm input + cache_creation (không gồm cache_read); `data.usage` tách riêng input/output/cache_read/cache_creation.

Giá: `cost.config.json` (USD/1M token, theo id model hoặc alias haiku|sonnet|opus), ƯỚC TÍNH, CẬP NHẬT TAY; ghi đè bằng `config/cost/default.json`. Giá `null` thì `cost=null` (không bịa giá). `cheaper_possible`: role có trong `config/models` (loadConfig("models")) và model đã dùng đắt hơn model chính sách; không có chính sách thì bỏ cờ.

## evidence

Bằng chứng khách quan từ audit (chỉ ĐỌC `data/audit/**/type=tool/*.jsonl`, không sửa audit). Domain cổng: `evidence`.

- `node harness/cli/harness.mjs evidence list [--session S] [--task T] [--since D|ISO] [--days N] [--limit N] [--all]`
- `node harness/cli/harness.mjs evidence summary [--task T] [--session S] [--limit N]`: đếm pass/fail/none theo kind; `pass sau sua cuoi` = lần chạy cuối của kind là pass và sau lần Edit/Write cuối (`files_touched`) trong cùng phạm vi.
- Chung: `--timeout-s` (mặc định 10), `--read-max-bytes` (tổng byte đọc, mặc định 64MB), `--max-bytes` (cắt đầu ra), `--json`, `--raw` (bản ghi audit gốc đã redact để gỡ lỗi). Không `--since` thì đọc 2 ngày mới nhất. Báo `truncated: timeout|max_bytes|limit`.

Schema: `{ts, session_id, task_id|null, tool:'Bash', kind|null, outcome:'pass'|'fail'|'none', exit_code|null, source:'audit', event_id}`. Không chứa lệnh thô/stdout.

Quy tắc tất định (không phán đoán):
- `kind` = `verifyKind(cmd)` ở `core/audit/fingerprint.mjs`: test|tsc|lint|build|hash|health|null (1 dòng, không pipe/`;`/`||`/nền; chuỗi `&&` lấy kind đoạn cuối).
- `kind`: bản ghi mới có `data.verify_kind` (audit tính trên lệnh đầy đủ, trước khi cắt target) thì dùng nguyên (kể cả null) và tin `verifier_outcome` của audit; bản ghi cũ (không có trường) tự tính như dưới.
- `outcome`: audit đã có `verifier_outcome` pass|fail (xét trên lệnh đầy đủ) thì dùng; nếu không, chỉ tự tính khi target đầy đủ 1 dòng (không bị cắt) qua `verifierOutcome` (PostToolUse=pass, PostToolUseFailure=fail, interrupted/nền=none); còn lại `none`.
- Giới hạn: target audit bị cắt (~160 ký tự) nên lệnh dài có kind theo phần nhìn thấy nhưng outcome `none`. `curl` không `-f` trả 0 cả khi HTTP 500.

## diff-review (gói review tất định)

Máy chuẩn bị gói review từ `git diff`; phán đoán vẫn thuộc `/code-review`, `/security-review`, subagent `reviewer` (không viết lại). Không config/cờ manifest mới, không ghi đĩa, không gọi LLM.
- Lệnh: `harness review pack [dir] [--base R] [--json]` (dir mặc định cwd; qua cổng `harness` CLI chạy với cwd = thư mục plugin nên BẮT BUỘC chỉ `dir`; gốc repo = `git rev-parse --show-toplevel`, dòng đầu in `repo=<gốc>` và lệnh in ra dùng `git -C <gốc> diff ...`). Base = merge-base với `main` -> `master` -> `origin/HEAD` (dòng đầu in base đã dùng; không có thì báo rõ, exit 0), gồm thay đổi chưa commit (file chưa theo dõi chỉ được đếm). Không phải git -> thông báo, exit 0. Hết hạn -> `truncated: timeout`. Stdout <= 40 dòng, KHÔNG chứa nội dung dòng diff: chỉ bundle, `path:line`, tên cờ và lệnh `git diff <base> -- <files>`.
- Bundle: theo thư mục, trần 400 dòng/bundle, file lớn bundle riêng, tối đa 8 bundle (vượt thì gộp lên thư mục cha), tối đa 300 file (`truncated: max_files`). Hằng số đóng băng ở `diff-review/pack.mjs` (`LIMITS`).
- Cờ: `sensitive-path` (đường dẫn auth/permission/secret/token/migration/deploy/.env...), `no-test-change` (đổi code mà không có test đi kèm), `secret-like` (dòng thêm khớp `maskSecrets` của core VÀ là chuỗi literal >= 8 ký tự hoặc tiền tố token đã biết sk-/ghp_/github_pat_/AKIA/xox/-----BEGIN; `token: string` không bị gắn; chỉ in `path:line`), `unverified` (chưa có test pass sau lần sửa cuối, theo `harness evidence summary`; hook bỏ qua cờ này để giữ ngân sách 2s), `large`.
- Hook `SubagentStart` (module `diff-review`, `timeoutMs` 2000): khi tên agent khớp `/review/i` (quy ước, không config) tự đẩy cùng nội dung (<= 20 dòng) vào `additionalContext`; không git/không diff/lỗi -> không làm gì. Dispatcher gộp `additionalContext` cho mọi sự kiện (`merge.mjs`), có test end-to-end qua `run.mjs`.
- Cách dùng: mỗi bundle giao một agent (`/code-review` hoặc subagent `reviewer`, chạy lệnh `git diff` của bundle); bundle có `sensitive-path` hoặc `secret-like` lọc thêm bằng `/security-review`; `no-test-change`/`unverified` nhắc chạy test trước khi duyệt.
