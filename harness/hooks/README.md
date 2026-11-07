# Hooks

Từ Đợt 5 mọi hook chạy qua MỘT dispatcher: `harness/hooks/dispatch/`. Chi tiết: [dispatch/README.md](dispatch/README.md).
Mẫu nhóm, giá trị `adapters` và cách thêm CLI: xem [../README.md](../README.md).

## Hiện có
- `dispatch/` — entrypoint duy nhất. `run.mjs <Event>` (Claude, đăng ký `.claude/settings.json`), `agy-native.mjs <Event>` (agy, plugin native, `hooks.json` ở gốc plugin), `modules.mjs` (bảng module theo sự kiện, thứ tự, budget), `merge.mjs` (gộp quyết định).
- `_shared/` — helper agy (`agy.mjs`) và test cấu hình dùng chung. Không phải hook.
- Module thật nằm ở các nhóm harness, không ở đây:
  - `constrain/`: guard, approval, bash-guard, model-policy, verify-gate, proc-orphans, worktree.
  - `observe/audit/`: ghi audit.
- Các stub cũ `audit/`, `guard/`, `bash-guard/`, `proc-orphans/`, `worktree/`, `session/` đã xoá. Không còn đường dẫn `hooks/<nhóm>/hook.mjs` nào.

## Thêm hook mới
1. Viết module `export default { id, events, timeoutMs, onError, handle }` trong nhóm phù hợp: `constrain/` (chặn/kiểm tất định), `observe/` (ghi nhận). Kèm README, config JSON, test.
2. Đăng ký trong `dispatch/modules.mjs` (`ORDER`, và loader). KHÔNG thêm entry mới vào `.claude/settings.json`: settings chỉ có một entry cho mỗi sự kiện, trỏ vào dispatcher.
3. Hook agy: thêm vào `dispatch/agy.mjs` nếu cần. Ghi `adapters` trong manifest của module.
4. Kiểm tra: `node harness/tools/sync.mjs --check`, `node harness/cli/commands/doctor.mjs --adapters`.

## Schema agy `.agents/hooks.json` (VERIFIED agy 1.4.3; docs: agy-customizations/docs/hooks.md)
- Key cấp cao nhất = tên hook (không có `{"hooks":{...}}` kiểu Claude). `SessionStart/PostInvocation/Stop`: danh sách handler phẳng `[{type,command,timeout}]`. Chỉ `PreToolUse/PostToolUse`: `[{matcher, hooks:[handler]}]`. Matcher dùng tên tool agy (`run_command|write_file|edit_file`).
- stdin camelCase: `toolCall:{name,args}` với args PascalCase (`Path`, `Content`, `CommandLine`), `conversationId`, `stepIdx`, `workspacePaths`.
- 3 quy ước: (1) cwd hook = thư mục chứa `hooks.json` = `.agents/`, nên command dạng `node ../harness/hooks/dispatch/agy.mjs <Event>`; (2) stdout PHẢI là JSON object hợp lệ (PreToolUse `{"decision":"allow|deny|ask|force_ask"}`, sự kiện khác `{}`), không in text khác; (3) debug agy qua `agy --log-file <file>`, không in log ra stdout.
- Kiểm tra: `node harness/tools/sync.mjs --check` và `node harness/cli/commands/doctor.mjs` (từ chối layout kiểu Claude).

## Quy tắc
- Quy ước command: agy chạy hook với cwd = `.agents/`, nên command luôn là `../harness/...`. Claude dùng `$CLAUDE_PROJECT_DIR`. Hook agy không dựa vào `process.cwd()`.
- agy dùng plugin native, cài bằng `agy plugin install <gốc plugin>` (hook từ `hooks.json` gốc plugin -> `dispatch/agy-native.mjs`, không đọc `.claude`); tắt bằng `HARNESS_AGY=0` hoặc `.harness/agy.off`. Đã bỏ domain CLI `agy` và đồng bộ `.agents`; doctor cảnh báo một dòng khi còn file di sản. Lưu ý agy 1.4.12 KHÔNG mở rộng `%USERPROFILE%`, `$HOME`, `~`, `${env:...}` trong command hook; command không chứa ngoặc kép hay đường dẫn tuyệt đối.
- Hook phải fail-open (lỗi nội bộ -> `{}`, exit 0), trừ guard có chủ đích chặn.
- Mỗi module có config JSON + giá trị mặc định (`DEFAULTS`) trong code; chạy được khi config thiếu/hỏng. File JSON chỉ là lớp ghi đè (`*.config.local.json` cho ghi đè cục bộ, đã gitignore).
- Thiết kế theo hành vi tổng quát (event -> hành động qua config), không hard-code một mục đích cụ thể.
- Dùng `core/config/config.mjs` (`loadFlat`/`loadHookConfig`): defaults < file < env, không bao giờ throw.
- Bắt đầu bằng cách copy một module nhỏ như `constrain/proc-orphans/`.

## Nhóm chỉ-claude (vì sao)
- `constrain/worktree/`: agy=`n/a`, agy không có event WorktreeCreate/WorktreeRemove (dispatch-worker tạo worktree trước).
- `constrain/proc-orphans/`: agy=`none`, chưa làm cho agy; chưa kiểm agy có Stop/SubagentStop không (không khẳng định là không thể).

## Lịch sử
H1-H4 (delegation guard, post-agent verify, drift grep, session digest) đã gỡ 2026-10-24; code không còn trong git.
