#!/usr/bin/env bash
# Throwaway program keypairs for compilation. Deploy replaces these
# with the vanity keypairs from 1Password.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${HOME:-}/.local/share/solana/install/active_release/bin:${PATH}"

if ! command -v solana-keygen >/dev/null 2>&1; then
  echo "error: solana-keygen is required to write a build keypair" >&2
  exit 1
fi

write_one() {
  local dest="$1"
  mkdir -p "$(dirname "$dest")"
  solana-keygen new --no-bip39-passphrase --force --silent -o "$dest" >/dev/null
  chmod 600 "$dest"
  echo "build keypair $(solana-keygen pubkey "$dest") -> ${dest#"$ROOT"/}"
}

want="${1:-both}"
case "$want" in
  casino)
    write_one "$ROOT/rust/casino/target/deploy/casino-keypair.json"
    ;;
  light-casino|light)
    write_one "$ROOT/rust/light-casino/target/deploy/light_casino-keypair.json"
    ;;
  both)
    "$0" casino
    "$0" light-casino
    ;;
  *)
    echo "usage: $0 [casino|light-casino|both]" >&2
    exit 2
    ;;
esac
