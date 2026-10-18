#!/usr/bin/env bash
# Frontend-driven 2p poker E2E (macOS + optional iOS).
#
# No saved fixtures or checkpoints. Each run seats real native clients and
# lets the Poker frontend step register → shuffle → share → showdown via
# window.zero (live keys, deck, and proofs).
#
# Usage:
#   bash app/scripts/run-bridge-chain-e2e.sh
#   BRIDGE_CHAIN_SKIP_IOS=1 bash app/scripts/run-bridge-chain-e2e.sh   # macOS↔macOS only
#   BRIDGE_CHAIN_SKIP_MACOS=1 bash app/scripts/run-bridge-chain-e2e.sh  # macOS host + iOS seat 1 only
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
API_BASE="${E2E_API_BASE:-http://127.0.0.1:3847}"

echo "[bridge-chain] frontend-driven 2p poker (no fixtures / no checkpoints)"
echo "[bridge-chain] api=${API_BASE}"

run_macos_two_native() {
  echo "[bridge-chain] === macOS ↔ macOS (frontend ZK, either seat may showdown) ==="
  # Close apps when done so CI/automation does not leave windows around.
  E2E_BACKEND="${E2E_BACKEND:-local}" \
  E2E_API_BASE="${API_BASE}" \
  E2E_KEEP_APPS_OPEN="${E2E_KEEP_APPS_OPEN:-0}" \
  COMPLETE_TIMEOUT_SECS="${COMPLETE_TIMEOUT_SECS:-900}" \
    bash "${ROOT}/scripts/run-two-native-players.sh"
}

run_macos_ios_full_game() {
  echo "[bridge-chain] === macOS seat 0 + iOS seat 1 (frontend ZK, winner showdown) ==="
  E2E_API_BASE="${API_BASE}" \
  SKIP_IOS_E2E_BUILD="${SKIP_IOS_E2E_BUILD:-0}" \
  IOS_E2E_POLL_SECONDS="${IOS_E2E_POLL_SECONDS:-600}" \
    bash "${ROOT}/app/scripts/run-ios-simulator-e2e-full-game.sh"
}

if [[ "${BRIDGE_CHAIN_SKIP_MACOS:-0}" != "1" ]]; then
  run_macos_two_native
else
  echo "[bridge-chain] skip macOS↔macOS (BRIDGE_CHAIN_SKIP_MACOS=1)"
fi

if [[ "${BRIDGE_CHAIN_SKIP_IOS:-0}" != "1" ]]; then
  run_macos_ios_full_game
else
  echo "[bridge-chain] skip macOS+iOS (BRIDGE_CHAIN_SKIP_IOS=1)"
fi

echo "[bridge-chain] complete"
