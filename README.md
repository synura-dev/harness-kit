# harness-kit

Plugin Claude Code: lop rang buoc tat dinh cho agent (guard, approval, data zone, audit, hook dispatcher, cong CLI). Zero dependency, can Node.

- Cai: `/plugin install harness-kit --marketplace <owner>/<repo>` (repo nay chua .claude-plugin/marketplace.json).
- Repo nay la NGUON cua code loi; sua o day. Xem SOURCE-HISTORY.md (lich su truoc cutover nam o hub). export-manifest.json la di san cu.
- Du lieu: <du an>/.harness/data (tu them .gitignore). PLUGIN_ROOT chi doc.
- Guard chi o muc no luc tot nhat (hook fail-open); nen tu them deny trong settings cua du an.
- Khong bat cung luc voi dispatcher cung loai trong .claude/settings.json (hook chay doi).
