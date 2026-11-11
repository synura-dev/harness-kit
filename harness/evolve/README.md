# evolve

Nhóm Tiến hóa: phát hiện lặp, đề xuất, eval hồi quy, apply có version, rollback. Thiết kế: `docs/HARNESS-DESIGN.md` mục 4.
Mỗi extension ở `evolve/<tên>/manifest.json`. Đăng ký domain cổng: `kind: "cli"` + `domain` (bắt buộc); có `domains` thì đăng ký từng mục (bỏ qua `domain`).
Import: chỉ `core` và chính nhóm con của mình (`evolve:self`).

## eval

Oracle tất định cho chính harness: bộ eval hồi quy cố định để biết thay đổi harness tốt lên hay tệ đi. KHÔNG gọi LLM.

### Lệnh (qua cổng)
- `node harness/cli/harness.mjs eval run [--json]` — chạy mọi ca; exit 1 nếu có ca trượt hoặc ca hỏng schema.
- `eval list` — liệt kê ca. `eval baseline` — chạy + lưu `data/knowledge/eval/baseline.json` (data/ gitignore). Có ca trượt/lỗi ca thì KHÔNG ghi đè (không hạ chuẩn), exit 1; `--force` mới ghi — lệnh này bị approval hỏi người (`eval-baseline-force`).
- `--hub-config-dir D` (run/compare/baseline): mỗi ca chép `D` vào `<tmp>/config` riêng của ca rồi trỏ `HUB_CONFIG_DIR`/`HARNESS_CONFIG_DIR` vào đó — vẫn cô lập, gốc `D` không bị sửa. Evolve từng dùng cờ này; nay evolve không còn đích config nên không gọi nữa (cờ giữ cho đích config sau này). Không có cờ: `<tmp>/config` rỗng như cũ. JSON kết quả (và baseline) có `config: "default" | "<D tuyệt đối>"`.
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
Mỗi ca một thư mục tạm, xoá sau khi chạy; env trỏ tạm: `CLAUDE_AUDIT_DIR`, `HUB_CONFIG_DIR`, `HARNESS_CONFIG_DIR`, `HUB_DATA_DIR`, `GUARD_LOG_FILE`, `HOME`/`USERPROFILE` (= `<tmp>/home`), `HUB_DIR` (= hub). Không ghi audit/vault thật.
Env tiến trình con KHÔNG kế thừa `process.env`: chỉ allowlist `ENV_ALLOW` (PATH, PATHEXT, SystemRoot, WINDIR, SYSTEMDRIVE, COMSPEC, TEMP/TMP/TMPDIR, BUN_INSTALL...) + biến tạm của ca + `env` của ca — loại `HARNESS_*`, `HOOK_*`, `CLAUDE_*`, HOME thật, `NODE_OPTIONS` để oracle tất định. `exists`/`missing` chỉ nhận đường dẫn trong thư mục tạm.

### Ghi chú
- `data/knowledge/evals/skills/` là kết quả eval skill của skill-lifecycle (cũ, khác mục đích), không dùng chung; eval này ghi `data/knowledge/eval/` (resolver, key `eval`).
- Ca chứa chuỗi bị guard chặn (vd. tên mongo shell) phải ghi bằng công cụ sửa file, không qua heredoc Bash.
- Tiến hoá KHÔNG tự sửa `cases/` (oracle) khi chưa có người duyệt.

## loop

Domain `evolve` (cổng `node harness/cli/harness.mjs evolve <lệnh>`). Tái dùng `core/audit` (scan, candidates, signature).

- `candidates`: lỗi cùng dấu vân tay (`error_fp`, không có thì chữ ký chuẩn hoá) >= 3 lần trong 7 ngày, toàn máy, từ `data/audit`.
- `propose <cid> [--kind skill|rule|inject] [--target F]`: kind `skill` (mặc định, đề xuất cho người duyệt), `rule` (file luật cảnh báo JSON `evolve/rules/evolve-*.json`, mức 1 của autopilot) và `inject` (text `evolve/inject/*.md`, mức 2); kind `fact` đã bỏ cùng module knowledge; ghi `data/knowledge/evolve/proposals/<pid>.json` kèm bằng chứng (fp, số lần, mẫu redacted) và nội dung sau (`change.after`).
- `check <pid>`: evolve không còn đích trong `config/` (kind `hook-config` đã bỏ; `skill`/`rule`/`inject` ghi vào `evolve/`), nên không có gì để eval trên bản sao config: oracle luôn bỏ qua, ghi `oracle: skipped (khong co dich config de eval)`, `verdict: skipped` + gắn `after_sha`. CLI in nhãn `SKIPPED` (không phải `PASS`): chỉ qua kiểm policy/sha, chưa eval thật; exit 0 và `check.ok` vẫn true để `apply` (tự kiểm lại policy/sha/oracle trên buffer sẽ ghi) chạy được. Mã oracle cũ (`runOracle`/`copyTree`/`parseScore`, `--eval-cmd`, `HARNESS_EVOLVE_EVAL_CMD`) đã xoá; oracle chỉ cần lại khi có đích config (hiện không còn) — khi đó viết lại, dùng `eval run --json --hub-config-dir <bản sao>` (cờ vẫn có ở `evolve eval`; tên cũ `eval` là alias của `evolve`, module `evolve/eval` là `kind: "lib"`).
- `apply <pid> --approve`: không tin file đề xuất: phân loại lại đích, sha(after)==after_sha, đích hiện tại==before_sha, TỰ chạy lại oracle trên đúng buffer sẽ ghi; snapshot `data/knowledge/evolve/versions/<ver>/` (before.bin + manifest.json, không lưu abs). `rollback <ver> --approve`: suy đích từ target đã chuẩn hoá + allowlist, kiểm sha snapshot, manifest có abs lệch -> từ chối. `log`, `list`.

Người duyệt thật là hộp duyệt của Claude Code (luật approval "ask" cho `evolve apply`/`evolve rollback`); `--approve` là điều kiện phụ. Không đặt niềm tin vào `proposals/`, `versions/` (agent ghi được).

Policy DENY-BY-DEFAULT. Đích là đường dẫn LOGIC tương đối **gốc dữ liệu** (`dataDir`: `<dự án>/.harness/data` ở plugin mode, `<hub>/data`, hoặc `HUB_DATA_DIR`), không tương đối workspace — chạy như nhau ở dự án thường và hub. Đích được chuẩn hoá trước (`\` -> `/`, bỏ chấm/khoảng trắng cuối đoạn, so không phân biệt hoa thường; chặn `..`, tuyệt đối, `:`/ADS, tên thiết bị, 8.3 `~N`) và realpath (cả thư mục cha) phải nằm trong gốc dữ liệu, khớp đích (bắt junction/symlink); vị trí thật còn bị đối chiếu với workspace và plugin root (trong plugin root chỉ cho `data/`, `.harness/data/`). Allowlist: `<evolve>/rules/<tên>.json` (kind `rule`), `<evolve>/inject/<tên>.md` (kind `inject`) và `<evolve>/skills/<tên>/**.md` (skill ĐỀ XUẤT cho người duyệt, mặc định `evolve/skills/...` = cạnh `proposals/`; người tự chép sang `.claude/skills` nếu muốn — evolve KHÔNG tự ghi `.claude/skills`, `.agents/skills` hay `skills/` của plugin). Có thể đổi bằng config tool `evolve` (`skillsDir`, tương đối gốc dữ liệu). Cấm tường minh (chỉ in hướng dẫn sửa tay, kể cả `--approve`): `harness/constrain|hooks|evolve/**`, `*bash-guard*`, `*/guard/*`, `config/**`, `.claude/**`, `.agents/**`, `.git/**`, plugin root. Mẫu được redact (maskSecrets của core + Bearer/Basic, JWT, email) trước khi ghi evidence/nội dung đề xuất.

### Đo hiệu quả luật (effect)

Chỉ cho đề xuất `kind: rule` đã apply. `apply` chụp **baseline** ngay lúc ghi (cửa sổ 7 ngày trước, `proposal.applied_at` + `proposal.effect.baseline`; lỗi baseline không làm hỏng apply). Autopilot (tối đa 1 lần/24h) gọi `measureDue` (`loop/effect.mjs`) MỘT lượt đọc audit cho mọi luật đủ hạn (>= 7 ngày kể từ apply, chưa có verdict cuối): so **tỉ lệ lỗi của nhóm fp trên 1000 tool call** trước vs sau (cùng đơn vị, cùng độ dài cửa sổ 7 ngày).

- Verdict: `better` (sau <= 0.7 x trước), `worse` (>= 1.3 x và cửa sổ sau có >= 10 lỗi; thiếu lỗi thì `insufficient` lý do `low_after_errors`, đo lại, quá 21 ngày thành `inconclusive`), `unchanged` (giữa), `insufficient` (baseline < 10 lỗi, hoặc sau < 200 tool call, hoặc đọc audit bị cắt: đo lại lần sau; chỉ thêm dòng log khi verdict/lý do đổi), `inconclusive` (thiếu mẫu hoặc không có baseline quá 21 ngày kể từ apply: giữ luật, dừng đo; đọc audit bị cắt thì luôn giữ `insufficient`, không bao giờ rollback). Chỉ số phụ (tokens/phiên, correction/phiên tăng >= 30%) ghi vào `effect.side`, không quyết định.
- Hành động: `better`/`unchanged`/`inconclusive` -> giữ (`unchanged` là verdict cuối, không hành động); CHỈ `worse` mới `rollback`, và chỉ khi `autonomy >= 1` và luật do chính autopilot áp (có trong `state.applied`), mức 1 `evolve-*.json`, manifest khớp đề xuất; không dùng `--force` của autopilot để bỏ kiểm "đích bị sửa tay". Luật áp tay (`evolve apply --approve`) hoặc autonomy 0: chỉ ghi effect + `refused` kèm lý do để người quyết; mọi worse bị từ chối rollback còn được chú thích vào ledger ("rule <id> worse: consider evolve rollback <ver>"). fp bị rollback vì `worse` không được đề xuất lại trong 30 ngày (`EFFECT.excludeDays`). Rollback thất bại hoặc bị từ chối khi thử lại: ghi `effect.rollback_error`/`rollback_attempts`, thử lại ở lần chạy sau tối đa 3 lần rồi để người xử lý (có log). `insufficient` -> không làm gì. Luật mức 2 chỉ ghi effect.
- Phạm vi đo: mọi đề xuất `rule` đang `applied`, kể cả luật apply tay (chủ ý; chỉ ghi effect). Autopilot đọc audit MỘT lần mỗi lượt cho baseline các luật vừa áp (timeout đọc theo `query_timeout_ms` của audit-config, mặc định 30s; chưa có timeout riêng cho đường nền).
- Ghi: `proposal.effect` là nguồn sự thật (metric, baseline, after, verdict, reason, measured_at, action, side); mỗi lần đo thêm một dòng `op: "effect"` vào `applied.jsonl` (`evolve log`); `evolve list` có cột `verdict=`. `--dry-run` chỉ báo sẽ làm gì, không ghi/rollback.
- Thay cho cơ chế cũ (so count cửa sổ 30 ngày với 7 ngày: lệch đơn vị, gần như không bao giờ rollback).

### Kind `fix` (chỉ hàng đợi, không tự ghi file)

- `propose <cid> --kind fix --fix-target <area>:<path>` (area: hook|script|brief|doc|config): đề xuất sửa quy trình; `change.target: null`, không ghi file, có `target_metric.baseline_value`. Autopilot xếp vào review-queue (mức 2), không bao giờ auto-apply.
- `apply <pid> --approve --manual-done`: người đã sửa tay xong; chỉ đổi status sang applied để bắt đầu đo. Thiếu `--manual-done` -> từ chối. `measureDue` đo mọi đề xuất applied có `target_metric` (không chỉ rule), ghi verdict vào proposal, không rollback (rollback tự động vẫn chỉ cho rule do autopilot áp).

### Demote (tự hạ cấp rule vô ích)

`demote.mjs`, gọi từ ledger job sau autopilot (guard 24h, tối đa 10 rule/lần, timeout 10s). Rule `evolve-*.json` trong 14 ngày warned >= 5 mà ignored >= 50% (acted 0): do autopilot áp -> rollback; áp tay -> chỉ log `demote_suggested`. Bỏ qua rule protected, mặc định plugin, `<project>/.harness/rules`.

### Retro tuần

`evolve retro [--apply] [--json] [--current]`: báo cáo tuần `<dataDir>/retro/<week>.json|.md` (KPI, trend, selfdev, top-3 vấn đề có `key` ổn định, bảng hiệu quả thay đổi). Mặc định xem tuần VỪA XONG; `--current` xem tuần đang chạy (không append series).
- Tự động: ledger job gọi `retroAuto` 1 lần/isoWeek; marker `retro/<week>.auto.json` chỉ ghi khi chạy xong không lỗi/timeout (lỗi -> job sau thử lại). `--apply` tự bật qua config evolve `retro.autoApply` (mặc định true; `false` thì chỉ ghi báo cáo).
- `--apply` tạo task qua `projects add-task` (+ `knowledge add` báo cáo). Trần/tuần: 3 task vấn đề + 1 P0; dedupe qua `retro/emitted.json` (vấn đề đã `resolved` được phát lại; mục > 90 ngày bị dọn). Runner lỗi/timeout: báo cáo vẫn ghi, key không vào emitted. Hết `timeoutS` (30) -> `truncated: 'timeout'`.
- Series `retro/series.jsonl`: append-only, 1 dòng/tuần (cùng tuần `rev+1`), đọc tối đa 200 dòng/2 MB; `trend` có spark, slope, vs_prev_pct, vs_baseline_pct, direction (flat khi |slope| < 5% trung bình).
- Selfdev (`better` = hướng tốt): self_initiated_rate up, time_to_fix_h down, time_to_verify_h down, effective_rate up, rollback_rate down, repeat_correction_rate down, repeat_errors_resolved up, repeat_files down. Mẫu 0 -> null.
- F3 tự kiểm: tổng hợp `improving|flat|worse`; `flat|worse` 2 tuần liền -> task `[P0] self-improvement stalled: ...` (tối đa 1/tuần).
