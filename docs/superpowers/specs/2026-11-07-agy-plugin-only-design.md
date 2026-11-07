# harness-kit tool-neutral: Claude va agy cai doc lap, chi chung du lieu - Design

Task: harness-kit-0062. Ngay: 2026-11-07 (ban 2, them nguyen tac doc lap). Trang thai: DRAFT, cho nguoi dung duyet cau hoi mo (muc 8).

## 1. Muc tieu va nguyen tac

Plugin harness-kit khong gan voi tool nao. Voi agy (Antigravity CLI) buoc cai DUY NHAT la `agy plugin install <goc plugin>`; sau do hook chay, guard/bash-guard chan, audit ghi (cli=agy), agent goi duoc CLI `harness`, du quyen, khong lenh them, khong sua settings. Mien CLI `harness agy` bi xoa.

**Nguyen tac doc lap (nguoi dung, 2026-11-07):** harness cai rieng cho Claude va rieng cho agy. Khong ben nao phu thuoc ben kia: may/workspace chi co agy KHONG can config/plugin Claude; phia Claude KHONG quan ly agy. Hai ben chi hop tac qua DU LIEU dung chung cua harness (audit, knowledge, projects/tasks, data root). He qua: code tren duong agy khong doc `.claude/*`, khong goi `agy` tu phia Claude, shim `harness` khong tro vao thu muc cai cua tool khac co the vang.

Khong-muc-tieu: doi hanh vi Claude; tu dong cap nhat ban cai agy khi plugin Claude doi (agy-sync bi bo, xem 8.2); sua `~/.gemini/**` tu bat ky ma nao cua plugin.

## 2. Hien trang (da doc trong repo E:\06. Projects\harness-kit; khong co AGENTS.md/CLAUDE.md rieng)

Xac nhan (file:dong):
- Mien CLI agy: `harness/cli/manifest.json:16-21` (+ helpers :31, tests :41); `harness/cli/commands/agy.mjs` (`native()` kiem cai/version/enabled/ban clone/hooks cu :21-47; `legacyHooksWarn` :50-54; `rules --apply` ghi `permissions.allow ["command(harness)"]` vao `~/.gemini/antigravity-cli/settings.json` :12,56-84); test `commands/agy.test.mjs`.
- `doctor.mjs:55-64` kiem `.agents/hooks.json` (walkAgyHooks, findBadHookCommands) va goi `legacyHooksWarn` tu `./agy.mjs` (:60): dong 60 vo khi xoa agy.mjs.
- agy-sync (phia Claude quan ly agy - vi pham nguyen tac): `harness/build/agy-sync/*`, dang ky `hooks/dispatch/modules.mjs:26,33,46`, `run.mjs:28`.
- Adapter cong cu: `harness/tools/adapters/agy.mjs` (+ `tools/agy.test.mjs`, `tools/adapters/manifest.json`, `dev/adapters-report-core.mjs:12`, `dev/sync.mjs:77`, `core/config/constants.mjs:222-223`).
- Cong workspace: `hooks/dispatch/agy-native.mjs:29-39` (`enabledIn` doc `.claude/settings*.json` - vi pham nguyen tac), dung o `:46` va `commands/agy.mjs:9,40`. agy-native.mjs:47 dat env `CLAUDE_PROJECT_DIR` = ws (ten bien noi bo dung chung de suy workspace/data root; khong phai doc thu muc Claude).
- Lop adapter can GIU: `.antigravity-plugin/plugin.json`, `hooks.json` goc, `dispatch/agy.mjs`, `core/io/agy-payload.mjs`, `constrain/bash-guard/adapters/agy.mjs`, `core/agy/*`, `observe/audit/adapters/agy*.mjs`, nhanh agy `constrain/guard/hook.mjs:246-285`, `core/io/paths.mjs:109-150` (walkAgyHooks, findBadHookCommands - doctor dung). Luu y: `core/agy/agents.mjs:15` doc `.claude/agents` (nguon vai tro cho dev/sync + core/ext/ctx.mjs) - KHONG nam tren duong hook agy; loai khoi test trung tinh (muc 3.6).
- `bin/harness` (+ `.cmd`): launcher CLI cua plugin (Claude dua `bin/` vao PATH Bash tool). agy khong co co che nay.
- Shim user-shell: `core/runtime/user-shim.mjs` - thu muc co dinh Windows `%USERPROFILE%\.harness-kit\bin` (`:55-58`; `%LOCALAPPDATA%\harness-kit\bin` la ban CU, chi migrate `:61-66`; ghi chu cho main: lenh giao noi LOCALAPPDATA la duong cu), POSIX `~/.local/bin`. `pluginCacheDir` (`:24-32`) chi biet cache Claude (`~/.claude/plugins/cache/<mkt>/harness-kit`); shim sinh ra (`:35-52`) quet cache chon ban moi nhat, hoac (khi khong co cache) tro co dinh `<pluginRoot>/bin/harness`. Hook `build/user-shim/hook.mjs:29` thoat im lang neu `pluginCacheDir` null -> agy-only khong co shim; nguoc lai neu may co ca hai, shim tu agy se tro vao cache Claude (co the vang). `SESSION_AGY` (`dispatch/agy.mjs:73-86`) da goi user-shim nhung bi cong do.
- Du lieu chung: ca hai duong dua workspace -> `applyWorkspaceEnv(env, ws)` (`core/io/paths.mjs`); agy dung `auditRoot()` (`core/audit/audit-write.mjs`) tai `dispatch/agy.mjs:16`. Audit hien KHONG co truong version/schema du lieu (grep `schema_version|data_version|harness_version` trong `observe/audit/*.mjs` = rong).
- Doc agy 1.5 (`~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/plugins.md`, `hooks.md`): plugin native = `plugin.json` / `.antigravity-plugin/plugin.json`; `hooks.json` BAT BUOC o goc; them `rules/AGENTS.md`, `mcp_config.json`; **plugin.json KHONG co truong permissions/settings/PATH**. PreToolUse ho tro `decision: allow|deny|ask|force_ask`, `permissionOverrides: ["command(<prefix>)"]`, `overwrite: {CommandLine: ...}`. SessionStart ho tro `injectSteps`. Plugin mac dinh enabled.

Chua xac nhan (spike T0, khong gia dinh):
- `decision:"allow"` co qua lop permission `command(...)` o `agy -p` khong; `permissionOverrides`/`overwrite` co hieu luc o 1.5.2 (memory cu: 1.4.3 chan `updatedInput`); quyen xet tren lenh goc hay da viet lai; shell cua `run_command` tren Windows; co cach co lap HOME agy.
- `workspacePaths[0]` khi `agy -p` o thu muc khong co `.claude/` `.agents/`; thu muc cai plugin agy co on dinh (`~/.gemini/config/plugins/harness-kit`) qua cac lan `agy plugin install`; hook agy co ghi duoc `~/.harness-kit/bin` + HKCU Path (user-shim) trong tien trinh hook.
- Hanh vi khi `~/.claude` hoan toan vang (may agy-only).

## 3. Thiet ke

### 3.1 `harness` goi duoc + du quyen (chon theo bang chung T0)
- A. Hook PreToolUse (module moi `agy-harness`, chay SAU guard/bash-guard) cho lenh doc an toan cua `harness`: `{"decision":"allow","permissionOverrides":["command(harness)"]}` (A1); neu `harness` khong tren PATH (phien agy dau, PATH user chua nap shim) them `overwrite.CommandLine` = `node "<goc plugin>/harness/cli/harness.mjs" <argv>` (A2; dung `harness.mjs` truc tiep, khong qua `bin/`, de khong phu thuoc launcher). Goc plugin = suy tu vi tri file hook.
- B. SessionStart `injectSteps.systemMessage`: noi cach goi (lenh tuyet doi) + gioi han; fallback neu A2 khong dung duoc; kem tuy chon `rules/AGENTS.md`.
- C. Shim user-shell tool-neutral (3.5): phuc vu shell nguoi dung va phien agy tu thu hai tro di; KHONG la co che chinh cho phien dau.
Quy tac "lenh doc an toan" (ham thuan, TDD): `harness` + domain/lenh trong allowlist chi-doc (rut tu `harness/cli/manifest.json` + code lenh, KHONG doan), tu choi ky tu shell (`| & ; > < ` $( ) \n`), tu choi lenh ghi/nguy hiem (`ext register|approve|remove`, `install`, `data adopt`, moi `--apply|--force|--yes`). Khong khop = KHONG can thiep (quyen agy tu quyet), khong phai deny. Guard deny luon thang.

### 3.2 Cong workspace thay `enabledIn` (khong doc `.claude/*`)
`agy-native.mjs`: `isEnabled(ws)`:
- Mac dinh BAT khi plugin da cai.
- Tat CHI bang cong tac cua harness: env `HARNESS_AGY=0`; file `<ws>/.harness/agy.off`; (tuy chon, thong nhat 8.1) mot khoa tool-neutral `agy.enabled=false` trong config workspace cua harness neu config do da co duong doc san - khong tao he config moi. TUYET DOI khong doc `.claude/*` (kiem bang test grep 3.6; khoa `harness-kit@synura` trong `.claude/settings` KHONG con hieu luc voi agy).
- Khong bat (an toan) khi ws khong ton tai / khong phai thu muc / trung HOME / goc o dia / trung goc plugin; fail-open im lang.
- Claude khong doi: gate chi o agy-native.

### 3.3 Doctor
- Xoa mien `agy`; doctor kiem tool-neutral: schema `.agents/hooks.json` (giu `walkAgyHooks`/`findBadHookCommands`), MOT dong `[warn]` gop di san cu (khoa `harness-kit` trong `.agents/hooks.json`, `.agents/harness-agy-shim.mjs`, `.agents/harness-agy.local.json`, `.agents/plugins/harness-kit` clone) + lenh sua bang tay; `legacyHooksWarn` chuyen sang `core/agy/legacy.mjs` (thuan, test). Khong tu xoa.
- Bo kiem ban cai/version/enabled cua agy (quan ly cai dat tool = ngoai pham vi; doctor phia Claude khong goi `agy`).
- Them: canh bao lech phien ban/schema du lieu giua hai CLI (3.7) va trang thai shim (`roots.json`, 3.5).

### 3.4 Go bo
`commands/agy.mjs`(+test), mien trong manifest, `build/agy-sync/*` + dang ky, `tools/adapters/agy.mjs`(+test, manifest, dev refs, constants), tai lieu agy cu (README.md:26, hooks/README.md:28, CHANGELOG "Removed").

### 3.5 Shim `harness` tool-neutral (moi)
Muc tieu: tool nao khoi dong truoc cung dam bao shim ton tai va tro vao ban cai HOP LE, khong tro vao thu muc cai cua tool kia.
- Shim sinh ra THONG NHAT (noi dung khong phu thuoc tool). Ben canh shim co `roots.json` (`<shimDir>/roots.json`): `{ "claude": "<thu muc cache chua cac ban>" | null, "agy": "<goc plugin agy>" | null }`. Luc chay shim doc `roots.json`, voi moi root con ton tai va co `harness/cli/harness.mjs` (Claude: quet cac ban con trong cache) chon ban co version cao nhat; root vang bi bo qua; khong con root nao -> thong bao ro (exit 3, cach sua = mo lai tool do hoac `agy plugin install`). Shim goi `node <root>/harness/cli/harness.mjs` (khong qua `bin/`).
- Moi hook SessionStart (Claude `build/user-shim`, agy `SESSION_AGY`) goi `syncUserShim({ tool, pluginRoot })`: chi cap nhat KHOA CUA MINH trong `roots.json`, ghi shim neu thieu/cu (nhan dien qua SHIM_MARK), dam bao PATH user (nhu hien tai), don khoa cua chinh minh neu tro vao duong da vang. Khong bao gio xoa khoa cua tool kia.
- Tach `pluginCacheDir` (chua `.claude`) sang file chi-Claude `build/user-shim/claude-cache.mjs`; `core/runtime/user-shim.mjs` nhan `roots` truu tuong, khong cham `.claude`. `tool` do ben goi truyen (hook Claude: 'claude'; SESSION_AGY: 'agy'); chay tu nguon/khong biet tool -> bo qua nhu cu.
- Phien agy DAU (PATH chua nap): A2 overwrite hoac injectSteps; quyet theo T0 (E3 + S3). Khong bat buoc dung ca hai.
- Tat: `HOOK_USER_SHIM_ENABLED=0` (giu).

### 3.6 Du lieu chung va kiem tra trung tinh
- Ca hai duong phai ra CUNG data root cho mot workspace (audit/knowledge/projects). Test ham thuan: cung `ws`, env tu agy-native va env tu dispatcher Claude -> `auditRoot()` + data dir bang nhau (neu lech: sua nguon lech, bao main).
- Test trung tinh (grep): cac file tren duong agy (`hooks/dispatch/agy-native.mjs`, `agy.mjs`, `agy-harness.mjs`, `core/io/agy-payload.mjs`, `constrain/bash-guard/adapters/agy.mjs`, `observe/audit/adapters/agy*.mjs` khong tinh `.test.`, `core/runtime/user-shim.mjs`, `core/agy/legacy.mjs`) khong co chuoi `.claude` (ke ca comment). Loai: `core/agy/agents.mjs` (nguon vai tro Claude cho dev). Ten env `CLAUDE_PROJECT_DIR`/`CLAUDE_AUDIT_DIR` KHONG bi cam (khong phai thu muc); doi ten la viec rieng (8.6).

### 3.7 Lech phien ban/schema du lieu giua hai CLI (moi)
Cache plugin Claude va thu muc agy co the o hai ban harness, cung ghi mot data root. Repo CHUA co version/schema du lieu.
- Them hang `DATA_SCHEMA = 1` + file stamp `<dataRoot>/.harness-writers.json` `{ "claude": {version, schema, at}, "agy": {...} }`; moi CLI cap nhat khoa cua minh luc SessionStart (ham ghi chung `core/io/data-stamp.mjs`, ben goi truyen tool + version lay tu manifest cua chinh no). Vi tri chinh xac la quyet dinh cua builder (chua kiem).
- Doctor: khoa cua tool KIA co `schema` > schema nay hoac `version` > version nay -> MOT dong `[warn]` (schema moi: nang cap ban nay; version moi: nen cap nhat); khong chan, khong tu ghi.
- Tuong thich nguoc: chi them truong, doc bo qua truong la; khong doi/xoa truong dang co. Test: dong audit co truong la van doc/query duoc.

## 4. Cac tang cap (file phai sua)
- Hook/runtime: `hooks/dispatch/agy-native.mjs` (+test), `hooks/dispatch/agy.mjs` (+test), module moi `hooks/dispatch/agy-harness.mjs` (+test), `modules.mjs`, `run.mjs`.
- Shim: `core/runtime/user-shim.mjs` (+test), `build/user-shim/hook.mjs` (+test), `build/user-shim/claude-cache.mjs` moi, `build/user-shim/manifest.json`.
- Du lieu chung: `core/io/data-stamp.mjs` moi (+test); test moi `hooks/dispatch/data-root-parity.test.mjs`; diem goi stamp trong SessionStart cua hai duong.
- CLI/doctor: `cli/manifest.json`, `cli/commands/doctor.mjs` (+test), `core/agy/legacy.mjs` moi (+test), `core/registry/plugin-registry.test.mjs:37`.
- Tool adapters/dev: `tools/adapters/*`, `dev/adapters-report-core.mjs` (+test), `dev/sync.mjs` (+test), `core/config/constants.mjs`.
- Goi plugin: `hooks.json`, hai `plugin.json` (version), tuy chon `rules/AGENTS.md`. Test trung tinh moi `hooks/dispatch/agy-neutral.test.mjs`.
- Tai lieu: README.md, hooks README, dispatch README, constrain/build/observe README, CHANGELOG.
- Repo CHUA co: AGENTS.md/CLAUDE.md rieng, migration, CI, version/schema du lieu; test = `bun:test` canh nguon (`*.test.mjs`).

## 5. Rui ro bat buoc
- Kiem quyen phia server (o day = phia hook): guard/bash-guard chay truoc va deny bat chap allow; allowlist chi-doc la ham thuan co test am; khong khop thi khong can thiep; PreToolUse loi in `allow` nhu cu (khong doi).
- Thao tac len chinh minh: allow KHONG gom `harness ext register/approve`, `install`, `data adopt`, lenh sua cau hinh/hook, hay duong sua `~/.gemini/**`; guard bao ve file nhay cam van ap dung cho agy. `overwrite` chi cho lenh da phan loai safe, argv da qua kiem tra (tranh injection).
- Du lieu nhay cam khong vao log/audit: `lastUserInput`, args tool, noi dung settings/token agy khong ghi vao audit/HKERR/stamp/roots.json/bao cao; stamp chi co cli, version, schema, thoi gian.
- Default-on: moi workspace agy mo ghi `.harness/data` + `.gitignore`; giam bang dieu kien an toan 3.2 + opt-out; ghi ro README.
- Shim: `roots.json` + HKCU Path la trang thai CUA NGUOI DUNG; shim khong duoc tro root vang (3.5); shim cu (tro cache Claude, khong roots.json) bi hook ghi de nho SHIM_MARK, khong dung file la. Acceptance sao luu/khoi phuc `~/.harness-kit/bin`.
- Lech phien ban/schema (3.7): ban cu va ban moi cung ghi mot data root -> giam bang tuong thich nguoc (chi them truong), stamp + canh bao doctor; khong chan phien.
- Spike/acceptance dung ban cai GLOBAL cua agy: sao luu/khoi phuc hoac HOME co lap (S0); khong `--dangerously-skip-permissions`.
- Mat tu dong cap nhat (agy-sync): nguoi dung chay lai `agy plugin install`; ghi README/CHANGELOG.
- Xoa mien CLI `agy`: breaking, bump minor (0.4.0), CHANGELOG "Removed".

## 6. Rollback
Moi Task = nhanh worktree rieng, commit local, main merge tung Task. Truoc merge dau main tag `pre-agy-plugin-only`. Hoan tac = `git revert -m 1 <merge>` tung Task (hoac reset nhanh ve tag neu chua push) roi `agy plugin install <goc plugin ban cu>`. Shim/roots.json/stamp: file them, xoa bang tay duoc; shim cu van chay vi sinh tu ban cu; khoi phuc `~/.harness-kit/bin` tu ban sao luu S0/T7.

## 7. Tieu chi chap nhan
(1) Cai sach `agy plugin install` vao workspace khong co `.claude/` `.agents/`, voi Claude plugin gia dinh vang (`CLAUDE_CONFIG_DIR` tro thu muc rong, KHONG go plugin that): `agy -p` chay lenh `harness` doc khong hoi quyen, hook ban, guard chan lenh nguy hiem, mot dong audit `cli=agy`; shim ton tai, `roots.json` chi co khoa agy tro goc ton tai. (2) Cung workspace, mot phien Claude + mot phien agy: hai dong audit (`cli=claude`, `cli=agy`) trong MOT store, `harness observe usage` thay ca hai. (3) `harness agy` bao domain khong ton tai; `harness doctor` khong `[LOI]`, co canh bao di san neu con; test trung tinh grep xanh.

## 8. Cau hoi mo / gia dinh can nguoi dung quyet
1. Cong workspace: mac dinh BAT; opt-out `HARNESS_AGY=0` | `<ws>/.harness/agy.off` (| khoa config harness neu da co duong doc)? Khong co khoa `.claude`. Khoa theo workspace, khong IP/key/user, khong gioi han tan suat.
2. Bo agy-sync: cap nhat agy = chay lai `agy plugin install`; chap nhan?
3. Allowlist `harness` tu cho phep: chi-doc theo manifest; rong/chat hon?
4. Acceptance dung ban cai global agy + `~/.harness-kit/bin` that, co sao luu/khoi phuc; hay doi cach co lap (S0)?
5. Version 0.4.0 hay 0.3.13?
6. Doi ten env noi bo `CLAUDE_PROJECT_DIR`/`CLAUDE_AUDIT_DIR` sang `HARNESS_*` (alias, giu cu)? Mac dinh: de nguyen, ngoai pham vi.
7. Stamp lech: canh bao khi version KIA moi hon (chi so) hay chi khi schema moi hon? Mac dinh: ca hai, mot dong gop.
Gia dinh chua kiem: agy 1.5.2 ho tro `permissionOverrides`/`overwrite` o `-p` (T0 S1); `claude -p --plugin-dir <P>` chay duoc trong workspace tam cho T7 (nguoi dung xac nhan lenh/ngan sach); `harness observe usage` ton tai (neu khong dung `observe query`).
