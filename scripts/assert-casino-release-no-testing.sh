#!/usr/bin/env bash
# Fail if a poker release/SBF build is about to include `--features testing`.
#
# Localnet E2E may set CASINO_FEATURES=testing intentionally; production /
# release artifact builds must leave CASINO_FEATURES empty (or omit `testing`).
#
# Also verifies C2 source gates: faucet_credit_personal / FaucetCreditPersonal
# remain behind `#[cfg(feature = "testing")]` so a mis-set CASINO_FEATURES is not
# the only line of defense.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FEATURES="${CASINO_FEATURES:-}"
ALLOW="${CASINO_ALLOW_TESTING:-}"

if [[ -n "$FEATURES" ]] && grep -Eq '(^|,)[[:space:]]*testing([[:space:]]*,|$)' <<<"$FEATURES"; then
  if [[ "$ALLOW" == "1" || "$ALLOW" == "true" ]]; then
    echo "warn: poker build includes feature 'testing' (CASINO_ALLOW_TESTING=$ALLOW)" >&2
    exit 0
  fi
  echo "error: poker release build must not enable feature 'testing'." >&2
  echo "  CASINO_FEATURES='$FEATURES'" >&2
  echo "  For localnet/E2E only: CASINO_ALLOW_TESTING=1 CASINO_FEATURES=testing ./scripts/..." >&2
  exit 1
fi

assert_cfg_gated() {
  local file="$1"
  local symbol="$2"
  if ! python3 - "$file" "$symbol" <<'PY'
import re, sys
path, symbol = sys.argv[1], sys.argv[2]
src = open(path, encoding="utf-8").read()
pat = rf'#\[cfg\(feature\s*=\s*"testing"\)\]\s*(?:(?://[^\n]*\n|/\*[\s\S]*?\*/|#\[[^\]]*\]|\s)*)(?:pub\s+)?(?:fn|const|struct)\s+{re.escape(symbol)}\b'
if not re.search(pat, src):
    sys.stderr.write(f"error: {symbol} in {path} must be #[cfg(feature = \"testing\")]\n")
    sys.exit(1)
PY
  then
    exit 1
  fi
}

assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "faucet_credit_personal"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "ESCROW_KIND_FAUCET"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/ix.rs" "FaucetCreditPersonal"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "apply_casino_player_net"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "ApplyCasinoPlayerNet"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "init_apply_casino_player_net_comp_def"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "transfer_personal_to_seat"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "transfer_seat_to_personal"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/ix.rs" "TransferPersonalToSeat"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/ix.rs" "TransferSeatToPersonal"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "start_betting_round"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "StartBettingRound"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "set_showdown_hash"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "set_pot_amounts"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "set_verified"
# Unsafe financial paths: Arcis cannot authenticate transfer success / player ledgers.
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "stake_dealer_pool"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "StakeDealerPool"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "redeem_dealer_pool"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "RedeemDealerPool"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "settle_casino_hand"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "SettleCasinoHand"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "init_stake_dealer_pool_comp_def"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "init_redeem_dealer_pool_comp_def"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "init_settle_casino_hand_comp_def"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "init_player_state"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "InitPlayerState"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "end_hand"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "EndHand"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "collect_blinds"
assert_cfg_gated "$ROOT/rust/casino/programs/casino/src/lib.rs" "CollectBlinds"

if ! grep -Eq '\bpub fn open_preflop\b' "$ROOT/rust/casino/programs/casino/src/lib.rs"; then
  echo "error: open_preflop missing from poker program" >&2
  exit 1
fi

# V6: generic UncheckedAccount writer must not return in release source.
if grep -Eq '\bpub fn write_account_data\b' "$ROOT/rust/casino/programs/casino/src/lib.rs"; then
  echo "error: write_account_data must be removed (use write_deck_staging / write_share_deck_staging)" >&2
  exit 1
fi
if ! grep -Eq '\bpub fn write_deck_staging\b' "$ROOT/rust/casino/programs/casino/src/lib.rs"; then
  echo "error: write_deck_staging missing from poker program" >&2
  exit 1
fi
if ! grep -Eq '\bpub fn write_share_deck_staging\b' "$ROOT/rust/casino/programs/casino/src/lib.rs"; then
  echo "error: write_share_deck_staging missing from poker program" >&2
  exit 1
fi

echo "ok: poker features do not include 'testing' (CASINO_FEATURES='${FEATURES:-<empty>}')"
echo "ok: faucet + apply_casino_player_net remain cfg(testing)-gated"
echo "ok: plaintext transfer_personal/seat remain cfg(testing)-gated"
echo "ok: start_betting_round cfg(testing); open_preflop present"
echo "ok: dealer-pool stake/redeem + settle_casino_hand remain cfg(testing)-gated"
echo "ok: generic write_account_data absent; typed staging writers present"
