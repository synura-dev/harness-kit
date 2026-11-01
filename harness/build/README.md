# build

Nhóm Build: sinh bản cho từng CLI (adapters claude, agy, sync) và build skill từ `harness/skills/`. Thiết kế: `docs/HARNESS-DESIGN.md` mục 4.
Mỗi extension ở `build/<tên>/manifest.json`. Đăng ký domain cổng: `kind: "cli"` + `domain` (bắt buộc); có `domains` thì đăng ký từng mục (bỏ qua `domain`).
Import: chỉ `core` và chính nhóm con của mình (`build:self`). `skills/` đọc như dữ liệu (fs), không import.

## install

Domain `install`: `node harness/cli/harness.mjs install [--dry-run] [--skip-doctor]`. Mac dinh chay (ghi); `--dry-run` chi bao.
Cac buoc: (1) kiem Node >= 18, bun (tuy chon); (2) `skills build --adopt` tu `harness/skills` sang `.claude/skills` + `.agents/skills`, roi `skills check`; (3) doctor rut gon (chi dong MISS/LOI/warn); (4) in huong dan dang ky hook (lam tay, KHONG sua settings.json/hooks.json).
Idempotent: chay lai thi build bo qua (hash khop). `--adopt` chi thay thu muc khong marker khi noi dung trung nguon; skill cai ngoai (skill-a, skill-b...) khong bao gio bi dung.
`install --shim [--dir D] [--dry-run] [--force]`: CHI cai shim `harness` cho shell cua user (bo qua cac buoc tren); ban tay cua hook `user-shim` duoi, cung logic `core/runtime/user-shim.mjs` `syncUserShim` (doctor dung `shimStatus`).

## user-shim (hook SessionStart)

Moi phien: dam bao lenh `harness` dung duoc tu PowerShell/cmd/bash cua user. MOT thu muc co dinh cho ca may: Windows `%LOCALAPPDATA%\harness-kit\bin` (`harness.cmd` + `harness` cho Git Bash), POSIX `~/.local/bin`.
- Shim = `node -e <js> -- args`, chon ban moi nhat (so sanh so) trong `<config>/plugins/cache/<mkt>/harness-kit/` luc chay; nang cap plugin khong can ghi lai.
- PATH user: thieu thi noi vao cuoi mot lan. Windows: `reg add HKCU\Environment /v Path /t REG_EXPAND_SZ` (giu `%VAR%`, khong setx vi cat 1024 ky tu) roi phat WM_SETTINGCHANGE; POSIX: mot dong co marker trong `~/.profile` (macOS `~/.zprofile`). Doc PATH user loi -> khong ghi, chi bao.
- Xoa shim CUA TA (co dong `harness-kit user shim`) o thu muc khac tren PATH va `%APPDATA%\npm` (cho cu) -> chi mot ban tren may.
- File khong marker cung ten -> khong ghi de, bao `harness install --shim --force`. Chay tu nguon (khong co cache plugin) -> bo qua. Duoi `bun test` (NODE_ENV=test) khong tiem IO -> bo qua (test dispatcher khong dung may that).
- Chi bao (additionalContext, mot dong) khi co thay doi/loi; on dinh thi im lang (chi doc file; doc registry chi khi thu muc chua tren PATH tien trinh). Fail-open, timeout 15s.
- Tat: `HOOK_USER_SHIM_ENABLED=0` hoac `hook.config.local.json {"enabled": false}`. Import: hooks duoc import `build` (contract IMPORT_RULES) chi de nap module nay.
Exit 1 khi co buoc LOI.

## skills

Domain `skills`: `build | check | prune` (`node harness/cli/harness.mjs skills <lenh>`).
- Nguon: `harness/skills/<ten>/` (`SKILL.md` bat buoc); `harness/skills/shared/` chua doan dung chung, nhung bang `{{include shared/<file>}}` (chi `.md`/`.txt`, mot cap) luc build.
- Dich mac dinh: `.claude/skills/<ten>`, `.agents/skills/<ten>` (doi bang `--target D`, lap lai duoc; nguon `--src D`). Copy, khong symlink; moi skill sinh ra co `.generated.json` {source, hash sha256 noi dung da render, builtAt}.
- `build`: mac dinh dry-run, `--apply` moi ghi; hash khop -> bo qua (idempotent); ban sinh bi sua tay -> tu choi tru `--force`; trung ten skill khong marker -> tu choi.
- `check`: bao `unbuilt`, `drift` (nguon doi), `edited` (sua tay), `conflict` (trung ten skill khong marker), `orphan`, `invalid`; exit 1 khi co lech.
- `prune`: chi thu muc dich CO `.generated.json` HOP LE ma nguon khong con; mac dinh dry-run, `--apply` moi xoa; orphan bi sua tay (hash lech) chi xoa khi them `--force`. Skill khong marker (lane installed) khong bao gio bi dung.
- Marker hop le = JSON co `hash` sha256, `source` tro dung `<src>/<ten>`, `generator` (neu co) = `harness/build/skills`. Marker hong/cua cong cu khac -> `badmarker`: build/prune khong dung, chi canh bao.
- Ghi nguyen tu: render vao `.<ten>.build-*` cung cha roi rename; rename loi (EPERM Windows, thu lai 5 lan) -> giu ban cu.
- Gioi han: `--timeout-s` (mac dinh 60s, ap cho ca build/check/prune, het han bao `truncated: timeout`), 200 file/skill, 1MB/file, do sau 8, 100 thu muc/skill; `--json`, `--raw`, `--max-bytes`.
