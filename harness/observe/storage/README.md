# Storage (data/ layout, canonical doc)

Lua chon: `data/README.md` nam trong vung deny (`Read|Write|Edit(/data/**)` trong settings, deny thang allow nen khong allowlist duoc). Noi dung layout chuan nam O DAY; `data/README.md` chi nen la con tro toi file nay (nguoi dung tu sua tay neu muon).

## Layout chuan
`data/<domain>/<tool>/<date=YYYY-MM-DD|run-id>/...`. Duong dan qua `dataPath()` (`harness/core/io/storage.mjs`). Moi `<domain>` phai co trong `registry.json` (owner, retentionDays).

## Lenh (qua cong, co log vao data/audit/gateway/)
- `node harness/cli/harness.mjs data ls [domain]` liet ke file/kich thuoc.
- `data stat` tong quan + so muc ngoai registry.
- `data clean` xoa file cu hon retentionDays (mtime); `null` = giu.
- `data scan` tim muc la (ngoai registry, tru reserved `README.md`, `_inbox`, `.state`).
- `data adopt` chuyen muc la vao `data/_inbox/<date>/`.
- `data inbox ls [--limit N]` liet ke `_inbox/<ngay>/<muc>` (file, size).
- `data inbox rm <ngay>/<muc> [--yes]` xoa 1 muc trong _inbox (dry-run mac dinh; tu choi rong, `..`, tuyet doi, chinh `_inbox`; dung API fs cua Node).
- `data inbox restore <ngay>/<muc> [--yes]` chuyen nguoc ve goc data neu chua ton tai (khong ghi de).
- `data inbox prune [--days N] [--yes]` xoa muc _inbox cu hon N ngay (mac dinh 30, 1..3650; dry-run mac dinh).
  Moi lenh inbox ghi vet type=data-access.

- `data tail <domain> [--n N] [--type T] [--since 1d]` doc N dong cuoi (mac dinh 20, toi da 200) tu .jsonl moi nhat cua domain da dang ky (vd `data tail gateway`), cat truong >300 ky tu, co limit byte/timeout, ghi vet data-access. Dung khi data-gate chan doc truc tiep.
- `scan`, `clean`, `adopt`, `tail` thoat code 2 va khong cham gi khi registry khong doc duoc (file registry/workspace json hong) hoac rong bat thuong. `clean` dung retention theo class (retentionDays tuong minh > mac dinh class), khop canh bao cua scan; artifact/durable khong bao gio bi xoa. `register`/cache scan ghi nguyen tu (tmp + rename).

## Pham vi enforce
`HARNESS_DATA_ENFORCE` / `registry.enforce` chi phu cac writer di qua `guardWrite` (storage.mjs): audit, gateway, proc-orphans, play, tasks compact, storage (writeJson/appendJsonl). Khi chan, appendJsonl in 1 dong stderr `data-enforce: ...` va khong ghi.
CHUA phu (dung fs truc tiep): dispatch-worker, release, vault. Cac writer nay chi bi `data scan`/doctor phat hien sau su kien, khong bi chan luc ghi.

## Cay zone va scan
Zone cap 1: system, knowledge, workspaces, external, _inbox. Moi muc registry co zone/class/owner (+workspace voi zone=workspaces); `path` = vi tri vat ly hien tai, `target` = dich cuoi. Muc workspace nam o `config/data/workspaces/<ws>.json` (+ `.example`), registry.json chi giu phan chung. Class mac dinh: log 30d, cache 7d, artifact/durable khong tu xoa (override `retentionDays`, `caps`).
`data scan [--json]`: ra dong `data-warn rule=... path= key= detail= fix=` (unregistered, missing-field, over-caps, retention, stray, clutter docs/goc repo), exit 1 khi co vi pham, ghi cache `.state/data-scan.json`. Khong tu xoa; dung `data clean`. `data register|tree` do `register.mjs` (W3).

## Dang ky du lieu moi (register)
`data register <zone>/<domain|ws>/<tool> --class <log|cache|artifact|durable> [--project ID]` truoc lan ghi dau. Class mac dinh: log 30d, cache 7d, artifact/durable khong tu xoa; override bang `retentionDays`, `caps`. `data tree [--write-readme]` in cay zone va ghi vao khoi giua hai marker data-tree. Thieu dang ky: storage tu canh bao (`data-warn`), hook data-check, doctor.
Quy trinh muc la: `data scan` -> `data adopt --yes` (vao _inbox/<date>/) -> `data inbox ls|restore|rm` -> dang ky dung hoac xoa.

## Retention (registry.json)
audit 90d, play/runs/watchdog 14d, worktree 30d, proc-orphans 7d; release/memory/evolve/eval/tasks/ws-demo: giu.

## Quy tac du lieu la
Tool moi them domain vao registry truoc khi ghi. Muc la phat hien boi `data scan`/doctor: `data adopt` vao `data/_inbox/<date>/`, sau do dang ky domain dung hoac xoa.

## Log/ket qua test
Log/ket qua test cua agent ghi ra data/<domain>/<tool>/ qua storage.mjs hoac scratchpad, khong ghi vao docs/.

## Du lieu do ben ngoai harness sinh
Quy trinh: `data scan` phat hien -> `data adopt` (dry-run, roi `--yes`) vao `_inbox/<date>/` -> duyet: dang ky vao registry (owner + retentionDays; app-state cong cu ngoai nhu agy-home dung `"domain": "external"`, retention null, khong dung) hoac xoa. doctor canh bao `data-unregistered`. Du lieu goc (starter-work, starter-baseline) dang ky retention null.

## Chan truc tiep
Agent khong Read/Write/Bash thang vao `data/` (settings deny + hook `constrain/data-gate`). Chi chan khi duong dan thuc su resolve vao `dataRoot()`; ten `data.mjs`, `observe/storage/`, `data/` cua du an khac (cwd ngoai hub), `node harness/...` va `node|bun test harness/...` khong bi chan.

## Chuyen du lieu: lenh doi cho, legacy-read
- Lenh `harness data` + `mv <from> <to> [--yes]`: dry-run mac dinh (file, bytes, md5 tong). `--yes`: abort (exit 2) khi registry hong, from khong co hoac khong trong registry, dich da ton tai, co `..`, thoat dataDir, to trong from, khac o dia; rename roi tinh lai md5, lech thi rename nguoc. Thanh cong: entry doi `path=to`, `legacy=from`, ghi vet. Khoa `.state/mv.lock` het han 5 phut.
- Hoan tac: cung lenh voi from/to dao nguoc (bo `legacy`).
- Code: `resolveDataRel(key, opts)` (core/registry) tra `{rel, legacyRel, readRel, usingLegacy, exists}`; `dataPathFor(key, ...parts, {mode:'read'|'write'})` (core/io/storage). Ghi luon path moi; doc lay path moi neu co, khong thi legacy kem `data-warn rule=legacy-read` (1 lan/key/tien trinh).
- `scan`: `rule=duplicate` khi ton tai ca path moi va legacy; thu muc zone cap 1 duoc chap nhan.

## Cay du lieu (sinh tu registry)
<!-- data-tree:start -->
```
system/
  audit/
    -  [log] owner=harness/observe/audit retention=90d
  gateway/
    -  [log] owner=harness/cli/gateway retention=30d
  play/
    -  [log] owner=hub/play retention=14d
  proc-orphans/
    -  [log] owner=harness/constrain/proc-orphans retention=7d
  runs/
    -  [log] owner=hub/dispatch/dispatch-worker.mjs retention=14d
  watchdog/
    -  [log] owner=harness/cli/commands/proc-watch.mjs retention=14d
  worktree/
    -  [log] owner=harness/constrain/worktree retention=30d
knowledge/
  eval/
    -  [artifact] owner=harness/evolve/eval retention=giu
  evals/
    -  [artifact] owner=curator (skill eval cu, xem evolve/README) retention=giu
  evolve/
    -  [durable] owner=harness/evolve/loop retention=giu
  memory/
    -  [durable] owner=harness/knowledge/vault retention=giu
  tasks/
    -  [durable] owner=hub/tasks retention=giu
workspaces/
  ws-demo/
    -  [durable] owner=skill ws-demo retention=giu
  proj-demo/
    release  [durable] owner=harness/tools/release retention=giu
    starter-baseline  [artifact] owner=proj-demo deploy E3 (baseline Starter) retention=giu
    starter-work  [artifact] owner=proj-demo deploy E3 (ban sao Starter) retention=giu
external/
  agy-home/
    -  [durable] owner=hub/agy (app-state cua agy CLI) retention=giu
```
<!-- data-tree:end -->

## Don tu dong
`harness data clean --auto [--yes] [--max-files N] [--max-bytes N] [--timeout-s N]` (dry-run neu khong --yes; clean khong --auto giu hanh vi cu). Pham vi: chi muc registry class log/cache (ke ca retentionDays override), chi file qua han theo classRetention. KHONG dong artifact/durable/external/_inbox/.state; bo qua file mtime hom nay (gio dia phuong) va moi thu muc `date=<hom nay>` (audit). Tran moi lan: 500 file, 200MB, 20s (vuot thi dung em, bao `truncated: ...`). Khong di theo symlink/junction, khong xoa dich link. Registry hong/rong: abort ma 2. Vet: audit type=data-access (dem theo muc + tong bytes, khong liet ke file); ket qua o data/.state/data-check-clean.json. Kich hoat tu dong boi hook data-check SessionStart (moi 24h); tat: `HOOK_DATA_CHECK_AUTOCLEAN=0` hoac `autoClean.enabled=false`.

## Chuyen vi tri: relocate, mvpart, doc gop
Dung khi du lieu dang ghi lien tuc (audit) nen khong `data mv` ca thu muc duoc.
- `data relocate <key> <to-rel> [--yes]`: CHI ghi registry (`path=<to-rel>`, `legacy=<cu>`), khong di chuyen file; dry-run mac dinh. to-rel khong `..`/tuyet doi/reserved. Loi thoat: `data relocate <key> <duong cu> --yes` (ghi ve cho cu).
- `data mvpart <key> [--yes] [--keep-days N | --before YYYY-MM-DD] [--rest]` (`--before`: chuyen moi phan vung date < gia tri, ngay mai = chuyen ca hom nay; `--rest`: chuyen them file khong theo ngay, md5 tung file, bo qua *.lock): chuyen tung phan vung `date=YYYY-MM-DD` tu legacy sang path moi; giu hom nay + hom qua (gio dia phuong; `--keep-days 0` chi giu hom nay). md5 manifest truoc/sau tung phan vung, rename cung o, lech md5 -> hoan tac phan vung. Trung ten file o dich -> file cu thanh `<ten>.legacy.jsonl` canh file moi (khong sua noi dung). EBUSY/EPERM -> bo qua phan vung, tiep tuc. Tran 5000 file/60s (`truncated: ...`), khoa `.state/mvpart.lock`, ghi vet data-access.
- Doc gop: `dataReadRoots(key)` / `dataPathsFor(key, ...parts)` (core/registry) tra [path moi, legacy] chi nhung goc ton tai; reader lap qua cac goc. `data tail` doc ca legacy va gop theo `ts`.
- May bat reader sot: `raw-paths.test.mjs` quet harness/ hub/ tim duong cung toi key goc (allowlist `ALLOW` co ly do); mac dinh chi bao, `DATA_RAW_PATHS_STRICT=1` de fail.
Tmp/test: env `HARNESS_DATA_REGISTRY`, `HARNESS_DATA_WORKSPACES` doi registry cho CLI; `register --no-resolve` (chi khi HUB_DATA_DIR khac data that) bo qua `projects resolve`.
