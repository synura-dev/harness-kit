# build

Nhóm Build: sinh bản cho từng CLI (adapters claude, agy, sync) và build skill từ `harness/skills/`. Thiết kế: `docs/HARNESS-DESIGN.md` mục 4.
Mỗi extension ở `build/<tên>/manifest.json`. Đăng ký domain cổng: `kind: "cli"` + `domain` (bắt buộc); có `domains` thì đăng ký từng mục (bỏ qua `domain`).
Import: chỉ `core` và chính nhóm con của mình (`build:self`). `skills/` đọc như dữ liệu (fs), không import.

## install

Domain `install`: `node harness/cli/harness.mjs install [--dry-run] [--skip-doctor]`. Mac dinh chay (ghi); `--dry-run` chi bao.
Cac buoc: (1) kiem Node >= 18, bun (tuy chon); (2) `skills build --adopt` tu `harness/skills` sang `.claude/skills` + `.agents/skills`, roi `skills check`; (3) doctor rut gon (chi dong MISS/LOI/warn); (4) in huong dan dang ky hook (lam tay, KHONG sua settings.json/hooks.json).
Idempotent: chay lai thi build bo qua (hash khop). `--adopt` chi thay thu muc khong marker khi noi dung trung nguon; skill cai ngoai (skill-a, skill-b...) khong bao gio bi dung.
`install --shim [--dir D] [--dry-run] [--force]`: CHI cai shim `harness` cho shell cua user (bo qua cac buoc tren). Logic o `core/runtime/user-shim.mjs` (doctor dung chung de canh bao thieu/lech). Thu muc mac dinh: Windows `%APPDATA%\npm` neu co tren PATH user (HKCU), khong thi thu muc ghi duoc dau tien (bo WindowsApps); POSIX `~/.local/bin`. Shim = `node -e <js> -- args`, chon ban moi nhat (so sanh so) trong `<config>/plugins/cache/<mkt>/harness-kit/` luc chay. Dong `harness-kit user shim` danh dau file cua ta; file khong marker -> tu choi (exit 1) tru `--force`. Khong sua PATH; thu muc chua co tren PATH -> chi canh bao.
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
