#!/usr/bin/env bash
# macOS + iOS simulator full-game E2E against Solana localnet (:8899).
# Gameplay: in-WebView executePerSeatOp → RPC (bridge ZK witness+prove).
# Orchestration: solana-player-cli (ensure-room / reset / snapshot / start).
# Frontend: static assets on :5178 (no Vite /api/game*, no :3850 by default).
# Requires localnet at :8899. Does NOT start Bun game server (:3847).
#
# Usage:
#   bun run test:ios:simulator:full-game:solana
#   bun run localnet:start   # first, in another terminal if needed
#
# Legacy worker path:
#   E2E_SKIP_CHAIN_WORKER=0 E2E_API_BASE=http://127.0.0.1:3850 \
#     bun run test:ios:simulator:full-game:solana
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export E2E_BACKEND=solana
export E2E_SKIP_CHAIN_WORKER="${E2E_SKIP_CHAIN_WORKER:-1}"
# Empty → parent script uses frontend origin for asset base only.
export E2E_API_BASE="${E2E_API_BASE:-}"

exec bash "${ROOT}/app/scripts/run-ios-simulator-e2e-full-game.sh" "$@"
