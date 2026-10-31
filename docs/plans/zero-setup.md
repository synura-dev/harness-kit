# Kế hoạch (mảng A, plugin): harness-kit "cài là dùng" (zero-setup)

Trạng thái: KẾ HOẠCH, chưa sửa code (2026-10-31). Tách từ `E:\11. Agents\docs\plans\harness-zero-setup-plan.md`. Tài liệu này chỉ về plugin; `HK/` = gốc repo plugin này.
Ký hiệu: [XN] đã xác nhận bằng file:dòng hoặc docs; [CKC] chưa kiểm chứng (cần chạy thật).
Mục tiêu: người dùng thường chỉ cài plugin; dữ liệu, cấu hình, agy, kiểm lỗi do hệ thống tự làm; mọi lỗi báo agent theo một hợp đồng có lệnh sửa. Plugin tự đủ: không cần launcher hay script ngoài repo.

## 0. Hook agy: lỗi cần chặn từ gốc
- [XN] `findBadHookCommands` chỉ kiểm đường dẫn tuyệt đối/tiền tố `.agents` (`HK/harness/core/io/paths.mjs:136-147`), KHÔNG kiểm script đích tồn tại hay event hợp lệ. Một hooks.json agy viết sai (vd thiếu dấu cách giữa script và event) lọt doctor.
- Hệ quả [XN theo memory agy-hooks-real-schema, agy 1.4.3]: hook PreToolUse lỗi = chặn MỌI tool agy; lỗi hook không hiện trong `agy -p`.
- Việc: thêm kiểm "script đích tồn tại, event hợp lệ" vào doctor. Test: fixture hooks.json sai -> doctor `[LOI]`; chạy `agy -p` thật 1 lệnh `git status` + đọc `--log-file`.

## 1. Vị trí dữ liệu và cấu hình tự sinh
Hiện trạng [XN]:
- `dataDir` (`HK/harness/core/io/paths.mjs:39-47`): `HUB_DATA_DIR` > plugin mode `<dự án>/.harness/data` > thư mục gốc mặc định.
- `.gitignore`: `ensureDataIgnore` (`paths.mjs:50-70`) tạo lười khi ghi lần đầu (`storage.mjs:79,93`), nội dung `*` (comment dòng 49 ghi `data/`, lệch). `*` cũng che `.harness/config` (lớp cấu hình dự án, `config.mjs:115`) -> lớp dự án không commit được.
- Wrapper hook plugin tự suy biến vị trí dữ liệu/cấu hình theo bố cục thư mục (`HK/hooks/run.mjs:17-27`); suy luận này trùng với nơi khác, cần gom một chỗ.
- Lớp máy: `pluginLayerDirs` = `CLAUDE_PLUGIN_DATA` | `~/.claude/plugins/data/<name>/config` (`HK/harness/core/config/config.mjs:111-116`).
  Docs [XN docs, code.claude.com plugins-reference]: `CLAUDE_PLUGIN_DATA` = `~/.claude/plugins/data/<id>/`, `<id>` = định danh plugin đã thay ký tự lạ bằng `-`; biến KHÔNG có trong môi trường lệnh Bash tool.
  => CLI do agent gọi (không có biến) rơi về `.../data/harness-kit/` còn hook dùng `.../data/<id>/`: hai bên đọc HAI file `ext/local.json` khác nhau (`ext-registry.mjs:67-74`). [CKC: giá trị `<id>` thật, vd `harness-kit-synura`].
Thiết kế:
- Mặc định: dữ liệu `<dự án>/.harness/data`, cấu hình `<dự án>/.harness/config`, trạng thái `.harness/.state`. Biến env `HUB_DATA_DIR`/`HARNESS_CONFIG_DIR` vẫn là ghi đè tường minh.
- Một hàm `resolveLayout({env,cwd})` trong `core/io/paths.mjs` trả `{mode:'env'|'project', workspace, dataDir, configDir, machineDir, source}`; hook (`hooks/run.mjs`), CLI `bin/`, shim agy cùng gọi (bỏ suy luận trùng ở `run.mjs:17-27`).
- `machineDir` khi thiếu `CLAUDE_PLUGIN_DATA`: tìm mục trong `~/.claude/plugins/installed_plugins.json` có `installPath` (realpath) = `codeRoot()`, tính `<id>` = sanitize(khoá `name@marketplace`); không thấy -> fallback cũ + cảnh báo HK-LAYOUT-002.
- `.harness/.gitignore` đổi thành `data/` + `.state/` (giữ `config/` commit được) - CẦN DUYỆT vì đổi hành vi đã có chủ đích (`paths.mjs:62-63` cố ý ép `*`). Tạo sớm ở SessionStart (mục 4), không chờ lần ghi đầu.
- Không thêm config mới (defaults over config).
Test: unit `resolveLayout` (env ghi đè/dự án thường/worktree/biến thiếu), fixture `installed_plugins.json` -> id; test hồi quy `ensureDataIgnore`.
Rủi ro: đổi `machineDir` làm "mất" đăng ký ext cũ -> đọc cả đường cũ (read-legacy) 1 phiên bản, `doctor` báo lệnh `data mv`.

## 2. CLI cho agent qua `bin/` của plugin
Hiện trạng [XN]: plugin repo CHƯA có thư mục `bin/` (glob rỗng).
Docs [XN docs, chưa chạy thật]: "Files in `bin/` are on the Bash tool's PATH while the plugin is enabled". Plugin có `bin/` thì claude.ai/Cowork không cài (không ảnh hưởng Claude Code CLI).
Thiết kế:
- Thêm `HK/bin/harness` (shebang `#!/usr/bin/env node`, tự định vị gốc plugin bằng realpath của chính file) + `HK/bin/harness.cmd` cho Windows; workspace = `git rev-parse --show-toplevel` của cwd, không có thì cwd; rồi `resolveLayout`.
- Agent gọi `harness <domain> <lệnh>` (vd `harness projects resolve <id>`).
[CKC] CHƯA kiểm chứng trên Windows: Bash tool (Git Bash) chạy file shebang không đuôi; PowerShell tool có PATH này không; `.cmd` có được nhận. Kiểm bằng phiên thật: `harness --version`, `where harness`. Chưa kiểm xong thì README không hứa lệnh `harness`.
Plugin phạm vi dự án (`.worktrees/plugin-trial/docs/plugin-project-scope-trial.md`, nhánh `plugin-hooks-trial`):
- Đã có [XN]: `HK/hooks/hooks.json` 14 event exec-form, `HK/hooks/run.mjs`; checklist thử (dòng 21-31) CHƯA chạy; điểm chưa chắc dòng 33-41 (env settings vào hook plugin, thứ tự hook, `${CLAUDE_PLUGIN_ROOT}` có dấu cách trên Windows, marketplace path tuyệt đối không mang máy khác).
- Việc: user chạy checklist (Đợt 1b) -> có kết quả mới chốt luồng cài. Lệnh cài chuẩn (`claude plugin install ... --scope project`?) [CKC] tra docs cli-reference trước khi ghi README.

## 3. agy dùng chung, sinh từ plugin
Hiện trạng [XN]: validator schema agy có sẵn (`paths.mjs:103-133`). Dispatcher agy `HK/harness/hooks/dispatch/agy.mjs` (PreToolUse phải in `{"decision":"allow"}`, dòng 3). Hook agy: cwd=`.agents/`, không có biến workspace (memory agy-hooks-real-schema).
Quyền agy [XN memory agy-headless-facts]: rule ở `~/.gemini/antigravity-cli/settings.json`, cú pháp `command(<prefix>)`, `read_file(<path>)`; cấm wildcard; user đã duyệt bộ chỉ đọc ngày 2026-10-30.
Thiết kế:
- Shim ổn định `<machineDir>/../bin/agy-hook.mjs` (trong `CLAUDE_PLUGIN_DATA`, không đổi khi plugin cập nhật) tự tìm gốc plugin hiện tại qua `installed_plugins.json` rồi gọi `dispatch/agy.mjs <Event>`; thiếu plugin: PreToolUse in `{"decision":"deny","reason":"HK-AGY-001 ..."}`, event khác `{}`.
- Lệnh `harness agy init [--check]`: sinh/merge `.agents/hooks.json` theo khoá tên hook `harness-kit` (chỉ thay khoá của mình, giữ hook khác); command = `node "<shim tuyệt đối>" <Event>`. Nới `findBadHookCommands` cho đường dẫn trỏ shim (hiện coi tuyệt đối là lỗi, `paths.mjs:144`).
- `harness agy rules --print`: in bộ allow chỉ đọc đề xuất + diff với settings hiện có. `--apply` chỉ khi TTY yes, sao lưu `.bak-<ngày>`; KHÔNG tự ghi từ hook (settings gốc của user).
- "Dùng chung": một shim/lớp máy cho mọi dự án; `agy-home` hiện nằm `.harness/data/external/agy-home` (trial doc dòng 40) - hỏi user.
Test: unit sinh/merge (giữ khoá lạ, idempotent, validator walkAgyHooks sạch); chạy `agy -p` thật trong bản sao + `--log-file` (bắt buộc theo memory).

## 4. SessionStart tự sửa, ext tin theo plugin, install / doctor --fix
Hiện trạng [XN]: SessionStart chạy `[AUDIT, INJECT, WORKTREE, DATA_CHECK]` (`dispatch/modules.mjs:43`), ngân sách 27000ms (`modules.mjs:12`), timeout hook 30s (`HK/hooks/hooks.json:13`). `install.mjs` (dòng 1-2, 44-46) còn hướng dẫn dán hook tay vào settings: lỗi thời trong chế độ plugin. Ext ngoài phải `ext register` qua TTY (`ext-registry.mjs:144-166`), non-TTY trả code 2.
Thiết kế:
- Hooks do plugin cung cấp qua `hooks/hooks.json`; người dùng không dán gì vào settings.
- Module `SETUP` chạy đầu SessionStart, trần 1500ms, fail-open, idempotent, chỉ TẠO không xoá/ghi đè: thư mục data/config, `.harness/.gitignore`, shim agy (mục 3), kiểm `agy init --check` (lệch -> báo, không tự ghi hooks.json của dự án nếu khoá do người viết), kiểm bun (`bun --version` timeout 1s, cache 24h trong `.state`). Node có sẵn vì hook chạy bằng node; kiểm phiên bản tối thiểu.
- Ext của chính plugin (root nằm trong `codeRoot()`, plugin mode): tin không cần register (toàn vẹn = bản cài plugin); vẫn chặn trùng domain core. Ext ngoài giữ hộp duyệt TTY; thông báo chặn theo hợp đồng mục 5.
- `harness install` = chạy SETUP + `agy init` + doctor rút gọn, không động `.claude/settings.json`; `doctor --fix` chỉ chạy các `fix_command` gắn cờ `safe:true` (tạo thư mục/file thiếu, sinh lại khoá agy của mình).
Test: unit SETUP (thư mục trống, chạy 2 lần không đổi, quá giờ thoát êm); test ext tin theo plugin + ext ngoài vẫn exit 66; bench độ trễ SessionStart (`evolve/eval/bench/hook-latency.mjs`).
Rủi ro: plugin nạp tại chỗ từ thư mục dev (sửa được) -> "tin theo plugin" = tin cây làm việc; chấp nhận như code hook, ghi rõ trong README.

## 5. Hợp đồng lỗi và vòng tự phát triển
Hợp đồng (file `HK/harness/core/io/err.mjs`, Đợt 1 gói 0, ghi nguyên văn trước khi song song):
`{code:'HK-<VÙNG>-<NNN>', severity:'error'|'warn', cause, fix_command|null, next_step, safe:boolean, source}`; in 1 dòng `HKERR <json>` ra stderr + dòng người đọc; audit ghi `error_code`.
Thông báo hiện có CHƯA theo hợp đồng [XN]:
- `HK/harness/cli/harness.mjs:137` `ext <d>: CHAN (exit 66)`; `core/ext/ext-host.mjs:14` bảng EXIT, `:17-21` blockExternal, `:39`,`:79` audit `ext-fail`.
- `cli/commands/ext-registry.mjs:80-81` registry hỏng, `:159-166` register (code 1/2).
- `cli/commands/doctor.mjs:19` timeout exit 2, `:39` dòng `[MISS]`, `:59,109,152,171,193` `[LOI]`/`[warn]` văn bản tự do.
- `hooks/dispatch/agy.mjs:42` đẩy văn bản doctor ra stderr (agy không hiện).
- `core/io/storage.mjs:92,97` `data-enforce` văn bản; `:49` `formatWarn` đã có `fix` (gần hợp đồng nhất -> chuyển đổi trước).
- `HK/hooks/run.mjs:37-40` nuốt mọi lỗi, không vết: thêm audit `HK-HOOK-001` (vẫn fail-open).
- `build/install/install.mjs:44-46` hướng dẫn tay lỗi thời.
Đưa vào agent:
- SessionStart: `doctor --brief --json` (timeout 3s, tối đa 5 mục/600 ký tự, cache theo dấu vân tay đầu vào) -> `additionalContext`; không lỗi -> không in.
- PostToolUseFailure: hiện chỉ AUDIT (`modules.mjs:35`, audit ghi `error_fp` `observe/audit/audit.mjs:155-157`). Thêm module `ERR_HINT`: lỗi có `HKERR` -> trả `fix_command`/`next_step`. [CKC] PostToolUseFailure nhận `additionalContext`: kiểm docs hooks + chạy thật.
- Evolve: `candidates` gom theo `error_fp` >=3 lần/7 ngày (`evolve/loop/loop.mjs:17,67-110`); ưu tiên gom theo `error_code` khi có (ổn định hơn fp). Digest SessionStart thêm tối đa 3 lỗi lặp (cache 24h) + gợi ý `harness evolve propose <cid>`; apply vẫn cần `--approve` của người.
Test: unit err.mjs (schema, cắt dài, không lộ secret qua `redact`); snapshot mỗi thông báo đã chuyển; test digest rỗng khi sạch; candidates theo error_code.
Rủi ro: dữ liệu nhạy cảm trong `cause` (đường dẫn, lệnh có token) -> qua `observe/audit/redact.mjs` trước khi ghi/in; digest phình context -> trần ký tự cứng.

## 6. Luồng người dùng cài plugin
Mục tiêu: `claude plugin marketplace add <nguồn>` -> `claude plugin install harness-kit@<marketplace>` -> mở phiên: SETUP tự chạy, không bước tay khác. [CKC] cú pháp lệnh và `--scope` đúng theo docs cli-reference, chưa chạy thật.
- README ngắn: 3 lệnh cài, kiểm `harness doctor`, nơi dữ liệu (`.harness/`), ghi chú tin ext và code nạp tại chỗ (mục 4).
- Icon/metadata marketplace: tra docs plugin manifest trước khi thêm trường; [CKC] trường icon nào được nhận.
- Kiểm chấp nhận: máy/dự án sạch, chỉ cài plugin -> phiên đầu tạo `.harness/`, `doctor` xanh, digest rỗng.

## Thứ tự đợt (mảng A)
- Đợt 0: mục 0 (kiểm doctor hooks agy) - nhỏ, tuần tự.
- Đợt 1: gói 0 `err.mjs` + chữ ký `resolveLayout` (hợp đồng, ghi nguyên văn); song song 1b: user chạy checklist plugin-trial.
- Đợt 2 (song song, mỗi gói file riêng): A layout+machineDir; B `bin/harness`; C agy shim+`agy init`; D SETUP+ext tin plugin+install; E chuyển thông báo sang hợp đồng.
- Đợt 3: digest SessionStart, ERR_HINT, evolve theo error_code; README + luồng cài (mục 6); verifier chạy full suite MỘT lần.
- Đợt 4: thử trong phiên thật (kết quả là điều kiện cho mảng B).

## Cần user quyết (mảng A)
1. `.harness/.gitignore`: đổi `*` -> `data/` + `.state/` để commit được `.harness/config`?
2. Shim agy đặt trong `CLAUDE_PLUGIN_DATA` (đường tuyệt đối trong `.agents/hooks.json`, mỗi máy sinh lại, nên gitignore?).
3. Ext ngoài: chỉ TTY, hay cho phép hộp PermissionRequest `ask` của Claude (rủi ro: agent gọi đường khác né rule ask)?
4. `agy rules --apply` có được ghi settings agy của máy (có backup, TTY yes) không.
5. `agy-home` dùng chung một nơi lớp máy hay mỗi dự án.
6. Commit ở repo plugin: nhánh nào (`plugin-hooks-trial` hay `source-flip`).
