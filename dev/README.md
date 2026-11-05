# dev/ - cong cu phat trien harness-kit (khong nap luc chay)
Khong module runtime nao (hooks, cli, core, observe, evolve/loop) duoc import tu dev/ (test chan: harness/core/config/no-dev-import.test.mjs).
- Check tinh (ref/import/clutter/manifest/proc/stray): `node dev/checks/run.mjs` (them `--strict` de exit 1 khi co loi).
- Eval hoi quy tat dinh: `node dev/eval/cli.mjs run|list|baseline|compare|bench`.
- Build skill: `node dev/skills/cli.mjs build|check|prune`; dong bo adapter: `node dev/sync.mjs [--check]`.
- Bang adapter: `node dev/adapters-report.mjs [--write-readme|--write-arch]`.
- Test: `timeout 300 bun test harness dev`.
- `harness doctor` (runtime) chi kiem: hook noi, config hop le, du lieu (data scan/retention).
