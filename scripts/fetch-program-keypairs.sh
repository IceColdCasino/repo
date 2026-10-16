#!/usr/bin/env bash
# Copy program keypairs from 1Password into target/deploy.
# The documents live in the IceColdCasino vault. This script prints only pubkeys.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VAULT="${OP_VAULT:-IceColdCasino}"

export PATH="${HOME:-}/.local/share/solana/install/active_release/bin:${PATH}"

if ! command -v op >/dev/null 2>&1; then
  echo "error: 1Password CLI (op) is required to fetch program keypairs" >&2
  exit 1
fi
if ! command -v solana-keygen >/dev/null 2>&1; then
  echo "error: solana-keygen is required to check the fetched program keypair" >&2
  exit 1
fi

fetch_one() {
  local item_id="$1"
  local expected="$2"
  local dest="$3"
  local tmp
  mkdir -p "$(dirname "$dest")"
  if [[ -f "$dest" ]]; then
    local have
    have="$(solana-keygen pubkey "$dest" 2>/dev/null || true)"
    if [[ "$have" == "$expected" ]]; then
      echo "program keypair ${expected} -> ${dest#"$ROOT"/} (already present)"
      return 0
    fi
  fi
  tmp="$(mktemp)"
  chmod 600 "$tmp"
  # shellcheck disable=SC2064
  trap "rm -f '$tmp'" RETURN
  op document get "$item_id" --vault "$VAULT" --out-file "$tmp" --force >/dev/null
  local got
  if ! got="$(solana-keygen pubkey "$tmp" 2>&1)"; then
    echo "error: 1Password document ${item_id} is not a usable Solana keypair." >&2
    echo "error: its public half is ${expected}, but the secret half does not sign for that address." >&2
    exit 1
  fi
  if [[ "$got" != "$expected" ]]; then
    echo "error: 1Password document ${item_id} signs as ${got}, expected ${expected}" >&2
    exit 1
  fi
  mv "$tmp" "$dest"
  chmod 600 "$dest"
  trap - RETURN
  echo "program keypair ${expected} -> ${dest#"$ROOT"/}"
}

want="${1:-both}"
case "$want" in
  casino)
    fetch_one \
      evnj23rstndlykk73ncymjozg4 \
      CasinoXME8X5fZzMrcKT3Tu551ZaRxWofiEUWiVK2VFv \
      "$ROOT/rust/casino/target/deploy/casino-keypair.json"
    ;;
  light-casino|light)
    fetch_one \
      pnp66fmngo7h6yp7ozhlcuokwi \
      CasinodrqvrdEqRYCMFfWGqQ1aD9mCcGDoWRQNPkWVtc \
      "$ROOT/rust/light-casino/target/deploy/light_casino-keypair.json"
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
