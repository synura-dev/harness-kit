#!/usr/bin/env bash
# Build the release binary and copy the SAME binary into both plugins.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/rust/harness/target/release/harness-rs"

# host computes the tree (container may not see .git); build.rs reads this file
git -c safe.directory='*' -C "$ROOT" rev-parse HEAD:rust/harness > "$ROOT/rust/harness/.src-tree"

(cd "$ROOT/rust/harness" && timeout 900 cargo build --release --locked)
strip "$BIN"

for p in claude agy; do
  mkdir -p "$ROOT/plugins/$p/bin"
  cp "$BIN" "$ROOT/plugins/$p/bin/harness-rs"
  chmod 755 "$ROOT/plugins/$p/bin/harness-rs"
  git -c safe.directory="*" -C "$ROOT" update-index --chmod=+x "plugins/$p/bin/harness-rs" 2>/dev/null || true
done

a="$(sha256sum "$ROOT/plugins/claude/bin/harness-rs" | cut -d' ' -f1)"
b="$(sha256sum "$ROOT/plugins/agy/bin/harness-rs" | cut -d' ' -f1)"
if [ "$a" != "$b" ]; then
  echo "release: sha256 mismatch between plugin binaries" >&2
  exit 1
fi
echo "sha256 $a"
"$ROOT/plugins/claude/bin/harness-rs" --version
