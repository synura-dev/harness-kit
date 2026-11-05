# hub-verify

Goi extension hub tach tu harness-kit (slim B2): play (playbook verify-project) + verify-gate (hook gate verify).
Logic giu nguyen, chi chuyen cho. Cac import `../../core/...` can chinh sang ctx ext (hoac duong toi harness-kit) khi tich hop.

Cai: chep thu muc nay thanh `<hub>/hub/hub-verify/`, sua import core, nguoi dung dang ky + duyet trong TTY rieng
(lenh ext cua harness). Hook verify-gate dang ky lai o hub (khong con trong modules.mjs cua plugin).
