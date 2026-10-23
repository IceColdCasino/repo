#!/bin/bash
# Two macOS windows on one devnet poker table.
# Does not upload computation definitions and does not start a local validator.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "${APP_DIR}/.." && pwd)"
cd "${APP_DIR}"

if [[ -f "${REPO_DIR}/.env.devnet" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${REPO_DIR}/.env.devnet"
  set +a
fi
unset UPLOAD_COMP_DEFS
export ARCIUM_CLUSTER_OFFSET="${ARCIUM_CLUSTER_OFFSET:-456}"
export ZK_REPO_ROOT="${REPO_DIR}"
export E2E_GAME_KIND=poker
export DYLD_LIBRARY_PATH="${APP_DIR}/zig-out/lib${DYLD_LIBRARY_PATH:+:${DYLD_LIBRARY_PATH}}"
ln -sfn zig-out/lib lib

PORT="${DEVNET_TWO_PLAYER_PORT:-5198}"
NONCE="$(date +%s)"
LOG_DIR="/tmp/icc-devnet-two"
mkdir -p "${LOG_DIR}" "${REPO_DIR}/.local"

echo "[devnet-two] ensuring a fresh table"
TABLE_JSON="$(bun "${APP_DIR}/scripts/devnet-table.ts" ensure)"
export TABLE_JSON
echo "[devnet-two] ${TABLE_JSON}"

python3 - <<PY
import json, os
from pathlib import Path
table = json.loads(os.environ["TABLE_JSON"])
home = Path.home()
def load_key(path):
    p = Path(path)
    if not p.is_file():
        return None
    data = json.loads(p.read_text())
    return data if isinstance(data, list) else None
rpc = os.environ.get("SOLANA_RPC_URL") or ""
offset = int(os.environ.get("ARCIUM_CLUSTER_OFFSET") or "456")
admin = load_key(os.environ.get("WHITELIST_ADMIN_KEYPAIR") or home / ".config/solana/whitelist-admin.json")
payer = load_key(os.environ.get("MXE_AUTHORITY_KEYPAIR") or home / ".config/solana/id.json")
cfg = {
    "manualSetup": True,
    "backend": "devnet",
    "clusterOffset": offset,
    "solanaRpc": rpc,
    "roomSeed": table["roomSeed"],
    "tableId": str(table["tableId"]),
    "roomIdHex": table.get("roomIdHex"),
    "gameKind": "poker",
}
if admin is not None:
    cfg["whitelistAdminSecret"] = admin
if payer is not None:
    cfg["feePayerSecret"] = payer
dist = Path("${APP_DIR}") / "frontend" / "dist"
dist.mkdir(parents=True, exist_ok=True)
(dist / "launch-config.js").write_text(
    "window.__ZK_LAUNCH_CONFIG = " + json.dumps(cfg) + ";\n"
)
print("[devnet-two] launch-config table", cfg["roomSeed"], cfg["tableId"])
PY

if ! curl -sf --max-time 2 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
  python3 -m http.server "${PORT}" --bind 127.0.0.1 --directory "${APP_DIR}/frontend/dist" \
    >"${LOG_DIR}/http.log" 2>&1 &
  echo $! >"${LOG_DIR}/http.pid"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -sf --max-time 1 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 && break
    sleep 0.3
  done
fi

QUERY="manualSetup=1&e2eAutoPlay=0&backend=devnet&noChainWorker=1&gameKind=poker&e2eNonce=${NONCE}"
BINARY="${APP_DIR}/zig-out/bin/app"
launch_seat() {
  local seat="$1"
  unset ZK_LAUNCH_NEW_WALLET
  unset ZK_LAUNCH_AUTO_PLAY
  unset ZK_LAUNCH_START_HAND
  ZERO_NATIVE_FRONTEND_URL="http://127.0.0.1:${PORT}/index-seat-${seat}.html?${QUERY}&e2eSeat=${seat}" \
    ZK_LAUNCH_MANUAL_SETUP=1 \
    ZK_LAUNCH_SEAT="${seat}" \
    ZK_LAUNCH_BACKEND=devnet \
    ZK_REPO_ROOT="${REPO_DIR}" \
    SOLANA_RPC_URL="${SOLANA_RPC_URL}" \
    ARCIUM_CLUSTER_OFFSET="${ARCIUM_CLUSTER_OFFSET}" \
    DYLD_LIBRARY_PATH="${DYLD_LIBRARY_PATH}" \
    nohup "${BINARY}" >"${LOG_DIR}/seat${seat}.log" 2>&1 &
  echo $! >"${LOG_DIR}/seat${seat}.pid"
  echo "[devnet-two] seat ${seat} pid $(cat "${LOG_DIR}/seat${seat}.pid")"
}

echo "[devnet-two] launching seat 0"
launch_seat 0
echo "[devnet-two] launching seat 1"
launch_seat 1
echo "[devnet-two] each player: Sit, Faucet, then Start hand"
