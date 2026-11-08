#!/usr/bin/env bash
# Point this checkout at localnet-only program ids and a localnet-only
# whitelist admin. GitHub Actions has no vanity keypairs, so the Linux build
# generates them, rewrites the constants, and the Arcis job applies the same
# ids before `arcium localnet` starts. The 1Password whitelist admin is not
# used here.
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
admin_kp="rust/casino/target/deploy/whitelist-admin-keypair.json"

if [[ "$keep" -eq 0 ]]; then
  bash scripts/write-build-keypairs.sh both
  bash scripts/write-build-keypairs.sh whitelist-admin
fi
if [[ ! -f "$casino_kp" || ! -f "$light_kp" || ! -f "$admin_kp" ]]; then
  echo "error: localnet program keypairs or the whitelist admin keypair are missing" >&2
  exit 1
fi

casino_pub="$(solana-keygen pubkey "$casino_kp")"
light_pub="$(solana-keygen pubkey "$light_kp")"
admin_pub="$(solana-keygen pubkey "$admin_kp")"

python3 - "$ROOT" "$casino_pub" "$light_pub" "$admin_pub" <<'PY'
import os
import sys

root, casino, light, admin = sys.argv[1:5]
old_casino = "4nPbWQkPAnSWMnSCAsuNicCGA86zrQKjzkZX7JFWRREY"
old_light = "CasinodrqvrdEqRYCMFfWGqQ1aD9mCcGDoWRQNPkWVtc"
old_admin = "CAdmin6xuLQFoANbHQWUpRmfBq9Su3gWeFCtELBh7oc3"
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
        updated = (
            text.replace(old_casino, casino)
            .replace(old_light, light)
            .replace(old_admin, admin)
        )
        if updated == text:
            continue
        open(path, "w", encoding="utf-8").write(updated)
        changed += 1
print(f"localnet casino program {casino}")
print(f"localnet light-casino program {light}")
print(f"localnet whitelist admin {admin}")
print(f"rewrote program ids in {changed} files")
PY
