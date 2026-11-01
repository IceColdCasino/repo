#!/usr/bin/env bash
# Point this checkout at a localnet-only program id.
# GitHub Actions has no vanity keypair, so the Linux build generates one,
# rewrites declare_id to it, and the macOS job applies the same ids before
# `arcium localnet` starts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="${HOME:-}/.local/share/solana/install/active_release/bin:${PATH}"

keep=0
if [[ "${1:-}" == "--keep-keypairs" ]]; then
  keep=1
fi

casino_kp="rust/casino/target/deploy/casino-keypair.json"
light_kp="rust/light-casino/target/deploy/light_casino-keypair.json"

if [[ "$keep" -eq 0 ]]; then
  bash scripts/write-build-keypairs.sh both
fi
if [[ ! -f "$casino_kp" || ! -f "$light_kp" ]]; then
  echo "error: localnet program keypairs are missing" >&2
  exit 1
fi

casino_pub="$(solana-keygen pubkey "$casino_kp")"
light_pub="$(solana-keygen pubkey "$light_kp")"

python3 - "$ROOT" "$casino_pub" "$light_pub" <<'PY'
import os
import sys

root, casino, light = sys.argv[1:4]
old_casino = "4nPbWQkPAnSWMnSCAsuNicCGA86zrQKjzkZX7JFWRREY"
old_light = "CasinodrqvrdEqRYCMFfWGqQ1aD9mCcGDoWRQNPkWVtc"
skip_dirs = {
    ".git",
    "node_modules",
    "target",
    "zig-out",
    ".zig-cache",
    "zkey",
    "dist",
    ".lake",
}
exts = {".rs", ".toml", ".ts", ".tsx", ".js", ".mjs", ".json", ".zig"}
changed = 0
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [name for name in dirnames if name not in skip_dirs]
    for name in filenames:
        if name.endswith("keypair.json"):
            continue
        if os.path.splitext(name)[1] not in exts:
            continue
        path = os.path.join(dirpath, name)
        try:
            text = open(path, encoding="utf-8").read()
        except (OSError, UnicodeDecodeError):
            continue
        updated = text.replace(old_casino, casino).replace(old_light, light)
        if updated == text:
            continue
        open(path, "w", encoding="utf-8").write(updated)
        changed += 1
print(f"localnet casino program {casino}")
print(f"localnet light-casino program {light}")
print(f"rewrote program ids in {changed} files")
PY
