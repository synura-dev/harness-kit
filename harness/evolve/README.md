# evolve

Nhóm Tiến hóa: phát hiện lặp, đề xuất, eval hồi quy, apply có version, rollback. Thiết kế: `docs/HARNESS-DESIGN.md` mục 4.
Mỗi extension ở `evolve/<tên>/manifest.json`. Đăng ký domain cổng: `kind: "cli"` + `domain` (bắt buộc); có `domains` thì đăng ký từng mục (bỏ qua `domain`).
Import: chỉ `core` và chính nhóm con của mình (`evolve:self`).

## eval

Oracle tất định cho chính harness: bộ eval hồi quy cố định để biết thay đổi harness tốt lên hay tệ đi. KHÔNG gọi LLM.

### Lệnh (qua cổng)
- `node harness/cli/harness.mjs eval run [--json]` — chạy mọi ca; exit 1 nếu có ca trượt hoặc ca hỏng schema.
- `eval list` — liệt kê ca. `eval baseline` — chạy + lưu `data/knowledge/eval/baseline.json` (data/ gitignore). Có ca trượt/lỗi ca thì KHÔNG ghi đè (không hạ chuẩn), exit 1; `--force` mới ghi — lệnh này bị approval hỏi người (`eval-baseline-force`).
- `--hub-config-dir D` (run/compare/baseline): mỗi ca chép `D` vào `<tmp>/config` riêng của ca rồi trỏ `HUB_CONFIG_DIR`/`HARNESS_CONFIG_DIR` vào đó — vẫn cô lập, gốc `D` không bị sửa. Evolve từng dùng cờ này; nay evolve chỉ đề xuất skill/fact nên không gọi nữa (cờ giữ cho đích config sau này). Không có cờ: `<tmp>/config` rỗng như cũ. JSON kết quả (và baseline) có `config: "default" | "<D tuyệt đối>"`.
- `eval compare [--json]` — chạy + so baseline: `newFail` (ca mới trượt), `newPass`, `added`, `removed`; exit 1 khi có `newFail`, 2 khi chưa có baseline. Đây là API cho vòng tiến hoá.
- Cờ: `--case S` (id/chuỗi con/nhóm), `--cases-dir D`, `--baseline-file F`, `--case-timeout-s N` (mặc định 20), `--timeout-s N` (trần tổng, mặc định 170; hết trần: ca còn lại `ok:false`, `truncated: timeout`).
- `eval bench [--event E] [--n N] [--timeout-s N] [--settings F] [--out F [--force]] [--json]` — đo độ trễ hook (p50/p95 mỗi event, mặc định 20 lần) từ `.claude/settings.json` qua `bench/hook-latency.mjs`. Mặc định chỉ in stdout (`--json` cho JSON); chỉ ghi file khi có `--out <đường dẫn>`, không bao giờ ghi đè `docs/research/hook-latency-baseline.md` và không ghi đè file có sẵn khi thiếu `--force`. Thủ công, không nằm trong `run`. Hook chạy thật nên audit ghi session `latency-base`.
- Lưu ý: cổng bỏ từ `run` đầu tiên, nên CLI rỗng = `run`.

### Ca (`cases/<nhóm>.json`, mỗi file một mảng)
`{ id, desc, run, stdin, args, setup, env, expect }`
- `run.kind`: `hook` (`entry` tương đối hub, phải trong `harness/`) | `cli` (`args` cho `harness.mjs`) | `fn` (`module` tương đối `harness/` + `export`, tham số ở `args`, chạy qua `fn-runner.mjs` trong tiến trình riêng).
- `setup`: `files` {đường dẫn tương đối thư mục tạm: nội dung}, `audit` [sự kiện giả, `ago` = giây trước hiện tại, ghi `audit/date=D/type=T/claude-eval-sid.jsonl`], `cli` [mảng args chạy qua cổng trước].
- `expect`: `exit`, `decision` (ask|deny|block|inject|none — suy từ stdout theo schema hook Claude), `reason` (regex), `contains`/`notContains` (stdout), `value` (fn), `exists`/`missing` (đường dẫn trong thư mục tạm).
- Chuỗi có `{tmp}`, `{hub}`, `{today}` được thay khi chạy.

### Cô lập
Mỗi ca một thư mục tạm, xoá sau khi chạy; env trỏ tạm: `CLAUDE_AUDIT_DIR`, `HUB_CONFIG_DIR`, `HARNESS_CONFIG_DIR`, `HUB_DATA_DIR`, `HARNESS_KNOWLEDGE_ROOT`, `GUARD_LOG_FILE`, `HOME`/`USERPROFILE` (= `<tmp>/home`), `HUB_DIR` (= hub). Không ghi audit/vault thật.
Env tiến trình con KHÔNG kế thừa `process.env`: chỉ allowlist `ENV_ALLOW` (PATH, PATHEXT, SystemRoot, WINDIR, SYSTEMDRIVE, COMSPEC, TEMP/TMP/TMPDIR, BUN_INSTALL...) + biến tạm của ca + `env` của ca — loại `HARNESS_*`, `HOOK_*`, `CLAUDE_*`, HOME thật, `NODE_OPTIONS` để oracle tất định. `exists`/`missing` chỉ nhận đường dẫn trong thư mục tạm.

### Ghi chú
- `data/knowledge/evals/skills/` là kết quả eval skill của curator (cũ, khác mục đích), không dùng chung; eval này ghi `data/knowledge/eval/` (resolver, key `eval`).
- Ca chứa chuỗi bị guard chặn (vd. tên mongo shell) phải ghi bằng công cụ sửa file, không qua heredoc Bash.
- Tiến hoá KHÔNG tự sửa `cases/` (oracle) khi chưa có người duyệt.

## loop

Domain `evolve` (cổng `node harness/cli/harness.mjs evolve <lệnh>`). Tái dùng `core/audit` (scan, candidates, signature).

- `candidates`: lỗi cùng dấu vân tay (`error_fp`, không có thì chữ ký chuẩn hoá) >= 3 lần trong 7 ngày, toàn máy, từ `data/audit`.
- `propose <cid> [--kind skill|fact] [--target F]`: mặc định kind `skill`; ghi `data/knowledge/evolve/proposals/<pid>.json` kèm bằng chứng (fp, số lần, mẫu redacted) và nội dung sau (`change.after`).
- `check <pid>`: hiện evolve CHỈ đề xuất skill/fact (kind `rule`/`hook-config` đã bỏ) và allowlist không có đích trong `config/`, nên không còn gì để eval trên bản sao config: oracle luôn bỏ qua, ghi `oracle: skipped` + gắn `after_sha`. Mã oracle cũ (`runOracle`/`copyTree`/`parseScore`, `--eval-cmd`, `HARNESS_EVOLVE_EVAL_CMD`) đã xoá; oracle chỉ cần lại khi có đích config (hiện không còn) — khi đó viết lại, dùng `eval run --json --hub-config-dir <bản sao>` (cờ vẫn có ở `evolve eval`; tên cũ `eval` là alias của `evolve`, module `evolve/eval` là `kind: "lib"`).
- `apply <pid> --approve`: không tin file đề xuất: phân loại lại đích, sha(after)==after_sha, đích hiện tại==before_sha, TỰ chạy lại oracle trên đúng buffer sẽ ghi; snapshot `data/knowledge/evolve/versions/<ver>/` (before.bin + manifest.json, không lưu abs). `rollback <ver> --approve`: suy đích từ target đã chuẩn hoá + allowlist, kiểm sha snapshot, manifest có abs lệch -> từ chối. `log`, `list`.

Người duyệt thật là hộp duyệt của Claude Code (luật approval "ask" cho `evolve apply`/`evolve rollback`); `--approve` là điều kiện phụ. Không đặt niềm tin vào `proposals/`, `versions/` (agent ghi được).

Policy DENY-BY-DEFAULT. Đích được chuẩn hoá trước (`\` -> `/`, bỏ chấm/khoảng trắng cuối đoạn, so không phân biệt hoa thường; chặn `..`, tuyệt đối, `:`/ADS, tên thiết bị, 8.3 `~N`) và realpath (cả thư mục cha) phải nằm trong hub, khớp đích (bắt junction/symlink). Allowlist duy nhất: `harness/skills/<tên>/**.md` (skill), `data/memory/fact/*.md` (đích logic, vault thực ở `data/knowledge/memory`; fact, ghi qua `knowledge put`). Cấm tường minh (chỉ in hướng dẫn sửa tay, kể cả `--approve`): `harness/constrain|hooks|evolve/**`, `*bash-guard*`, `*/guard/*`, `config/{approval,verify-gate,guard,hub,knowledge}/**`, `.claude/**`, `.agents/**`, `.git/**`. Mẫu được redact (maskSecrets của core + Bearer/Basic, JWT, email) trước khi ghi evidence/nội dung đề xuất.
