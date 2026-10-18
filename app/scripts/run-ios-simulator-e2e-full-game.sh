#!/usr/bin/env bash
# Full-hand iOS simulator E2E: both seats use native witness + Groth16 via window.zero bridge.
# Seat 0 = macOS desktop app; seat 1 = iOS simulator. Host runs API + builds only.
#
# Backends:
#   (default)          Bun game server on :3847
#   E2E_BACKEND=solana Solana RPC :8899; gameplay via in-WebView executePerSeatOp.
#                      Frontend is static/Vite assets only (no /api/game*).
#                      Orchestration: solana-player-cli (ensure-room/reset/snapshot/start).
#                      Optional :3850 when E2E_SKIP_CHAIN_WORKER=0.
#
# Usage:
#   npm run test:ios:simulator:full-game
#   bun run test:ios:simulator:full-game:solana
#   IOS_E2E_POLL_SECONDS=240 npm run test:ios:simulator:full-game
set -euo pipefail

source "$(dirname "$0")/ios-simulator-common.sh"
ios_sim_init_paths

E2E_BACKEND="${E2E_BACKEND:-local}"
POLL_SECONDS="${IOS_E2E_POLL_SECONDS:-600}"
SKIP_BUILD="${SKIP_IOS_E2E_BUILD:-0}"
FRONTEND_PORT="${IOS_E2E_FRONTEND_PORT:-5178}"

if [[ "${E2E_BACKEND}" == "solana" ]]; then
  if [[ -n "${E2E_API_BASE:-}" ]]; then
    API_BASE="${E2E_API_BASE}"
  elif [[ "${E2E_SKIP_CHAIN_WORKER:-1}" == "1" ]]; then
    API_BASE="http://127.0.0.1:${FRONTEND_PORT}"
  else
    API_BASE="http://127.0.0.1:3850"
  fi
  GAME_ID="solana-local-table"
  LOCALNET_RPC="${SOLANA_RPC_URL:-http://127.0.0.1:8899}"
else
  API_BASE="${E2E_API_BASE:-http://127.0.0.1:3847}"
  GAME_ID="local-table"
  SERVER_PORT="${SERVER_PORT:-3847}"
fi

echo "[ios-full-e2e] repo root: $ROOT"
echo "[ios-full-e2e] backend: $E2E_BACKEND"
echo "[ios-full-e2e] api base: $API_BASE"

SOLANA_PER_SEAT=0
if [[ "${E2E_BACKEND}" == "solana" && "${E2E_SKIP_CHAIN_WORKER:-1}" == "1" ]]; then
  SOLANA_PER_SEAT=1
fi

solana_player_cli() {
  (cd "${ROOT}" && bun run scripts/solana-player-cli.ts "$@")
}

# Last JSON object from CLI stdout (bun may print bigint warnings first).
solana_snapshot_json() {
  solana_player_cli snapshot 2>/dev/null | python3 -c "
import sys
lines=[l for l in sys.stdin.read().splitlines() if l.strip()]
for line in reversed(lines):
    if line.startswith('{'):
        print(line)
        break
"
}

health_ok() {
  if [[ "${SOLANA_PER_SEAT}" == "1" ]]; then
    # Assets only — gameplay is RPC, not Vite /api/*.
    curl -sf "${API_BASE}/" >/dev/null 2>&1
  elif [[ "${E2E_BACKEND}" == "solana" ]]; then
    curl -sf "${API_BASE}/api/health" >/dev/null 2>&1
  else
    curl -sf "${API_BASE}/api/health?backend=local" >/dev/null 2>&1
  fi
}

game_url() {
  if [[ "${E2E_BACKEND}" == "solana" ]]; then
    echo "${API_BASE}/api/game"
  else
    echo "${API_BASE}/api/games/${GAME_ID}?backend=local"
  fi
}

start_hand_url() {
  if [[ "${E2E_BACKEND}" == "solana" ]]; then
    echo "${API_BASE}/api/game/start"
  else
    echo "${API_BASE}/api/games/${GAME_ID}/start?backend=local"
  fi
}

reset_table() {
  if [[ "${SOLANA_PER_SEAT}" == "1" ]]; then
    # Per-seat path has no resetTable op — mint a fresh shared table.
    echo "[ios-full-e2e] ensure-room --fresh (new on-chain table)"
    E2E_FRESH_TABLE=1 solana_player_cli ensure-room --fresh >/dev/null
  elif [[ "${E2E_BACKEND}" == "solana" ]]; then
    curl -sf -X POST "${API_BASE}/api/admin/reset" >/dev/null
  else
    curl -sf -X POST "${API_BASE}/api/admin/reset?backend=local&manualAutoBet=1" >/dev/null
  fi
}

seat_funded() {
  local seat="$1"
  local min_chips="${2:-50}"
  if [[ "${SOLANA_PER_SEAT}" == "1" ]]; then
    solana_snapshot_json | python3 -c "
import json, sys
j = json.load(sys.stdin)
seat = int(sys.argv[1])
min_chips = int(sys.argv[2])
seats = j.get('seats') or []
ok = any(
    s.get('seat') == seat and int(s.get('seatEscrow') or s.get('chips') or 0) >= min_chips
    for s in seats
)
sys.exit(0 if ok else 1)
" "${seat}" "${min_chips}" 2>/dev/null
  else
    curl -sf "$(game_url)" 2>/dev/null | python3 -c "
import json, sys
j = json.load(sys.stdin)
seat = int(sys.argv[1])
min_chips = int(sys.argv[2])
seats = j.get('seats') or []
ok = any(s.get('seat') == seat and int(s.get('chips', 0)) >= min_chips for s in seats)
sys.exit(0 if ok else 1)
" "${seat}" "${min_chips}" 2>/dev/null
  fi
}

start_hand() {
  if [[ "${SOLANA_PER_SEAT}" == "1" ]]; then
    echo "[ios-full-e2e] starting Solana hand via solana-player-cli"
    solana_player_cli start > /tmp/zk-poker-ios-e2e-start-hand.json 2>/tmp/zk-poker-ios-e2e-start-hand.err
  else
    curl -sf -X POST "$(start_hand_url)" >/dev/null
  fi
}

ensure_server() {
  if [[ "${E2E_BACKEND}" == "solana" ]]; then
    if ! curl -sf -X POST "${LOCALNET_RPC}" \
      -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' >/dev/null 2>&1; then
      echo "[ios-full-e2e] Solana localnet is not ready at ${LOCALNET_RPC}" >&2
      echo "[ios-full-e2e] Start it with: bun run localnet:start" >&2
      exit 1
    fi
    if [[ "${E2E_SKIP_CHAIN_WORKER:-1}" == "1" ]]; then
      echo "[ios-full-e2e] skipping :3850 worker — per-seat executePerSeatOp → RPC :8899"
      echo "[ios-full-e2e] ensuring shared on-chain room (reuse table; fresh happens in reset_table)..."
      solana_player_cli ensure-room >/dev/null
      return 0
    fi
    if health_ok; then
      echo "[ios-full-e2e] chain worker already up at ${API_BASE}"
      return 0
    fi
    echo "[ios-full-e2e] starting chain worker on :3850..."
    nohup bun run --cwd "$ROOT" solana:localnet-worker >>"${ROOT}/.ios-e2e-chain-worker.log" 2>&1 &
    SERVER_PID=$!
    disown "${SERVER_PID}" 2>/dev/null || true
    local elapsed=0
    while (( elapsed < 60 )); do
      if health_ok; then
        echo "[ios-full-e2e] chain worker ready (pid ${SERVER_PID})"
        return 0
      fi
      sleep 1
      elapsed=$((elapsed + 1))
    done
    echo "[ios-full-e2e] chain worker failed to start" >&2
    kill "$SERVER_PID" 2>/dev/null || true
    exit 1
  fi

  if health_ok; then
    echo "[ios-full-e2e] server already up at ${API_BASE}"
    return 0
  fi
  echo "[ios-full-e2e] starting game server on port ${SERVER_PORT}..."
  nohup env PORT="${SERVER_PORT}" bash "$ROOT/scripts/run-server.sh" >>"${ROOT}/.ios-e2e-server.log" 2>&1 &
  SERVER_PID=$!
  disown "${SERVER_PID}" 2>/dev/null || true
  local elapsed=0
  while (( elapsed < 60 )); do
    if health_ok; then
      echo "[ios-full-e2e] server ready (pid ${SERVER_PID})"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "[ios-full-e2e] server failed to start" >&2
  kill "$SERVER_PID" 2>/dev/null || true
  exit 1
}

try_revive_server() {
  if health_ok; then
    return 0
  fi
  if [[ "${SOLANA_PER_SEAT}" == "1" ]]; then
    # Frontend static server is owned by mac-host; localnet is separate.
    echo "[ios-full-e2e] frontend unhealthy — waiting for mac-host static server"
    return 1
  fi
  if [[ "${E2E_BACKEND}" == "solana" ]]; then
    echo "[ios-full-e2e] chain worker unhealthy — restarting (log: ${ROOT}/.ios-e2e-chain-worker.log)"
    nohup bun run --cwd "$ROOT" solana:localnet-worker >>"${ROOT}/.ios-e2e-chain-worker.log" 2>&1 &
  else
    echo "[ios-full-e2e] server unhealthy — restarting (log: ${ROOT}/.ios-e2e-server.log)"
    IOS_E2E_SKIP_PORT_KILL=1 nohup env PORT="${SERVER_PORT}" bash "$ROOT/scripts/run-server.sh" >>"${ROOT}/.ios-e2e-server.log" 2>&1 &
  fi
  SERVER_PID=$!
  disown "${SERVER_PID}" 2>/dev/null || true
  local elapsed=0
  while (( elapsed < 30 )); do
    if health_ok; then
      echo "[ios-full-e2e] API revived"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

HOST_PID=""
MAC_HOST_PID=""

kill_mac_desktop() {
  # Prefer stopping the mac-host script; its EXIT trap kills only its own app PID.
  # Never pkill -f zig-out/bin/app — that closes concurrent 2× native E2E windows.
  if [[ -n "${MAC_HOST_PID:-}" ]] && kill -0 "${MAC_HOST_PID}" 2>/dev/null; then
    kill "${MAC_HOST_PID}" 2>/dev/null || true
    wait "${MAC_HOST_PID}" 2>/dev/null || true
  fi
  MAC_HOST_PID=""
}

cleanup() {
  if [[ -n "${REPORT_FP_FILE:-}" ]]; then
    rm -f "${REPORT_FP_FILE}"
  fi
  if [[ -n "${HOST_PID:-}" ]]; then
    kill "${HOST_PID}" 2>/dev/null || true
  fi
  kill_mac_desktop
  if [[ -n "${SERVER_PID:-}" ]] && [[ "${STARTED_SERVER:-0}" == "1" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

STARTED_SERVER=0
if [[ "${SOLANA_PER_SEAT}" == "1" ]]; then
  # Always ensure room + localnet even if a leftover static server answers /.
  ensure_server
elif ! health_ok; then
  STARTED_SERVER=1
  ensure_server
fi

if [[ "$SKIP_BUILD" != "1" ]]; then
  ios_sim_build_deps
  echo "[ios-full-e2e] building macOS desktop app (seat 0, zig build — is_ios=false)"
  (cd "$APP_DIR" && zig build)
  echo "[ios-full-e2e] building iOS simulator app (seat 1, build_ios.zig — is_ios=true)"
else
  # Rebuild frontend before syncing into the iOS bundle — mac-host also builds later,
  # but the simulator is installed from this copy and must include latest TS.
  echo "[ios-full-e2e] SKIP_IOS_E2E_BUILD=1 — rebuilding frontend then syncing into app bundle"
  npm --prefix "${APP_DIR}/frontend" run build
  APP_PATH_EARLY="$(ios_sim_find_built_app 2>/dev/null || true)"
  if [[ -n "${APP_PATH_EARLY}" && -d "${APP_DIR}/frontend/dist" ]]; then
    mkdir -p "${APP_PATH_EARLY}/frontend/dist"
    rsync -a "${APP_DIR}/frontend/dist/" "${APP_PATH_EARLY}/frontend/dist/"
  fi
fi
if [[ "$SKIP_BUILD" != "1" ]] || ! ios_sim_find_built_app >/dev/null 2>&1; then
  ios_sim_build_app
fi

APP_PATH="$(ios_sim_find_built_app)"
UDID="$(ios_sim_udid)"

patch_ios_launch_config() {
  local app_path="$1"
  local dist="${app_path}/frontend/dist"
  if [[ -d "$dist" ]]; then
    IOS_E2E_PATCH_API="${API_BASE}" \
    IOS_E2E_PATCH_BACKEND="${E2E_BACKEND}" \
    IOS_E2E_PATCH_DIST="${dist}" \
    IOS_E2E_PATCH_ROOT="${ROOT}" \
    python3 - <<'PY'
import json
import os
from pathlib import Path
api = os.environ["IOS_E2E_PATCH_API"]
backend = os.environ["IOS_E2E_PATCH_BACKEND"]
dist = os.environ["IOS_E2E_PATCH_DIST"]
root = os.environ["IOS_E2E_PATCH_ROOT"]
cfg = {"manualSetup": False, "apiBase": api, "backend": backend, "solanaRpc": "http://127.0.0.1:8899"}
if backend == "solana":
    id_path = Path.home() / ".config" / "solana" / "id.json"
    if id_path.is_file():
        cfg["whitelistAdminSecret"] = json.loads(id_path.read_text())
    table_path = Path(root) / ".local" / "shared-table.json"
    if table_path.is_file():
        table = json.loads(table_path.read_text())
        if table.get("roomSeed") and table.get("tableId") is not None:
            cfg["roomSeed"] = table["roomSeed"]
            cfg["tableId"] = str(table["tableId"])
            if table.get("roomIdHex"):
                cfg["roomIdHex"] = table["roomIdHex"]
content = (
    "window.__SHOWDOWN_WINNER_PREFERENCE_MS = 5000;\n"
    f"window.__ZK_LAUNCH_CONFIG = {json.dumps(cfg)};\n"
)
open(f"{dist}/launch-config.js", "w").write(content)
print(
    f"[ios-full-e2e] patched launch-config.js backend={backend} apiBase={api}"
    f" room={cfg.get('roomSeed')} table={cfg.get('tableId')}"
)
PY
  fi
}

ensure_macos_witness

# Dedicated preview port so we never attach the desktop app to a stale vite instance.
export IOS_E2E_FRONTEND_PORT="${FRONTEND_PORT}"
export E2E_BACKEND
export E2E_API_BASE="$API_BASE"

# Fresh table BEFORE patching iOS launch-config / install — otherwise the sim
# boots with a stale tableId while mac-host uses the post-fresh table.
if [[ "${SOLANA_PER_SEAT}" == "1" ]]; then
  export IOS_E2E_SKIP_RESET=1
  frontend_port="${FRONTEND_PORT}"
  stale_pids="$(lsof -nP -iTCP:"${frontend_port}" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "${stale_pids}" ]]; then
    echo "[ios-full-e2e] freeing stale listeners on :${frontend_port} (pids ${stale_pids})"
    # shellcheck disable=SC2086
    kill ${stale_pids} 2>/dev/null || true
    sleep 0.4
    stale_pids="$(lsof -nP -iTCP:"${frontend_port}" -sTCP:LISTEN -t 2>/dev/null || true)"
    if [[ -n "${stale_pids}" ]]; then
      # shellcheck disable=SC2086
      kill -9 ${stale_pids} 2>/dev/null || true
      sleep 0.2
    fi
  fi
  pkill -f "e2e-workspaces/.*/http-keepalive" 2>/dev/null || true
  echo "[ios-full-e2e] resetting Solana table via solana-player-cli"
  reset_table
else
  export IOS_E2E_SKIP_RESET=1
  echo "[ios-full-e2e] resetting table (once, before both clients connect)"
  reset_table
fi

ios_sim_prepare "$UDID"
xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" 2>/dev/null || true
# Patch after fresh table so roomSeed/tableId match mac-host + on-chain.
patch_ios_launch_config "$APP_PATH"
xcrun simctl install "$UDID" "$APP_PATH"

# Clear stale results from a prior run (simctl uninstall usually does; be explicit).
if container="$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" data 2>/dev/null)"; then
  rm -f "$container/Documents/e2e-results.json"
fi

echo "[ios-full-e2e] launching macOS desktop app as seat 0"
chmod +x "$APP_DIR/scripts/macos-e2e-host-player.sh"
IOS_E2E_PARENT_PID=$$ \
  E2E_API_BASE="$API_BASE" \
  E2E_BACKEND="$E2E_BACKEND" \
  E2E_SKIP_CHAIN_WORKER="${E2E_SKIP_CHAIN_WORKER:-1}" \
  bash "$APP_DIR/scripts/macos-e2e-host-player.sh" &
MAC_HOST_PID=$!

# Wait for frontend assets (Solana: static/Vite; mutations are on-chain).
if [[ "${SOLANA_PER_SEAT}" == "1" ]]; then
  echo "[ios-full-e2e] waiting for frontend at ${API_BASE}/"
  for (( i = 0; i < 90; i++ )); do
    if health_ok; then
      echo "[ios-full-e2e] frontend ready"
      break
    fi
    if ! kill -0 "${MAC_HOST_PID}" 2>/dev/null; then
      echo "[ios-full-e2e] macOS host exited before frontend was ready" >&2
      exit 1
    fi
    sleep 1
  done
  if ! health_ok; then
    echo "[ios-full-e2e] frontend failed to start at ${API_BASE}" >&2
    exit 1
  fi
fi

echo "[ios-full-e2e] waiting for macOS seat 0 to sit (mac host must stay alive)"
mac_ready=0
for (( i = 0; i < 180; i++ )); do
  if ! kill -0 "${MAC_HOST_PID}" 2>/dev/null; then
    echo "[ios-full-e2e] macOS host process exited before seat 0 was ready" >&2
    exit 1
  fi
  if seat_funded 0 50; then
    mac_ready=1
    echo "[ios-full-e2e] macOS seat 0 is seated"
    break
  fi
  sleep 1
done
if [[ "${mac_ready}" -ne 1 ]]; then
  echo "[ios-full-e2e] timed out waiting for macOS seat 0" >&2
  if [[ "${SOLANA_PER_SEAT}" == "1" ]]; then
    echo "[ios-full-e2e] last solana snapshot:" >&2
    solana_snapshot_json | python3 -c "import json,sys; j=json.load(sys.stdin); print({k:j.get(k) for k in ('phase','seats')})" 2>&1 >&2 || true
  fi
  exit 1
fi

echo "[ios-full-e2e] launching simulator app (full game E2E)"
xcrun simctl launch "$UDID" "$BUNDLE_ID" \
  -e E2E_BACKEND "$E2E_BACKEND" \
  -e IOS_E2E_SHUFFLE_TIMEOUT 45 \
  -e IOS_E2E_REGISTER_TIMEOUT 30 \
  -e IOS_E2E_SHOWDOWN_TIMEOUT 120 \
  -e2e_automation -e2e_full_game "$API_BASE" \
  "$(ios_sim_zkey_launch_args)" >/dev/null

echo "[ios-full-e2e] waiting for iOS seat 1 to join table"
ios_joined=0
min_blind_stack="50"
if [[ "${SOLANA_PER_SEAT}" == "1" ]]; then
  min_blind_stack="$(solana_snapshot_json | python3 -c "
import json, sys
j = json.load(sys.stdin)
sb = int(j.get('smallBlind', 25))
print(sb * 2)
" 2>/dev/null || echo "50")"
else
  min_blind_stack="$(curl -sf "$(game_url)" 2>/dev/null | python3 -c "
import json, sys
j = json.load(sys.stdin)
sb = int(j.get('smallBlind', 25))
print(sb * 2)
" 2>/dev/null || echo "50")"
fi
for (( i = 0; i < 120; i++ )); do
  if seat_funded 1 "${min_blind_stack}"; then
    ios_joined=1
    echo "[ios-full-e2e] iOS seat 1 joined"
    break
  fi
  sleep 1
done
if [[ "${ios_joined}" -ne 1 ]]; then
  echo "[ios-full-e2e] timed out waiting for iOS table.join" >&2
  exit 1
fi

echo "[ios-full-e2e] starting hand (both clients ready)"
start_hand

REPORT_FP_FILE="$(mktemp)"

elapsed=0
health_retries=0
MAC_HOST_WARNED=0
while (( elapsed < POLL_SECONDS )); do
  if [[ -n "${MAC_HOST_PID:-}" ]] && ! kill -0 "${MAC_HOST_PID}" 2>/dev/null; then
    if [[ "${MAC_HOST_WARNED}" -eq 0 ]]; then
      echo "[ios-full-e2e] macOS host process exited (desktop app may still be running)" >&2
      MAC_HOST_WARNED=1
      MAC_HOST_PID=""
    fi
  fi
  if ! health_ok; then
    health_retries=$((health_retries + 1))
    if try_revive_server; then
      health_retries=0
      continue
    fi
    if (( health_retries >= 5 )); then
      echo "[ios-full-e2e] API at ${API_BASE} is not responding" >&2
      exit 1
    fi
    sleep 2
    continue
  fi
  health_retries=0
  if container="$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" data 2>/dev/null)"; then
    results="$container/Documents/e2e-results.json"
    if [[ -f "$results" ]]; then
      set +e
      python3 - <<PY
import hashlib, json, os, sys
results_path = ${results@Q}
fp_path = ${REPORT_FP_FILE@Q}
with open(results_path) as f:
    report = json.load(f)
fp = hashlib.sha256(json.dumps(report, sort_keys=True).encode()).hexdigest()
last = ""
if os.path.isfile(fp_path):
    with open(fp_path) as f:
        last = f.read().strip()
if fp == last:
    sys.exit(4)
with open(fp_path, "w") as f:
    f.write(fp)
progress = report.get("progress") or ""
for case in report.get("cases", []):
    status = "PASS" if case.get("ok") else "FAIL"
    print(f"[ios-full-e2e] {status} {case.get('name')}: {case.get('detail', '')}")
if not report.get("complete"):
    suffix = f" — {progress}" if progress else ""
    print(f"[ios-full-e2e] partial report ({len(report.get('cases', []))} cases){suffix}, waiting for complete...")
    sys.exit(2)
passed = bool(report.get("passed"))
names = {c.get("name") for c in report.get("cases", [])}
if "hand.register" not in names and "native.shuffle.prove.mac_wtns" in names:
    print("[ios-full-e2e] stale native-shuffle results — full-game WebView runner did not finish", file=sys.stderr)
    sys.exit(1)
print(f"[ios-full-e2e] overall passed={passed}")
sys.exit(0 if passed else 1)
PY
      py_exit=$?
      set -e
      if [[ "$py_exit" -eq 0 ]]; then
        exit 0
      elif [[ "$py_exit" -eq 4 ]]; then
        :
      elif [[ "$py_exit" -eq 2 ]]; then
        :
      else
        exit 1
      fi
    fi
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

echo "[ios-full-e2e] timed out after ${POLL_SECONDS}s waiting for e2e-results.json" >&2
exit 1
