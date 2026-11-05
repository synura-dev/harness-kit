# constrain

Nhóm Ràng buộc: chặn hành vi xấu và kiểm tất định. Module hiện có: guard (protectedPaths, dữ liệu harness), bash-guard (timeout), model-policy, proc-orphans, worktree. Chặn cứng (git push, reset --hard, migrate, deploy, ssh, force push, xóa đệ quy) giao lớp quyền native `ask`/`deny` của Claude Code, core không tự parse shell. Thiết kế: `docs/HARNESS-DESIGN.md` mục 4.
Mỗi extension ở `constrain/<tên>/manifest.json`. Đăng ký domain cổng: `kind: "cli"` + `domain` (bắt buộc); có `domains` thì đăng ký từng mục (bỏ qua `domain`). Hook dùng `kind: "hook"`, không thành domain.
Import: chỉ `core` và chính nhóm con của mình (`constrain:self`).
Mọi module được gọi qua dispatcher `harness/hooks/dispatch/` (bảng `modules.mjs`); không còn đăng ký trực tiếp từ settings.

## bash-guard

PreToolUse hook (matcher `Bash`). Fail-open: loi/parse hong -> `{}` va exit 0.

- Neu input thieu `timeout` va khong `run_in_background`: tra `updatedInput` them `timeout` = `default_timeout_ms` (mac dinh 120000, khong vuot `max_timeout_ms`).
- Chan (deny, kem huong dan) chi cac mau hep: `python -`/`python3 -` doc stdin, `python -c` nhieu dong, heredoc > `heredoc_max_lines` (3) dong.
- Cau hinh: `hook.config.json` (ghi de DEFAULTS), `hook.config.local.json`, env `BASH_GUARD_ENABLED`.
- Test: `bun test harness/constrain/bash-guard`.
- agy (adapters/agy.mjs, .agents/hooks.json, VERIFIED agy 1.4.3): chi deny (cung mau hep), fail-open in {"decision":"allow"}; KHONG gan timeout mac dinh vi agy khong ho tro updatedInput.
- core/agy/hints.mjs (agy-hints, dung chung voi audit/digest.mjs) (agy, deny kem ly do, cung fail-open; tat bang hook.config.json): `agy_replace` chan lenh DON (khong pipe/redirect/noi lenh) thay duoc bang tool: Get-Content/cat/type 1 file -> Read; Get-ChildItem -Recurse/dir /s/find -> Glob; Select-String/grep/findstr/rg -> Grep. `agy_repeat` (+ `agy_repeat_ttl_ms`, mac dinh 60000) chan lenh read-only giong het lenh vua chay trong cung conversation neu khong co ghi xen giua (write_file/edit_file/lenh khong read-only); chan 1 lan roi cho qua. Marker o `<audit root>/.agy_guard/`, log deny `denied.log` (digest dem `denied`). Digest in `agy bash ratio / replaceable / repeat / denied`.
- Su that da kiem (2.1.311): khi Bash het timeout, tool KHONG kill ma chuyen lenh xuong nen (xem TASKS.md Vong 9a).

## guard (PreToolUse, Bash|PowerShell)

Best-effort guard: blocks commands that read/operate on databases (mongo tools, connection strings, driver connects, db CLIs over ssh, unbounded remote `cat`, running `node|bun <file>` over ssh). Only the command TEXT is checked; it can be bypassed by obfuscation. Subagent enforcement is UNVERIFIED until a real run.

### Cac tang cau hinh (khong chua du lieu du an trong harness)
1. Loi chung: `hook.config.json` - moi luat Mongo/DB, allowlist `hub-local-node`; `remoteHostAliases` luon `[]`.
2. Goi du an (chi THEM luat moi; trung id luat loi = canh bao + bo qua, khong tat/ghi de duoc loi): `config/guard/<project>.json` (goc hub): `{"remoteHostAliases":[],"sensitiveFileNames":[],"denyPatterns":[{id,pattern,reason}]}` (cung nhan `allowlist`). Chon bang env `GUARD_PROJECT` hoac khoa `project` trong local; KHONG suy tu cwd. `sensitiveFileNames` sinh luat `config-dump` (chan cat/type/head... file do, va `.env`).
3. Local: `config/guard/guard.local.json` (goc hub, ignore; du lieu may, ngoai harness; fallback cu `hook.config.local.json` trong harness chi de chuyen tiep, canh bao `legacy-local-config`) (tuy chon, cao nhat; DUY NHAT duoc `disable`/ghi de luat loi; co the dat `"project": "<ten>"`).

#### protectedPaths (luat constrain/guard, id `protected-path`)
- Mac dinh RONG trong code (khong co duong dan nao bi bao ve). Them bang khoa `protectedPaths` (mang chuoi) trong config guard: local may (`guard.local.json`/`local.json`) hoac du an (`<du an>/.harness/config/guard/project.json`, `config/guard/projects/<id>.json`); cac lop HOP NHAT (chi them, khong tat duoc).
- Lenh Bash/PowerShell/run_command (va file_path cua Edit/Write/MultiEdit) nhac toi duong dan do -> deny. So khop khong phan biet hoa thuong, chuan hoa dau gach nguoc (ke ca gap doi) thanh `/` va dang `/e/...`, `/mnt/e/...`, `/cygdrive/e/...` thanh `e:/...`; co ranh gioi: `E:/Vault` khong khop `E:/Vault2`.
- Chuan hoa truoc khi so khop: chu thuong, bo backtick PowerShell, gach nguoc (ke ca gap doi) -> `/`, bo doan `/./`, gop `x/../`, bo dau cham va khoang trang cuoi moi thanh phan (`Vault.\a.md`, `E:\Notes\.\Vault`, `Va``ult` deu bi bat).
- Ngoai le: lenh DON co token dau DUNG `harness obsidian ...` (khong tien to duong dan: `./harness`, `.\harness`, `C:\...\harness` KHONG duoc mien) hoac `node "<bin harness cua plugin dang chay>" obsidian ...` (`harness/cli/harness.mjs` hoac `bin/harness.mjs` cua plugin). Co `; & | < >`, backtick, `$(`, `(`, `)`, `{`, `}` (subexpression/scriptblock PowerShell) hoac xuong dong thi khong duoc mien. Edit/Write khong co ngoai le.
- Config guard hong JSON: khong am tham thanh rong. Hook van fail-open nhung ghi canh bao `config-broken` (audit guard + stderr) va `harness doctor` bao `[ERROR]` + dong `[check] guard-config` ("config guard hong, protectedPaths mat hieu luc").
- Gioi han con lai (best-effort, luat chi la lop chan thu): (1) duong tuong doi qua `cd` roi dung ten tuong doi (`cd E:\Notes` roi `cat Vault\a.md`: chi lenh `cd` mang duong dan bi chan, lenh sau thi khong); (2) bien moi truong/bien shell (`$env:X`, `%X%`, `$V`); (3) ten 8.3 (`VAULT~1`) va symlink/junction; (4) Read/Grep/Glob khong di qua hook guard (chi Bash/PowerShell/run_command va Edit/Write/MultiEdit); (5) noi dung file doc tu script khac. Muon bao ve chac chan: quyen he dieu hanh/sandbox, khong chi guard.

Thu tu: loi < goi du an < local.

Hop nhat xac dinh: mang noi theo `id`, trung id thi lop sau thang, `"disable": true` tat ro rang (chi tang local tac dung len luat loi); khong lop nao xoa luat chung ngam. Goi thieu/hong/ten sai/khoa la -> van ap luat chung, ghi `config-warning` vao audit log, khong crash.

### Van hanh
- Rule: `denyPatterns[{id,regex|pattern,reason,remote?,unless?}]`, `allowlist[{regex,for:[ids]}]`. Them luat = 1 muc JSON + 1 dong trong TABLE cua `hook.test.mjs`.
- Mode: `"mode": "enforce" | "audit"` hoac env `GUARD_MODE=audit` (audit chi ghi `would-block`).
- Deny: `{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason}}`, exit 0.
- Fail-open: stdin hong/qua lon/loi/timeout 2.5s -> `{}` exit 0 (ghi `fail-open`). Lenh > maxCommandChars (100k) bi CHAN (`command-too-long`), khong cho qua.
- Log: JSONL `<audit root>/guard/guard-YYYY-MM-DD.jsonl`; override `logFile` / `GUARD_LOG_FILE`.
- Test: `timeout 60 node --test harness/constrain/guard/hook.test.mjs`
- `git-force-push` (luat loi): chan `git push` co --force/-f/--force-with-lease/--mirror/--delete/-d/--prune, +refspec, :branch, `git send-pack --force`; push thuong khong chan. Regex bounded (khong ReDoS): `git`..`push` <=12 tu, `push`..co <=40 tu (dem dai co the lot). KHONG bat: bien shell (`F=-f; git push $F`), xargs, alias ngoai `-c`, script sinh lenh. Chuoi nhac lenh trong echo/-m bi chan nham (uu tien khong bo lot). Hook chi la lop dau.

## model-policy (PreToolUse, Agent)

Ep chinh sach model cho subagent o cua goi `Agent`. Chi doc/ghi `tool_input` cua lenh goi; khong dung toi file du an.

| Tinh huong | Hanh vi |
|---|---|
| Thieu `model` | dien model theo vai tro (`subagent_type`; khong co -> `default`); `permissionDecision: allow` + `updatedInput` (chep DAY DU moi truong cu: prompt, description, subagent_type, effort...). Ghi gate `model-filled`. |
| `model=opus` ma vai tro khong `allowOpus` (va khong nam trong `opusAllowed`, model mac dinh cua vai tro khong phai opus) | `ask` kem ly do ngan ("vai tro X mac dinh sonnet"). Ghi gate `opus-not-allowed`. |
| Model re hon / khac hop le (haiku, sonnet, fable) | `{}` khong can thiep (ghi `model-pass` neu `logAllow`). |
| Loi, stdin hong, config hong, timeout (<= 2s) | `{}` fail-open, ghi gate `fail-open` / `config-warning`. |

### Cau hinh (du lieu)
Nguon chinh sach DUY NHAT: `config/models/default.json` (+ `local.json`, env `HARNESS_MODELS_<KEY>`; core `loadHookConfig`, tool `models`). Bang `roles`, `opusAllowed`, `allowOpus` chi nam o do.
`hook.config.json` chi giu khoa hanh vi + fallback an toan khi khong doc duoc `config/models`: `default{model:sonnet}`, khong co role, `opusAllowed` rong (khong role nao duoc opus).
Khoa trong `config/models`: `roles{<subagent_type>:{model,effort,allowOpus}}`, `default{model}`, `opusAllowed[]`. Khoa hanh vi (hook.config.json): `mode` (`enforce`|`audit`: audit chi ghi `would-*`), `logAllow`, `fillEffort` (true: dien `effort` cua vai tro khi lenh goi khong co; mac dinh false), `hardTimeoutMs`, `maxInputBytes`. Model chi nhan alias `sonnet|opus|haiku|fable`.

### Ghi vet
`core/audit/gate-event.mjs` `recordGate` kind `gate` -> `<audit>/date=D/type=gate/<sid>.jsonl`, `hook:"model-policy"`, `target` = vai tro. Khong ghi prompt.

### Dang ky
Them vao `.claude/settings.json` (PreToolUse, matcher `Agent`, timeout ngan):
`{"matcher":"Agent","hooks":[{"type":"command","command":"node \"$CLAUDE_PROJECT_DIR/harness/constrain/model-policy/hook.mjs\"","timeout":3}]}`

Test dung config tam (`HARNESS_CONFIG_DIR`/`configDir`) cho bang role; co 1 test doc config hub that.
Test: `bun test harness/constrain/model-policy`.

## worktree

Goc duy nhat tao/don git worktree (Claude hook + dispatch-worker cho claude/agy). Dung `harness/core/runtime/worktree.mjs`.

- `hook.mjs create` (WorktreeCreate): stdin `{name}`; tao `.worktrees/<name>`, nhanh `wt-<name>`, idempotent, copy cac duong dan literal trong `.worktreeinclude` (khong glob). stdout CHI duong dan tuyet doi; loi => exit 1 + stderr.
- `hook.mjs remove` (WorktreeRemove): `removeWorktreeAt` an toan (giu khi dirty/chua merge), luon exit 0. LUU Y: Claude KHONG goi hook nay o `claude -p` headless.
- `hook.mjs sweep` (SessionStart): `worktree prune --apply --min-age-hours 24` (clean + da merge + khong locked), fail-open. Day la duong don tu dong thuc te.
- Log: `data/system/worktree/hook.jsonl`. Config: `hook.config.json` (`enabled`, `minAgeHours`, `sweepTimeoutSec`); `enabled=false` chi tat remove/sweep.
- Dang ky trong `.claude/settings.json`: WorktreeCreate, WorktreeRemove, SessionStart(sweep).
- agy: khong co hook worktree; `dispatch-worker.mjs` tao truoc roi truyen cwd.

Khong co adapters/: claude native (hook.mjs); agy = `n/a` trong manifest (agy khong co event WorktreeCreate/WorktreeRemove; dispatch-worker tao worktree truoc).

## proc-orphans

Hook Stop/SubagentStop, CHI CANH BAO (khong block, khong kill, fail-open). Khi agent dung, ghi vao audit (type=proc, event=ProcOrphans) danh sach tien trinh con chau con song cua session claude.

### Gioi han (quan trong)
Payload Stop/SubagentStop KHONG co pid cua agent. Hook tim to tien claude.exe/agy gan nhat qua chuoi ppid cua chinh no roi liet ke moi con chau (bash/node/python/ping...) tuoi >= minAgeSec. Vi vay KHONG gan duoc tien trinh voi tung subagent: ban ghi la "con chau cua session luc agent dung".
Con chau dang chay hop le (vd lenh nen cua main) cung bi liet ke: day la tin hieu, khong phai ket luan.

### Chong bao gia / lap
- Subagent dang chay: SubagentStart/SubagentStop ghi `data/system/proc-orphans/live-agents.json` ({session_id: {agent_id: ts}}). Con agent KHAC cua cung session dang chay -> Stop/SubagentStop im, khong quet (con chau churn cua agent khong phai mo coi). Muc khong co SubagentStop het han sau `liveAgentTtlSec` (2h).
- Chong lap theo nguoi nhan (root pid + main/agent_id) trong `warned.json`: cung chu ky (tap pid) im `dedupeSec` (6h); chu ky khac im `throttleSec` (15 phut, chan pid churn khi khong theo doi duoc agent).
- Hai file tren la trang thai module nhu cache quet: ghi ca khi `ctx.write:false`, tat ghi bang `ctx.cache:false`. Loi -> fail-open (canh bao nhu cu).

### Cache quet
Danh sach tien trinh duoc cache 60s (`scanCacheTtlSec`, 0 = tat) o `data/system/proc-orphans/scan-cache.json`. Cache la trang thai rieng cua module, KHONG phai vet audit/gate: `ctx.write:false` (dispatcher goi) chi tat ghi audit, cache van duoc doc/ghi. Test co lap truyen `ctx.cache:false` (khong doc/ghi cache) hoac `ctx.env.HUB_DATA_DIR` tro thu muc tam.

### Cau hinh
`hook.config.json` (ghi de), `hook.config.local.json`, env `HOOK_PROC_ORPHANS_ENABLED`. Mac dinh trong `DEFAULTS` (hook.mjs): events, minAgeSec, watchNames, protectCmd, timeoutMs, maxListed, dedupeSec, throttleSec, liveAgentTtlSec.

### Test
`bun test harness/constrain/proc-orphans`


Khong co adapters/: claude native (hook.mjs); agy = `none` trong manifest (ap dung duoc nhung chua lam).

### Chi claude
Lý do `none` (không phải `n/a`): chưa làm cho agy; chưa kiểm agy có Stop/SubagentStop không.
