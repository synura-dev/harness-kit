# harness-kit tool-neutral: agy chi can `agy plugin install` - Implementation Plan

> SDD: moi Task mot `builder` (Sonnet, worktree rieng trong repo, maxTurns 40), tru Task 0 (spike thuc, builder co `agy`) va Task 7 (acceptance thuc). Buoc dung `- [ ]`. Test: `bun:test`, file `.test.mjs` canh nguon; lenh hep `timeout 120 bun test <file>`. Comment trong repo: tieng Viet khong dau; no ghi `shortcut:`. Khong push. Commit khong co-author Claude. Spec: `docs/superpowers/specs/2026-11-07-agy-plugin-only-design.md`.
> Repo CHUA co AGENTS.md/CLAUDE.md rieng, CI, migration. Plan nay KHONG bao gio chay full suite giua chung; full suite dung MOT lan o Task 7 (nen, timeout, log ra file).

**Muc tieu:** agy chi can `agy plugin install <goc plugin>`; xoa mien `harness agy`, agy-sync, adapter cong cu agy; thay cong workspace `.claude/settings` bang cong tool-neutral; `harness` goi duoc va du quyen trong agy khong sua settings.

**Nguyen tac doc lap (2026-11-07):** Claude va agy cai DOC LAP; khong ben nao can config/plugin cua ben kia, phia Claude khong quan ly agy; hai ben chi chung DU LIEU harness (audit, knowledge, projects/tasks, data root). Moi Task phai giu: duong agy khong doc `.claude/*`; shim khong tro vao thu muc cai cua tool kia; format du lieu tuong thich nguoc (chi them truong).

**Nguoi dung da duyet 2026-11-07:** (1) gate mac dinh bat, opt-out chi `HARNESS_AGY=0` | `<ws>/.harness/agy.off`; (2) bo agy-sync, cap nhat = chay lai `agy plugin install`; (3) allowlist CHAT: chi lenh doc (doctor, data ls/stat/scan, observe usage/report, knowledge search/get/fact, projects list/get/tasks), tu choi ky tu shell, `--apply`, `--yes`, `--force`, `ext approve`, `install`; (4) T0/T7 duoc dung ban cai agy global + `~/.harness-kit` that CO sao luu/khoi phuc; (5) version 0.4.0; (6) KHONG them khoa config trung tinh (bo test T1(e)); (7) giu ten env `CLAUDE_*` (ngoai pham vi); (8) doctor canh bao lech ca version va schema, gop mot dong. Rollback: tag `pre-agy-plugin-only`.

## Do thi phu thuoc va song song

```
Nhom A (song song, file roi nhau): T0 spike | T1 gate | T3 xoa mien agy + doctor | T4 xoa agy-sync
Nhom B: T2 allow/goi harness (sau T0)   T5 xoa adapter cong cu (sau T2)   T8 shim tool-neutral (sau T0, T2)
        T9 stamp du lieu + parity + canh bao doctor (sau T3)
Nhom C: T6 docs/version (sau T1-T5, T8, T9)  ->  T7 acceptance that (cuoi)
Thu tu merge: T3 truoc T1 (agy.mjs import enabledIn tu agy-native); T2 truoc T8 (T8 chi them tham so tool o 1 dong SESSION_AGY); T3 truoc T9 (doctor); con lai tuy y.
```
Tap file (doc quyen ghi): T8 = `core/runtime/user-shim.*`, `build/user-shim/*` (hook.mjs, hook.test.mjs, claude-cache.mjs moi, manifest.json), + DUNG MOT dong goi user-shim trong `SESSION_AGY` o `hooks/dispatch/agy.mjs` (sau khi T2 merge); T9 = `core/io/data-stamp.*` (moi), `hooks/dispatch/data-root-parity.test.mjs` (moi), `hooks/dispatch/agy-neutral.test.mjs` (moi), them mot khoi canh bao vao `cli/commands/doctor.mjs` + `doctor.test.mjs` (sau T3), diem goi stamp trong SessionStart (module Claude + SESSION_AGY: builder chon diem chung de it file nhat, ghi lai); T1 = `hooks/dispatch/agy-native.*`; T2 = `hooks/dispatch/agy.mjs`, `agy.test.mjs`, `agy-harness.*`(moi), `rules/AGENTS.md`(moi, tuy ket qua T0); T3 = `cli/manifest.json`, `cli/commands/{agy.mjs,agy.test.mjs,doctor.mjs,doctor.test.mjs}`, `core/agy/legacy.*`(moi), `core/registry/plugin-registry.test.mjs`; T4 = `build/agy-sync/*`, `hooks/dispatch/{modules.mjs,run.mjs}` + test dispatch lien quan (`unit.test.mjs`, `run.test.mjs`); T5 = `tools/adapters/*`, `tools/agy.test.mjs`, `dev/adapters-report-core.mjs`, `dev/adapters-report.test.mjs`, `dev/sync.mjs`, `dev/sync.test.mjs`, `core/config/constants.mjs`; T6 = README/CHANGELOG/plugin.json x2. (T4 va T2 cung ten thu muc `hooks/dispatch/` nhung khac file; neu T4 thay phai sua `agy.mjs` -> dung va bao main.)

---

### Task 0: Spike thuc S0/S1/S2 (KHONG sua repo; builder co `agy`, lam truoc T2)
Muc dich: tra loi bang bang chung cac cau mo cua spec muc 2 "Chua xac nhan". Tat ca trong thu muc tam (scratchpad) - KHONG ghi vao repo, KHONG chep `~/.gemini/antigravity-cli/settings.json`/token vao bao cao.
Files: khong (chi ban sao plugin trong scratchpad). Ket qua: main chep vao muc "Ket qua T0" cuoi file nay (commit local truoc khi dispatch T2).
- [ ] S0 co lap: `agy --help`, `agy plugin install --help`, `agy plugin list --json` (version agy). Tim co che cai sach khong dung ban that: bien/tuy chon HOME agy (grep help; thu `USERPROFILE`/`HOME` tro thu muc tam co chep dung file auth neu can - KHONG in noi dung). Neu khong co: sao luu `~/.gemini/config/plugins/harness-kit` (+ muc `plugins.harness-kit` trong config.json agy) ra scratchpad, cach khoi phuc ghi trong bao cao. Ghi chon cach nao.
- [ ] Dung ban sao plugin trong scratchpad (`git clone` repo -> `P`; ws tam `W` chi co README.md; KHONG co `.claude/`, `.agents/`). Sua tam `P/hooks.json` de goi script thu (khong sua repo): script in ra file `W/../probe.jsonl` payload da cat (chi cac truong key, khong `lastUserInput`), va tra cac bien the dau ra PreToolUse theo bien moi truong `PROBE=<mode>`.
- [ ] S1 permission matrix (`agy -p ... --output-format json`, khong `--dangerously-skip-permissions`, ws sach, settings agy KHONG co `command(harness)`), moi o ghi: lenh co chay khong / bi hoi / bi deny + thong bao:
  E1 `harness doctor` (chua co tren PATH phien nay neu shim chua them) voi hook tra `{"decision":"allow"}`;
  E2 nhu E1 + `permissionOverrides:["command(harness)"]`;
  E3 hook tra `allow` + `overwrite:{CommandLine:"node \"<P>/bin/harness\" doctor"}` (quote dung shell cua agy; ghi shell nao: cmd/PowerShell/sh);
  E4 lenh pipe `harness doctor | head -3` voi allow/overrides (xem co bi deny);
  E5 lenh bat ky (`node --version`) voi chi `allow` (de biet allow co bypass lop permission hay khong);
  E6 hook tra `deny` cho `git push --force origin main` (xem agent nhan reason, lenh khong chay).
  Ghi quyen duoc xet tren lenh goc hay da viet lai (E3 voi lenh goc `harness doctor` + overrides chi cho `node`).
- [ ] S2 workspace + hook: voi ws sach va gate hien tai (`enabledIn`) xac nhan (a) khong co dong probe (gate chan im lang); sau do voi gate bi bo (probe truc tiep) (b) `workspacePaths[0]` dung la ws, hook cwd = goc plugin cai (`~/.gemini/config/plugins/harness-kit` hay thu muc khac), (c) SessionStart `injectSteps.systemMessage` co hien cho agent khong (hoi agent "lenh harness goi the nao?"), (d) `rules/AGENTS.md` trong plugin co duoc agent thay khong (them file thu vao ban sao), (e) hook `Stop`/`PostInvocation` ban o `-p`.
- [ ] S3 shim/duong goi cho agy-only (bang chung cho T8; KHONG ghi `~/.harness-kit` that, chi doc code hoac dung thu muc tam): (a) thu muc cai plugin agy sau `agy plugin install` la gi va co on dinh khi cai lai (co doi theo version khong); (b) tien trinh hook agy ghi duoc thu muc nguoi dung (`%USERPROFILE%\.harness-kit\bin`) va HKCU Path khong; (c) phien `agy -p` ngay sau SessionStart co thay PATH moi khong (du doan: khong) - xac nhan; (d) E3 overwrite `node "<P>/harness/cli/harness.mjs" ...` chay dung trong shell agy; (e) `CLAUDE_CONFIG_DIR` tro thu muc rong -> hook agy van chay (duong agy khong doc `.claude`). Cay quyet dinh T8: (c)=khong va E3 chay -> T2 co A2 (overwrite) cho phien dau, shim cho phien sau + shell nguoi dung; (b)=khong ghi duoc -> bao main (khong quay lai doc `.claude`).
- Done-when (do duoc): bang E1-E6 day du (co/khong chay, shell, thong bao ngan), muc S0 co cach co lap + cach khoi phuc da kiem (sau do `agy plugin list --json` khop trang thai ban dau), S2 a-e moi y co dap an; bao <= 40 dong. Cay quyet dinh cho T2:
  * E2 chay HOAC E1 chay -> T2 = A1 (allow [+ permissionOverrides]), khong overwrite;
  * chi E3 chay (harness khong tren PATH) -> A2 (overwrite tuyet doi) + A1;
  * khong E1/E2/E3 nao chay -> T2 = B (injectSteps + rules) va dung quyen = nguoi dung chap nhan hoi quyen: DUNG, bao main (can quyet dinh nguoi dung, khong tu them ghi settings);
  * E4 chay du la pipe -> allowlist van TU CHOI pipe (khong an theo).
  Dung moi tien trinh nen/`agy` con treo truoc bao cao; khoi phuc ban cai that.
- Commit: khong (khong co file repo).

### Task 1: Cong workspace tool-neutral (TDD) [song song T0/T3/T4]
Files: `harness/hooks/dispatch/agy-native.mjs`, `harness/hooks/dispatch/agy-native.test.mjs`.
- [x] Doc test hien co (`agy-native.test.mjs`, 15 cho agy) de biet fixture `enabledIn`.
- [x] Test DO truoc cho `isEnabled(ws, {env, home})` (ham thuan, tiem env/home): (a) ws sach, khong `.claude`, khong opt-out -> true; (b) `env.HARNESS_AGY==='0'` -> false; (c) co `<ws>/.harness/agy.off` -> false; (d) KHONG doc `.claude/*`: ws co `.claude/settings.local.json` voi `"harness-kit@synura": false` -> VAN true (khoa cu khong con hieu luc) va test spy fs: khong co lan `readFileSync`/`existsSync` nao toi duong chua `.claude` trong `isEnabled`/`run`; (e) tuy chon (chi neu 8.1 duoc duyet va config workspace cua harness da co ham doc san): khoa tool-neutral `agy.enabled=false` -> false, hong/BOM -> true khong nem; (f) ws khong ton tai, la file, trung `home`, goc o dia (`path.parse(ws).root===ws`) -> false; (g) ws trung goc plugin (`root`) -> false; (h) `run()` voi ws sach: dispatch chay (stdout tu agy.mjs) thay vi `fallback` im lang; voi `agy.off`: `{stdout: fallback, stderr: ''}`; voi payload thieu workspacePaths: nhu cu (fail-open im lang).
- [x] Code: thay `enabledIn` bang `isEnabled`; `run()` dung `isEnabled(ws)` thay cong cu; cap nhat comment dau file (bo "cong theo du an qua .claude"). KHONG con doc `.claude/settings*` ngoai viec doc khoa `=== false`. Giu `workspaceOf`, `fallback`, ma loi HKERR.
- [x] Chay: `timeout 120 bun test harness/hooks/dispatch/agy-native.test.mjs` -> tat ca xanh, test moi do truoc khi code (RED roi GREEN, ghi output).
- Done: grep `enabledPlugins` trong `harness/hooks/dispatch/agy-native.mjs` chi con vung doc khoa false; test (a)-(h) xanh.
- [x] Commit: `agy-native: cong workspace mac dinh bat, opt-out tool-neutral`.

### Task 2: `harness` goi duoc + du quyen trong agy (TDD) [sau T0]
Files: `harness/hooks/dispatch/agy-harness.mjs` (moi, ham thuan), `agy-harness.test.mjs` (moi), `harness/hooks/dispatch/agy.mjs` (+ `agy.test.mjs`), `rules/AGENTS.md` (moi, CHI neu T0 S2d xac nhan agy nap va co ich), `harness/hooks/dispatch/manifest.json` (helpers/tests them 2 file).
Phu thuoc: "Ket qua T0" da chep vao plan.
- [x] Test DO truoc `classifyHarnessCommand(cmd, {allow})` -> `{kind:'safe'|'unsafe'|'none', argv}`: safe cho `harness doctor`, `harness observe query ...` (cac lenh doc trong allowlist do builder rut tu `cli/manifest.json` + code lenh, ghi nguon trong comment); `none` cho lenh khong phai harness (`git status`); `unsafe` cho: co `| & ; > < \` $( ) \n` (ke ca sau `harness doctor`), `harness ext approve|register|remove`, `harness install`, `harness data adopt`, bat ky `--apply|--force|--yes`, `harness` tran voi domain la, `harness` khong doi so, chuoi `harness.cmd`/`./harness` gia mao, dau `;`/`&&` noi them lenh. unsafe -> khong can thiep (khong deny; agy tu quyet) NHUNG ghi ly do cho audit gate.
- [x] Test DO truoc cho module/dau ra: Pre `run_command` `harness doctor` -> `{decision:'allow'[, permissionOverrides:['command(harness)']][, overwrite:{CommandLine:'node "<root>/bin/harness" doctor'}]}` dung theo nhanh T0 da chon (them test cho nhanh A1 HOAC A1+A2, khong code ca hai neu T0 loai); guard deny (vd `git push --force`) van thang (module allow chay SAU guard/bash-guard, khong de len deny); `harness doctor | head` -> khong overrides, khong overwrite; `renderAgy` khong lam mat `permissionOverrides/overwrite` khi allow, ask van thanh deny nhu cu (test cu khong sua).
- [x] Neu T0 chon B: SESSION_AGY (hoac module moi) tra `{injectSteps:[{systemMessage:{systemMessage:<cach goi harness, <=400 ky tu, khong lo duong dan nguoi dung ngoai goc plugin>}}]}` va `renderAgy` cho SessionStart cho qua `injectSteps` (hien tai tra `{}` cho moi su kien khac Pre, `agy.mjs:104-106`); test dau ra.
- [x] Code toi thieu: `agy-harness.mjs` (thuan); noi vao `AGY_ORDER.PreToolUse` sau GUARD_AGY va BASH_GUARD_AGY (gate, bi cat khi deny) truoc AUDIT_AGY; mo rong `renderAgy`. Khong dong vao `guard/hook.mjs`.
- [x] Chay: `timeout 120 bun test harness/hooks/dispatch/agy-harness.test.mjs harness/hooks/dispatch/agy.test.mjs harness/hooks/dispatch/agy-destructive.test.mjs` -> xanh; test moi do roi xanh (ghi RED roi GREEN).
- Done: ba file test xanh; test am (pipe/ext approve/--apply/ky tu shell) xanh; diff khong sua `constrain/guard/*`.
- [x] Commit: `agy: tu cho phep lenh harness chi-doc, goi duoc khong can PATH/settings`.

### Task 3: Xoa mien `harness agy` + doctor tool-neutral (TDD phan legacy) [song song, merge TRUOC T1]
Files: `harness/cli/manifest.json` (xoa :16-21, helper :31, test :41), `harness/cli/commands/agy.mjs` va `agy.test.mjs` (xoa), `harness/core/agy/legacy.mjs` + `legacy.test.mjs` (moi), `harness/cli/commands/doctor.mjs` (:55-64), `harness/cli/commands/doctor.test.mjs`, `harness/core/registry/plugin-registry.test.mjs:37` (bo "agy" khoi danh sach domain).
- [x] Test DO truoc `legacyFindings(dir)` -> mang chuoi (ham thuan, fixture thu muc tam): khoa `"harness-kit"` trong `.agents/hooks.json`; file `.agents/harness-agy-shim.mjs`; `.agents/harness-agy.local.json`; thu muc `.agents/plugins/harness-kit`; sach -> []. `legacySummary(dir)` -> MOT chuoi `[warn] ...` gop + huong dan xoa tay (khong tu xoa), hoac null.
- [x] Code `legacy.mjs` (chuyen y tu `legacyHooksWarn` + phan clone o agy.mjs:42-45); doctor goi `legacySummary` thay `import('./agy.mjs')`; giu `walkAgyHooks`/`findBadHookCommands` (paths.mjs khong sua). Test doctor: fixture co di san -> dung 1 dong `[warn]` di san, exit code khong doi (warn khong thanh MISS); fixture sach -> khong dong nao.
- [x] Xoa mien + file + sua test registry. Grep `commands/agy`, `agy.mjs'` (khong tinh `dispatch/agy.mjs`, `adapters/agy.mjs`) = rong.
- [x] Chay: `timeout 120 bun test harness/core/agy/legacy.test.mjs harness/cli/commands/doctor.test.mjs harness/core/registry/plugin-registry.test.mjs harness/cli/commands/adapters.test.mjs`; thu tay: `node harness/cli/harness.mjs agy` -> bao domain khong ton tai (exit != 0); `node harness/cli/harness.mjs doctor` khong crash (import dong loi cu da het).
- Done: cac test tren xanh; tay: hai lenh nhu tren dung ket qua.
- [x] Commit: `cli: xoa mien agy, doctor canh bao di san agy gop mot dong`.

### Task 4: Xoa agy-sync [song song]
Files: `harness/build/agy-sync/` (xoa ca thu muc: hook.mjs, hook.test.mjs, hook.config.json, manifest.json), `harness/hooks/dispatch/modules.mjs` (:26 AGY_SYNC, :33 OPTIONAL, :46 SessionStart), `harness/hooks/dispatch/run.mjs:28` (MAINTENANCE_MODULES), cac test dispatch con nhac `agy-sync` (grep: `unit.test.mjs`, `run.test.mjs`, ghi lai trong bao cao danh sach thuc te).
- [x] Grep `agy-sync|AGY_SYNC|HARNESS_AGY_AUTOSYNC` toan repo (bo docs/) lam danh sach; sua cac test dung `OPTIONAL`/`MAINTENANCE_MODULES` (them test: SessionStart ORDER khong con 'agy-sync'; OPTIONAL khong chua).
- [x] Xoa + sua. Khong dong vao ten tien trinh `agy plugin install` o noi khac (se het vi hook bi xoa).
- [x] Chay: `timeout 120 bun test harness/hooks/dispatch/unit.test.mjs harness/hooks/dispatch/run.test.mjs harness/hooks/dispatch/agy.test.mjs`; grep lai = rong (tru CHANGELOG).
- Done: test xanh; `node harness/hooks/dispatch/run.mjs SessionStart < /dev/null` (hoac payload rong) in JSON hop le, khong spawn `agy` (khong co tien trinh `agy` con).
- [x] Commit: `build: xoa hook agy-sync (agy chi cai bang agy plugin install)`.

### Task 5: Xoa adapter cong cu agy + tham chieu dev [sau T2]
Files: `harness/tools/adapters/agy.mjs`, `harness/tools/agy.test.mjs` (xoa), `harness/tools/adapters/manifest.json`, `harness/tools/adapters/_util.mjs`/`claude.mjs` (chi neu nhac agy), `dev/adapters-report-core.mjs:12`, `dev/adapters-report.test.mjs`, `dev/sync.mjs` (:77 vong ten adapter; GIU `core/agy/agents.mjs` lien quan roles :32-44 neu con dung), `dev/sync.test.mjs`, `harness/core/config/constants.mjs` (:222-223; them `rules` vao allowlist thu muc goc NEU T2 them `rules/AGENTS.md` va `dev/checks/clutter-check` dang chan).
- [x] Truoc khi xoa: doc `dev/sync.mjs:60-90` + `adapters-report-core.mjs` de xem adapter list duoc nap the nao (manifest/cau hinh). Ghi: xoa ten `agy` khoi vong lap, KHONG lam hong adapter `claude`.
- [x] Xoa + sua; `harness/core/agy/*` va `checkAgentFile` (neu dev dung) -> neu `dev/sync.mjs` can ham trong adapter da xoa, di chuyen sang `core/agy/` (tach helper truoc) thay vi xoa chuc nang role-doi-ung.
- [x] Chay: `timeout 120 bun test dev/adapters-report.test.mjs dev/sync.test.mjs harness/core/agy dev/checks/clutter-check.test.mjs`; `timeout 60 node dev/sync.mjs --help` (hoac lenh kiem cua sync, khong ghi) khong loi.
- Done: test xanh; grep `tools/adapters/agy` = rong ngoai CHANGELOG.
- [x] Commit: `tools: xoa adapter dong bo agy (plugin native thay the)`.

### Task 8: Shim `harness` tool-neutral (TDD) [sau T0 S3 va T2]
Files: `harness/core/runtime/user-shim.mjs` + `user-shim.test.mjs`, `harness/build/user-shim/hook.mjs` + `hook.test.mjs`, `harness/build/user-shim/claude-cache.mjs` (moi, chi-Claude, chua `pluginCacheDir`), `harness/build/user-shim/manifest.json` (helpers), mot dong trong `SESSION_AGY` (`hooks/dispatch/agy.mjs`, chi sau khi T2 da merge). Spec 3.5.
- [x] Doc `user-shim.mjs` (:24-70 `pluginCacheDir`, `renderShims`, `syncUserShim`) + `hook.mjs:29`; chot theo "Ket qua T0 S3" cach agy phan phoi (khong doan).
- [x] Test DO truoc (thu muc tam, tiem `home`/`env`/`shimDir`, khong cham `~/.harness-kit` that): (a) `syncUserShim({tool:'agy', pluginRoot:R})` voi R ton tai (co `harness/cli/harness.mjs`) khi KHONG co cache Claude va khong `.claude` -> ghi shim + `roots.json` chi khoa `agy`; (b) tool 'claude' them khoa `claude` KHONG xoa khoa `agy` con ton tai; (c) khoa tro duong da vang -> chinh tool do don khoa cua minh; khoa tool kia vang thi shim chay BO QUA no va dung khoa con lai; (d) ca hai root vang -> shim in thong bao + exit 3, khong crash; (e) hai root con: chon version cao nhat; (f) shim cu (co SHIM_MARK, khong roots.json) bi ghi de, file la (khong SHIM_MARK) KHONG bi ghi de; (g) `HOOK_USER_SHIM_ENABLED=0` -> khong ghi; (h) `renderShims`/`core/runtime/user-shim.mjs` khong chua chuoi `.claude` (grep trong test); (i) hook Claude van chay nhu cu qua `claude-cache.mjs` (test hien co khong sua nghia).
- [x] Code toi thieu theo spec 3.5 (dong SESSION_AGY: main giao sau T2); `SESSION_AGY` truyen `tool:'agy'` + `pluginRoot` suy tu vi tri file hook (khong tu `.claude`). Khong cham PATH cua may nguoi dung trong test.
- [x] Chay: `timeout 120 bun test harness/core/runtime/user-shim.test.mjs harness/build/user-shim/hook.test.mjs harness/hooks/dispatch/agy.test.mjs` -> xanh; RED roi GREEN ghi output.
- Done: test (a)-(i) xanh; grep `\.claude` trong `core/runtime/user-shim.mjs` = rong; shim sinh ra o thu muc tam chay duoc `node <shim> doctor` (hoac tro dung root) va in loi ro khi root vang.
- [x] Commit: `shim: tool-neutral, roots.json, moi CLI tu dam bao shim cua minh`.

### Task 9: Stamp du lieu chung + parity + canh bao lech ban (TDD) [sau T3]
Files: `harness/core/io/data-stamp.mjs` + `data-stamp.test.mjs` (moi), `harness/hooks/dispatch/data-root-parity.test.mjs` (moi), `harness/hooks/dispatch/agy-neutral.test.mjs` (moi), `harness/cli/commands/doctor.mjs` + `doctor.test.mjs` (them khoi canh bao), diem goi stamp trong SessionStart (builder chon: module/diem chung nho nhat, ghi lai). Spec 3.6, 3.7.
- [x] Test DO truoc `data-stamp`: `writeStamp(dataRoot,{tool,version,schema,now})` tao/cap nhat CHI khoa cua tool, giu khoa kia + truong la; `readStamps` chiu file hong/vang (tra {}); `compareStamps(self, stamps)` -> canh bao khi tool kia co `schema`>self hoac version>self (so sanh semver so, khong chuoi), khong canh bao khi bang/cu hon; stamp khong chua `lastUserInput`/args (kiem keys).
- [x] Test DO truoc doctor: fixture dataRoot co stamp `agy` version cao hon -> dung 1 dong `[warn]`, exit code khong doi; khong stamp -> khong dong nao.
- [x] Test DO truoc `data-root-parity`: cung `ws` thu muc tam, env dung bang `agy-native` (applyWorkspaceEnv) va bang duong Claude dispatcher -> data dir va `auditRoot()` BANG nhau; neu lech, sua nguon lech (toi thieu) va ghi vao bao cao.
- [x] Test DO truoc `agy-neutral` (grep): cac file duong agy (liet ke o spec 3.6; loai `core/agy/agents.mjs`, test files) khong chua `.claude`; kem test khang dinh them mot dong audit co truong la van doc/query duoc (tuong thich nguoc, dung ham doc audit hien co).
- [x] Code toi thieu; khong sua format dong audit hien co (chi them truong neu can). Chay: `timeout 120 bun test harness/core/io/data-stamp.test.mjs harness/hooks/dispatch/data-root-parity.test.mjs harness/hooks/dispatch/agy-neutral.test.mjs harness/cli/commands/doctor.test.mjs` -> xanh (RED roi GREEN).
- Done: 4 file test xanh; grep trung tinh xanh; stamp tren thu muc tam chi co cli/version/schema/at.
- [x] Commit: `data: stamp ban ghi du lieu theo CLI + doctor canh bao lech ban + test trung tinh/parity`.

### Task 6: Tai lieu + version [sau T1-T5, T8, T9]
Files: `README.md` (:26 viet lai: "agy: `agy plugin install <goc plugin>`, het"; muc cai gate/opt-out `HARNESS_AGY=0`, `.harness/agy.off`; cap nhat = chay lai lenh; muc cau truc), `harness/hooks/README.md:28`, `harness/hooks/dispatch/README.md`, `harness/constrain/README.md`, `harness/build/README.md`, `harness/observe/README.md` (chi sua cau lien quan cai dat/ cong; khong sua ket luan ky thuat), `CHANGELOG.md` (Added/Changed/Removed/Migration), `.claude-plugin/plugin.json` + `.antigravity-plugin/plugin.json` (cung version, theo cau hoi 5).
- [x] Grep `harness agy`, `agy-sync`, `enabledPlugins`, `HARNESS_AGY_AUTOSYNC`, `agy init`, `agy rules` trong *.md (bo docs/superpowers + docs/plans/zero-setup.md ban lich su) = rong.
- [x] Chay: `timeout 120 bun test dev/checks` (ref-check/link) neu co kiem tai lieu; hai plugin.json cung version (`node -e` doc 2 file, in ==).
- Done: grep rong; hai version bang nhau; test dev/checks xanh.
- [x] Commit: `docs: agy chi can agy plugin install; changelog + version`.

### Task 7: Acceptance cai sach THAT + rollback drill (builder co `agy`; sau khi main merge T1-T6)
Chay tren HEAD da merge (khong trong worktree: cai tu goc repo plugin da merge, hoac tu `git clone` HEAD vao scratchpad `P`). Ghi trang thai ban dau theo S0.
- [ ] Chuan bi: thu muc tam `W` (README.md) KHONG co `.claude/`, `.agents/`, khong co `command(harness)` trong settings agy (kiem + ghi KHONG in noi dung); dung cach co lap/khoi phuc cua S0.
- [ ] `agy plugin install "<P>"` (lenh duy nhat), `agy plugin list --json` thay harness-kit enabled.
- [ ] `cd W && timeout 300 agy -p "Chay: harness doctor. Roi chay: git push --force origin main. Bao ket qua tung lenh." --output-format json --log-file <log>` (khong `--dangerously-skip-permissions`, khong `--settings` them quyen).
- [ ] Kiem (bang chung, dan trich output):
  1. lenh `harness doctor` chay xong (co dong `[OK] node`), khong hoi quyen;
  2. hook ban: `<W>/.harness/data/` co file audit/gate moi tao boi lan chay (hoac `--log-file` co dong hook); khong co `HKERR` trong stderr/log;
  3. guard chan lenh nguy hiem: ket qua tool la deny voi ly do `guard[...]` (lenh khong chay; `git push` that khong xay ra);
  4. audit: tim dong `cli=agy` trong du lieu audit cua `W` (`node "<P>/bin/harness" observe query --raw` voi `CLAUDE_PROJECT_DIR=W`, hoac doc file jsonl trong `W/.harness/data`), it nhat SessionStart/Pre/Post cua phien do; khong chua `lastUserInput` nguyen van;
  5. `node "<P>/bin/harness" agy` -> loi domain khong ton tai; `node "<P>/bin/harness" doctor` -> khong `[LOI]`;
  6. opt-out: tao `W/.harness/agy.off` roi `agy -p "echo hi"` -> khong co dong audit moi (so dong truoc/sau bang nhau); xoa file sau.
  7. DOC LAP: chay muc 1-4 trong workspace KHONG co `.claude/` (W da vay) va voi plugin Claude "gia dinh vang": dat `CLAUDE_CONFIG_DIR` (va `HOME/USERPROFILE` neu S0 cho phep) tro mot thu muc RONG cho phien agy; KHONG go plugin Claude that. Ket qua phai nhu muc 1-4 (hook ban, guard chan, audit cli=agy). Them: `W/.claude` va thu muc cai Claude khong bi tao/ghi (liet ke truoc/sau); `roots.json` chi co khoa `agy` tro goc ton tai; `harness` chay duoc tu shim moi (terminal moi hoac goi truc tiep shim) VA tu phien agy dau (A2/injectSteps theo T0); grep trung tinh (`bun test harness/hooks/dispatch/agy-neutral.test.mjs`) xanh tren HEAD.
  8. DU LIEU CHUNG: trong CUNG `W`, chay mot phien Claude (`claude -p "<lenh doc nho>" --plugin-dir "<P>"`, nguoi dung/main duyet lenh + ngan sach `--max-budget-usd` truoc; neu khong chay duoc thi giu `harness hooks`/payload Claude mo phong qua dispatcher that `node "<P>/harness/hooks/dispatch/run.mjs"` voi `CLAUDE_PROJECT_DIR=W` va ghi ro la mo phong) va mot phien agy. Chung minh: hai dong audit `cli=claude` va `cli=agy` cung nam trong MOT store (`W/.harness/data`, cung duong), `CLAUDE_PROJECT_DIR=W node "<P>/harness/cli/harness.mjs" observe usage` liet ke ca hai (neu lenh `observe usage` khong ton tai o ban nay thi dung `observe query` va ghi), va stamp `.harness-writers.json` co hai khoa; doctor khong canh bao khi hai ban bang nhau, co dung 1 dong `[warn]` khi gia lap stamp kia moi hon (chi trong ban sao tam cua W).
- [ ] Full suite DUNG MOT LAN (nen, timeout 600, log file): `timeout 600 bun test > <log> 2>&1`; bao ket qua pass/fail (so sanh voi baseline cua nhanh chua doi neu fail la tu truoc, chi bao).
- [ ] Rollback drill: `agy plugin install "<goc ban truoc>"` (tag `pre-agy-plugin-only`) -> `agy plugin list --json` version cu; khoi phuc trang thai ban dau theo S0; kiem khong con tien trinh `agy`/`node` mo coi.
- Done-when: 6 muc 1-6 deu co bang chung; full suite xanh hoac loi da biet ngoai pham vi (nen); rollback drill OK; bao cao <= 40 dong. Khong khoi phuc duoc = bao main ngay, khong tu sua `~/.gemini/**` ngoai ban sao luu da lap.
- Commit: khong (ket qua ghi vao bao cao; main tick plan).

---
## Quy tac cho moi builder
- TDD bat buoc cho T1, T2, T3 (legacy): RED (chung minh test do khi tam hoan tac/chua code) roi GREEN; chi test hep.
- Khong doc/chep noi dung settings/token agy; payload agy chi ghi truong key vao ket qua spike.
- Moi tien trinh nen/`agy` do minh bat phai dung truoc bao cao cuoi.

## Ket qua T0
(2026-11-07, agy 1.5.2; da khoi phuc: `agy plugin list --json` byte-identical, config.json cmp identical)
- Shell cua run_command = PowerShell 5.1 (khong co `head`; dung `Select-Object -First`).
- agy tu dua `bin/` cua MOI plugin da cai vao PATH cua shell run_command (`where.exe harness` -> `~/.gemini/config/plugins/harness-kit/bin/harness(.cmd)`). => `harness` goi duoc ngay phien dau, KHONG can shim/overwrite cho agy.
- Lop quyen o may nay KHONG chan `harness doctor`, `node --version` hay lenh pipe ngay ca khi hook im lang (baseline) -> E1-E5 deu chay; chua do duoc allow/overrides co hieu luc tren cau hinh quyen chat. E6 hook deny: lenh KHONG chay, agent nhan "tool call denied by pre-tool hook: <reason>".
- Payload Pre dung `toolCall` (khong phai toolInput); `workspacePaths[0]` dang `C:/.../W` (dau `/`); hook cwd = `~/.gemini/config/plugins/<ten trong plugin.json>` (on dinh, cai lai = replace cung duong, khong doi theo version).
- SessionStart `injectSteps.systemMessage` HIEN cho agent; `rules/AGENTS.md` trong plugin DUOC nap. Stop + PostInvocation ban o `-p`.
- Hook agy ghi duoc `~/.harness-kit/bin` va HKCU; phien hien tai khong thay bien HKCU moi.
- `CLAUDE_CONFIG_DIR` rong -> hook agy van chay day du.
**Quyet dinh:** T2 = A1 (allow [+ permissionOverrides `command(harness)`] cho lenh doc trong allowlist), KHONG A2/overwrite; them `rules/AGENTS.md` ngan (cach goi harness doc + kho tri thuc chung) vi agy nap duoc. T2 thu hieu luc A1 bang `agy -p --settings <file allow rong>` (khong sua settings global); khong tai hien duoc chan thi ghi ro "chua do". T8: shim chi phuc vu shell nguoi dung/CLI khac; duong agy dung `bin/` cua plugin.
