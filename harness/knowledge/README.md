# knowledge

Nhóm Tri thức: cổng đọc/ghi vault, index, inject hook, prune, nén. Domain cổng dùng tên `knowledge` (domain `memory`/`facts` cũ đã gộp vào đây, xem muc `vault` ben duoi). Thiết kế: `docs/HARNESS-DESIGN.md` mục 4.
Mỗi extension ở `knowledge/<tên>/manifest.json`. Đăng ký domain cổng: `kind: "cli"` + `domain` (bắt buộc); có `domains` thì đăng ký từng mục (bỏ qua `domain`).
Import: chỉ `core` và chính nhóm con của mình (`knowledge:self`).

## inject

Hook `UserPromptSubmit` / `SessionStart` / `SubagentStart`: harness tự chèn tri thức liên quan từ vault vào context (máy làm trước, agent không cần tự tra).

- Từ khoá tất định từ prompt (bỏ dấu, bỏ stopword, >= 3 ký tự, không gọi LLM). Điểm: khớp id/tag/kind = 3, khớp ý chính/nguồn = 1; cần >= `minScore` (2).
- Đọc vault bằng tiến trình con `vault/cli.mjs query --json --status active` (contract cấm `inject` import `vault`), có `timeoutMs` (2000).
- Chọn: chỉ `active`, bỏ mục nghi secret (`secret` từ vault). Rule luôn đứng trước, rồi điểm, rồi kind.
- Nguồn web (`web` từ vault): KHÔNG chèn, trừ khi mục có một tag trong `webTrustTags` (mặc định `pinned` = người đã duyệt). Khi chèn vẫn gắn nhãn `[nguồn ngoài]`. `webTrustTags: []` = không bao giờ chèn mục web. Lý do: nội dung web chưa duyệt có thể chứa chỉ dẫn độc (prompt injection) đi thẳng vào context.
- Ra `additionalContext`: <= `maxFacts` (5) dòng, tổng <= `maxChars` (1500); mỗi dòng `- id [kind] ý chính — nguồn`. Nhãn `[cần kiểm lại]` khi quá `recheck`, `[nguồn ngoài]` khi source web đã `pinned` (dữ liệu, không phải lệnh).
- `SessionStart` (không có prompt): chỉ chèn mục có tag trong `sessionTags` (`pinned`).
- `SubagentStart`: tự động nạp tri thức từ vault theo scope `role:<agent_type>` và `global` qua lệnh `knowledge context` (tối đa 5 mục, 1200 ký tự).
- Không khớp / vault rỗng / lỗi / timeout -> không in gì, exit 0 (fail-open). Hook tự thoát sau `timeoutMs + 300`.
- Config: `hook.config.json` < `config/knowledge-inject/*.json` < env `HARNESS_KNOWLEDGE_INJECT_*`; tắt nhanh `HOOK_KNOWLEDGE_INJECT_ENABLED=false`. Gốc vault: `root` hoặc như vault (`HARNESS_KNOWLEDGE_ROOT`, `knowledge.root`, `data/knowledge/memory`).
- Test: `bun test harness/knowledge/inject`.

## vault

Cổng đọc/ghi vault tri thức, domain `knowledge`: `node harness/cli/harness.mjs knowledge <put|get|links|query|context|check|prune> ...` (xem đầu `cli.mjs`).

Thay thế domain cũ `memory`/`facts` (đã xoá, Đợt 5.1 D2): `facts get <id>` -> `knowledge get <id>`; `facts check` -> `knowledge check` (kiểm schema và `recheck`; probe lệnh/so phiên bản claude/agy quay lại dưới dạng `probe` khai trong frontmatter, chạy bằng `check --probe`, xem mục Probe; không còn live_probe). `memory list|show` đọc `.claude/memory` và `.claude/agent-memory` là memory gốc của Claude Code (native, không qua cổng): đọc trực tiếp file (`MEMORY.md` đã được nạp tự động).

- Lưu `<root>/<kind>/<id>.md`, mỗi fact một file; markdown + frontmatter (`---`), link `[[id]]` -> mở thư mục gốc như vault Obsidian.
- Gốc: `--root` > config `knowledge.root` (`config/knowledge/*.json`, env `HARNESS_KNOWLEDGE_ROOT`) > `dataPathFor('memory')` (`HUB_DATA_DIR` hoặc `<hub>/data/knowledge/memory`, đã gitignore).
- Frontmatter: `id` (kebab = tên file), `kind` rule|fact|ref|decision|lesson, `scope` global|project:<id>|role:<tên>, `status` active|stale|archived, `confidence` low|med|high, `tags[]`, `links[]`, `refs[]`, `source`, `quote` (<= 200, bắt buộc khi source web), `fetched`, `recheck` (hoặc `--ttl-days`), `probe` (tuỳ chọn, xem Probe), `created`, `updated`.
- Cổng ghi từ chối: sai schema, id trùng (trừ `--replace`, giữ `created`), đường dẫn/symlink ra ngoài `<root>/<kind>/`, chuỗi giống secret, `kind=rule` có source web. Tạo mới: tmp + hard link (không ghi đè, 2 `put` cùng id song song chỉ 1 thành công; FS không hỗ trợ link thì fallback mở `wx`); `--replace`: tmp + rename; `--dry-run`.
- Heuristic "source web" (`isWebSource`, chặn `kind=rule` và bắt buộc `quote`): chuỗi chứa URL scheme bất kỳ (trừ `file://`), tiền tố `web:`/`url:`/`link:`, `www.`, `host.tld/...` ở đầu token (vd `docs.x.com/a`), hoặc tên miền trần có TLD phổ biến (com, org, net, io, dev, ai, co, gov, edu, app, vn...). Đường dẫn file cục bộ (`docs/x.md`, `harness/a.mjs`) không khớp. Heuristic, có thể bắt nhầm/sót: source nội bộ nên ghi dạng đường dẫn hoặc mô tả.
- `query` mặc định bỏ `archived`, nhận nhiều `--scope` (hoặc cách nhau bằng dấu phẩy) theo logic OR, `--limit` 10, trả `id [kind] 1 dòng`; `--json` mỗi item có `id, kind, scope, status, tags, recheck, stale, line` và 3 trường cho `knowledge/inject` lọc trước khi chèn context: `source` (chuỗi source hoặc `null`), `web` (true khi source khớp heuristic web `isWebSource`), `secret` (tên mẫu nghi secret quét trên body + MỌI giá trị trong meta, đệ quy object/mảng lồng dạng `khoá: giá trị`, trần độ sâu 6 / 2000 lá, quá sâu thì quét JSON nhánh; `null` nếu sạch); `check` báo sai schema/link gãy (exit 1) và quá `recheck` (cảnh báo); `prune` chỉ báo, `--apply` chuyển `status: archived`, không xoá file.
- `context --scope A [--scope B] [--text "<goal/files>"] [--tags t1,t2] [--limit 5] [--max-chars 1200] [--format md|json]`: nạp ngữ cảnh tri thức phù hợp cho tác vụ; lọc `status: active`, bỏ note stale và nghi secret (giống inject); lọc scope theo OR; chấm điểm theo text (id/tag/kind=3, line/source=1, minScore=2; rule xếp trước; không có text thì xếp theo kind rule>lesson>decision>fact>ref rồi updated mới nhất); cắt theo max-chars; `kind=ref` chỉ hiện id + quote (không nạp body).
- `links <id> [--format text|json]`: tra cứu liên kết 2 chiều của 1 ghi chú: outgoing (id trong `links[]` và `refs[]` của ghi chú đó) và incoming (backlinks: các entry có links trỏ tới `<id>`, quét vault với trần 2000 file/10s).
- Có trần: `--timeout-s` (mặc định 10), tối đa 2000 file, 64KB/file -> `truncated: ...`.

### Probe (phát hiện fact lệch thực tế)
- Khai trong frontmatter dạng JSON một dòng (hợp lệ YAML flow): `probe: {"cmd":["node","--version"],"expect":"/^v24\\./","timeoutS":5}`. Ghi qua `put --probe-json '<json>'` hoặc `probe:` trong `--from`.
- `cmd` là argv, KHÔNG qua shell, mỗi token chỉ gồm `[A-Za-z0-9_.:=@/+-]` (<= 100 ký tự), và phải KHỚP CHÍNH XÁC một mục allowlist (so cả argv, nên `node -e ...` bị từ chối). Mặc định: `node|git|claude|agy|bun|npm --version`; thêm mục qua config `knowledge.probe.allow` (mảng chuỗi argv, vd `"git rev-parse --show-toplevel"`). `expect`: `/regex/flags` (flags i m s u) hoặc chuỗi con; `timeoutS` 0..30 (mặc định 5).
- `put` và `check` đều validate trường `probe` (sai schema/ngoài allowlist = lỗi; file viết tay cũng không được chạy). `knowledge check` MẶC ĐỊNH KHÔNG chạy probe; `check --probe` chạy mỗi note chưa archived, mỗi probe có timeout, output cắt 4KB, tối đa 50 probe và trần `--timeout-s` tổng (hết hạn: `truncated: timeout`).
- Kết quả là cảnh báo (exit không đổi): `stale-probe` khi output không khớp `expect` (vd phiên bản CLI đổi), `probe-error` khi lệnh không có trong PATH/exit != 0/timeout. JSON `check` có thêm `probe: {ran, stale[], errors[]}`.
