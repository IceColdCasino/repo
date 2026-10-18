#!/usr/bin/env bash
# macOS desktop seat 0 for iOS simulator full-game E2E.
# Serves built frontend over HTTP — WKWebView runs modules reliably vs zero:// chunks.
#
# Solana (default E2E_SKIP_CHAIN_WORKER=1): static frontend + in-WebView executePerSeatOp → RPC.
#   Seat / phase polls use solana-player-cli (not Vite /api/game — that proxies to Bun :3847).
# Local Bun (:3847) or optional :3850 chain worker: HTTP table API.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_DIR="$ROOT/app"
BINARY="$APP_DIR/zig-out/bin/app"
E2E_BACKEND="${E2E_BACKEND:-local}"
FRONTEND_PORT="${IOS_E2E_FRONTEND_PORT:-5178}"
# Per-seat when Solana and no :3850 worker — independent of E2E_API_BASE (parent
# always sets that to the frontend origin, which previously skipped this flag).
SOLANA_PER_SEAT=0
if [[ "${E2E_BACKEND}" == "solana" && "${E2E_SKIP_CHAIN_WORKER:-1}" == "1" ]]; then
  SOLANA_PER_SEAT=1
fi
if [[ "${E2E_BACKEND}" == "solana" ]]; then
  if [[ -n "${E2E_API_BASE:-}" ]]; then
    API_BASE="${E2E_API_BASE}"
  elif [[ "${SOLANA_PER_SEAT}" == "1" ]]; then
    API_BASE="http://127.0.0.1:${FRONTEND_PORT}"
  else
    API_BASE="http://127.0.0.1:3850"
  fi
  GAME_ID="solana-local-table"
else
  API_BASE="${E2E_API_BASE:-http://127.0.0.1:3847}"
  GAME_ID="local-table"
fi
HOST_SEAT=0
WORKSPACE="${APP_DIR}/e2e-workspaces/ios-mac-host-seat-0"
POLL_MS=400
PARENT_PID="${IOS_E2E_PARENT_PID:-$PPID}"

HOST_ZK_PID=""
MAC_APP_PID=""
VITE_PID=""
KEY_SERVER_PID=""
STATIC_PID=""

solana_player_cli() {
  (cd "${ROOT}" && bun run scripts/solana-player-cli.ts "$@")
}

solana_snapshot_json() {
  solana_player_cli snapshot 2>/dev/null \
    | bun -e "const lines=(await Bun.stdin.text()).trim().split(/\n/).filter(Boolean); const line=lines.reverse().find(l=>l.startsWith('{'))??'{}'; process.stdout.write(line);"
}

kill_host_zk() {
  if [[ -n "${HOST_ZK_PID}" ]] && kill -0 "${HOST_ZK_PID}" 2>/dev/null; then
    kill "${HOST_ZK_PID}" 2>/dev/null || true
    wait "${HOST_ZK_PID}" 2>/dev/null || true
  fi
  HOST_ZK_PID=""
}

kill_mac_app() {
  if [[ -n "${MAC_APP_PID}" ]] && kill -0 "${MAC_APP_PID}" 2>/dev/null; then
    kill "${MAC_APP_PID}" 2>/dev/null || true
    wait "${MAC_APP_PID}" 2>/dev/null || true
  fi
  MAC_APP_PID=""
  # Do NOT pkill -f zig-out/bin/app — that kills concurrent 2× native E2E windows.
}

cleanup() {
  kill_host_zk
  kill_mac_app
  if [[ -n "${VITE_PID}" ]]; then
    kill "${VITE_PID}" 2>/dev/null || true
  fi
  if [[ -n "${STATIC_PID}" ]]; then
    kill "${STATIC_PID}" 2>/dev/null || true
  fi
  if [[ -n "${KEY_SERVER_PID}" ]]; then
    kill "${KEY_SERVER_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

game_path() {
  if [[ "${E2E_BACKEND}" == "solana" ]]; then
    echo "/api/game"
  else
    echo "/api/games/${GAME_ID}?backend=local"
  fi
}

post_json() {
  local path="$1"
  local body="${2:-}"
  local url
  if [[ "${E2E_BACKEND}" == "solana" ]]; then
    url="${API_BASE}${path}"
  else
    url="${API_BASE}${path}?backend=local"
  fi
  local args=(-sf -X POST "${url}" -H "Content-Type: application/json")
  if [[ -n "${body}" ]]; then
    args+=(-d "${body}")
  fi
  curl "${args[@]}"
}

poll_game() {
  local label="$1"
  local timeout_ms="$2"
  local check_py="$3"
  if [[ "${SOLANA_PER_SEAT}" == "1" ]]; then
    python3 -c "
import json, subprocess, sys, time
root = ${ROOT@Q}
deadline = time.time() + ${timeout_ms} / 1000.0
last = None
while time.time() < deadline:
    try:
        raw = subprocess.check_output(
            ['bun', 'run', 'scripts/solana-player-cli.ts', 'snapshot'],
            cwd=root, stderr=subprocess.DEVNULL, text=True, timeout=30,
        )
        line = next((l for l in reversed(raw.strip().splitlines()) if l.startswith('{')), '{}')
        last = json.loads(line)
        if ${check_py}:
            sys.exit(0)
    except Exception:
        last = None
    time.sleep(${POLL_MS} / 1000.0)
phase = last.get('phase') if last else 'unknown'
seats = len(last.get('seats') or []) if last else 0
escrowed = 0
if last:
    escrowed = sum(1 for s in (last.get('seats') or []) if int(s.get('seatEscrow') or s.get('chips') or 0) > 0)
print(f'[mac-host] ${label} timed out (last phase={phase}, seats={seats}, escrowed={escrowed})', file=sys.stderr)
sys.exit(1)
"
    return
  fi
  local snap_path
  snap_path="$(game_path)"
  python3 -c "
import json, sys, time, urllib.request
api = ${API_BASE@Q}
path = ${snap_path@Q}
deadline = time.time() + ${timeout_ms} / 1000.0
last = None
while time.time() < deadline:
    try:
        with urllib.request.urlopen(f'{api}{path}', timeout=5) as res:
            last = json.load(res)
        if ${check_py}:
            sys.exit(0)
    except Exception:
        last = None
    time.sleep(${POLL_MS} / 1000.0)
phase = last.get('phase') if last else 'unknown'
seats = len(last.get('seats') or []) if last else 0
print(f'[mac-host] ${label} timed out (last phase={phase}, seats={seats})', file=sys.stderr)
sys.exit(1)
"
}

ensure_mac_app() {
  if [[ ! -f "${APP_DIR}/frontend/dist/index.html" ]]; then
    echo "[mac-host] building frontend..."
    npm --prefix "${APP_DIR}/frontend" run build
  else
    echo "[mac-host] rebuilding frontend (E2E bundle pick up latest TS)"
    npm --prefix "${APP_DIR}/frontend" run build
  fi
  if [[ ! -x "${BINARY}" ]] || [[ "${ZK_FORCE_NATIVE_REBUILD:-}" == "1" ]]; then
    echo "[mac-host] building macOS native app..."
    (cd "${APP_DIR}" && zig build)
  fi
}

echo "[mac-host] backend: ${E2E_BACKEND} api base: ${API_BASE}"
ensure_mac_app
mkdir -p "${WORKSPACE}"

# Stale python http.server / keepalive from run-two-native-players can hold :5178
# without /api/* — Vite then bounces to another port and seat join never works.
free_frontend_port() {
  local port="$1"
  local pids
  pids="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -z "${pids}" ]]; then
    return 0
  fi
  echo "[mac-host] freeing stale listeners on :${port} (pids ${pids})"
  # shellcheck disable=SC2086
  kill ${pids} 2>/dev/null || true
  sleep 0.4
  pids="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    # shellcheck disable=SC2086
    kill -9 ${pids} 2>/dev/null || true
    sleep 0.2
  fi
}
# Also stop leftover keepalive loops that would immediately rebind a static server.
pkill -f "e2e-workspaces/.*/http-keepalive" 2>/dev/null || true
free_frontend_port "${FRONTEND_PORT}"
if [[ "${E2E_BACKEND}" == "solana" ]]; then
  free_frontend_port 5179
fi

echo "[mac-host] writing launch-config.js (backend=${E2E_BACKEND} perSeat=${SOLANA_PER_SEAT})"
python3 - <<PY
import json
import os
from pathlib import Path
api = ${API_BASE@Q}
backend = ${E2E_BACKEND@Q}
dist = Path(${APP_DIR@Q}) / "frontend" / "dist"
root = Path(${ROOT@Q})
rpc = os.environ.get("SOLANA_RPC_URL") or os.environ.get("ZK_LAUNCH_SOLANA_RPC") or "http://127.0.0.1:8899"
offset_raw = os.environ.get("ARCIUM_CLUSTER_OFFSET") or os.environ.get("ZK_LAUNCH_CLUSTER_OFFSET")
loopback = "127.0.0.1" in rpc or "localhost" in rpc
cfg = {
    "manualSetup": True,
    "seat": 0,
    "autoPlay": True,
    "apiBase": api,
    "backend": backend,
    "solanaRpc": rpc,
    "clusterOffset": int(offset_raw) if offset_raw else (0 if loopback else 456),
}
def load_key(path):
    p = Path(path)
    if not p.is_file():
        return None
    data = json.loads(p.read_text())
    return data if isinstance(data, list) else None

if backend == "solana":
    admin_path = os.environ.get("WHITELIST_ADMIN_KEYPAIR") or str(Path.home() / ".config" / "solana" / "whitelist-admin.json")
    payer_path = os.environ.get("MXE_AUTHORITY_KEYPAIR") or str(Path.home() / ".config" / "solana" / "id.json")
    admin = load_key(admin_path)
    payer = load_key(payer_path)
    if admin is not None:
        cfg["whitelistAdminSecret"] = admin
    if payer is not None:
        cfg["feePayerSecret"] = payer
    table_path = root / ".local" / "shared-table.json"
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
(dist / "launch-config.js").write_text(content)
print("[mac-host] launch-config roomSeed=", cfg.get("roomSeed"), "tableId=", cfg.get("tableId"))
PY

# Solana per-seat: durable static server (same as two-native). Vite /api proxies to Bun :3847.
if [[ "${SOLANA_PER_SEAT}" == "1" ]]; then
  echo "[mac-host] starting static frontend on port ${FRONTEND_PORT}"
  (
    cd "${APP_DIR}/frontend/dist"
    exec python3 -m http.server "${FRONTEND_PORT}" --bind 127.0.0.1
  ) >>"${WORKSPACE}/vite-preview.log" 2>&1 &
  STATIC_PID=$!
else
  echo "[mac-host] starting vite preview on port ${FRONTEND_PORT}"
  npm --prefix "${APP_DIR}/frontend" run preview -- --host 127.0.0.1 --port "${FRONTEND_PORT}" --strictPort >>"${WORKSPACE}/vite-preview.log" 2>&1 &
  VITE_PID=$!
fi
preview_ready=0
for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:${FRONTEND_PORT}/" >/dev/null 2>&1; then
    preview_ready=1
    break
  fi
  serve_pid="${STATIC_PID:-${VITE_PID:-}}"
  if [[ -n "${serve_pid}" ]] && ! kill -0 "${serve_pid}" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
if [[ "${preview_ready}" -ne 1 ]]; then
  echo "[mac-host] frontend failed on port ${FRONTEND_PORT}" >&2
  tail -30 "${WORKSPACE}/vite-preview.log" >&2 || true
  exit 1
fi
echo "[mac-host] frontend ready on http://127.0.0.1:${FRONTEND_PORT}/"

echo "[mac-host] serving E2E seat-0 hand key on port 5179 (fallback)"
rm -f "${WORKSPACE}/seat0-hand-key.json" "${APP_DIR}/frontend/dist/seat0-hand-key.json" "${APP_DIR}/frontend/dist/prove-result.json"
python3 -m http.server 5179 --bind 127.0.0.1 --directory "${WORKSPACE}" >>"${WORKSPACE}/key-server.log" 2>&1 &
KEY_SERVER_PID=$!

if [[ "${IOS_E2E_SKIP_RESET:-0}" != "1" ]]; then
  echo "[mac-host] resetting table"
  if [[ "${SOLANA_PER_SEAT}" == "1" ]]; then
    # No resetTable in per-seat path — orchestrator should have ensure-room --fresh.
    E2E_FRESH_TABLE=1 solana_player_cli ensure-room --fresh >/dev/null || true
  else
    post_json "/api/admin/reset" >/dev/null
  fi
else
  echo "[mac-host] skipping table reset (orchestrator already reset)"
fi

echo "[mac-host] launching desktop app seat ${HOST_SEAT} (preview http://127.0.0.1:${FRONTEND_PORT})"
MAC_APP_LOG="${WORKSPACE}/mac-app.log"
: > "${MAC_APP_LOG}"

# Match run-two-native-players: per-seat HTML + ZK_LAUNCH_* so Zig merges
# manualSetup/autoPlay into index-seat-N.html (cwd must be APP_DIR for that write).
# nohup+disown: survive SIGHUP if the orchestrator job tears down.
ENCODED_API_BASE="$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "${API_BASE}")"
E2E_NONCE="${E2E_NONCE:-$(date +%s)}"
FRONTEND_URL_QUERY="nativeE2e=1&e2eAutoPlay=1&backend=${E2E_BACKEND}&apiBase=${ENCODED_API_BASE}&noChainWorker=1&e2eNonce=${E2E_NONCE}&e2eSeat=${HOST_SEAT}"
if [[ "${E2E_BACKEND}" == "solana" && -f "${ROOT}/.local/shared-table.json" ]]; then
  TABLE_Q="$(python3 -c "
import json, urllib.parse
from pathlib import Path
t = json.loads(Path(r'''${ROOT}/.local/shared-table.json''').read_text())
parts = []
if t.get('roomSeed'):
    parts.append('roomSeed=' + urllib.parse.quote(str(t['roomSeed']), safe=''))
if t.get('tableId') is not None:
    parts.append('tableId=' + urllib.parse.quote(str(t['tableId']), safe=''))
if t.get('roomIdHex'):
    parts.append('roomIdHex=' + urllib.parse.quote(str(t['roomIdHex']), safe=''))
print('&'.join(parts))
")"
  if [[ -n "${TABLE_Q}" ]]; then
    FRONTEND_URL_QUERY="${FRONTEND_URL_QUERY}&${TABLE_Q}"
  fi
fi
FRONTEND_URL="http://127.0.0.1:${FRONTEND_PORT}/index-seat-${HOST_SEAT}.html?${FRONTEND_URL_QUERY}"

launch_mac_app() {
  cd "${APP_DIR}"
  ZERO_NATIVE_FRONTEND_URL="${FRONTEND_URL}" ZK_REPO_ROOT="${ROOT}" \
    ZK_LAUNCH_MANUAL_SETUP=1 ZK_LAUNCH_SEAT="${HOST_SEAT}" ZK_LAUNCH_AUTO_PLAY=1 \
    ZK_LAUNCH_BACKEND="${E2E_BACKEND}" ZK_LAUNCH_API_BASE="${API_BASE}" \
    env -u ZK_E2E_PROVE_RESULT_FILE -u E2E_FRESH_TABLE -u PER_SEAT_FRESH_TABLE \
    nohup "${BINARY}" >>"${MAC_APP_LOG}" 2>&1 &
  MAC_APP_PID=$!
  disown "${MAC_APP_PID}" 2>/dev/null || true
}

launch_mac_app
for attempt in 1 2; do
  sleep 5
  if kill -0 "${MAC_APP_PID}" 2>/dev/null; then
    break
  fi
  echo "[mac-host] desktop app exited early (attempt ${attempt})" >&2
  tail -n 40 "${MAC_APP_LOG}" >&2 || true
  if [[ "${attempt}" -eq 2 ]]; then
    exit 1
  fi
  echo "[mac-host] retrying desktop app launch"
  launch_mac_app
done

echo "[mac-host] waiting for desktop seat ${HOST_SEAT} to sit"
# Solana: require seatEscrow > 0 (join + faucet transfer). Local: chips >= 50.
if [[ "${SOLANA_PER_SEAT}" == "1" ]]; then
  SEAT0_READY_CHECK="any((s.get('seat') == ${HOST_SEAT} and int(s.get('seatEscrow') or s.get('chips') or 0) > 0) for s in (last or {}).get('seats') or [])"
else
  SEAT0_READY_CHECK="any((s.get('seat') == ${HOST_SEAT} and int(s.get('chips', 0)) >= 50) for s in (last or {}).get('seats') or [])"
fi
until poll_game "seat ${HOST_SEAT} ready" 120000 "${SEAT0_READY_CHECK}"; do
  if ! kill -0 "${MAC_APP_PID}" 2>/dev/null; then
    echo "[mac-host] desktop app died while waiting for seat ${HOST_SEAT}" >&2
    tail -n 40 "${MAC_APP_LOG}" >&2 || true
    exit 1
  fi
  echo "[mac-host] seat ${HOST_SEAT} not seated yet (native bootstrap may still be running), retrying..."
done
if ! kill -0 "${MAC_APP_PID}" 2>/dev/null; then
  echo "[mac-host] desktop app exited right after seat ${HOST_SEAT} funded — cannot drive Register" >&2
  exit 1
fi
echo "[mac-host] seat ${HOST_SEAT} is seated (app pid ${MAC_APP_PID} alive)"

if [[ "${SOLANA_PER_SEAT}" == "1" ]]; then
  lobby="$(solana_snapshot_json)"
else
  lobby="$(curl -sf "${API_BASE}$(game_path)")"
fi
min_blind_stack="$(echo "${lobby}" | python3 -c "
import json, sys
j = json.load(sys.stdin)
sb = int(j.get('smallBlind', 25))
print(sb * 2)
")"

echo "[mac-host] waiting for seat 1 (iOS simulator joins after seat 0)"
if [[ "${SOLANA_PER_SEAT}" == "1" ]]; then
  SEAT1_READY_CHECK="any((s.get('seat') == 1 and int(s.get('seatEscrow') or s.get('chips') or 0) >= ${min_blind_stack}) for s in (last or {}).get('seats') or [])"
else
  SEAT1_READY_CHECK="len((last or {}).get('seats') or []) >= 2 and any((s.get('seat') == 1 and int(s.get('chips', 0)) >= ${min_blind_stack}) for s in (last or {}).get('seats') or [])"
fi
until poll_game "seat 1 ready" 120000 "${SEAT1_READY_CHECK}"; do
  echo "[mac-host] seat 1 not ready yet (simulator may still be joining), retrying..."
done
echo "[mac-host] seat 1 is seated"

if [[ "${E2E_BACKEND}" != "solana" ]]; then
  echo "[mac-host] both seats ready — starting showdown watch (native desktop + iOS drive register/shuffle/share)"
  E2E_API_BASE="${API_BASE}" E2E_HOST_ZK_LOG_PREFIX="[mac-host-zk]" E2E_HOST_ZK_START_AT=showdown-watch \
    bun "${APP_DIR}/scripts/e2e-host-seat0-zk.ts" >>"${WORKSPACE}/host-zk.log" 2>&1 &
  HOST_ZK_PID=$!
else
  echo "[mac-host] Solana mode — desktop + iOS drive ZK via native bridge (executePerSeatOp → RPC)"
fi

echo "[mac-host] keeping desktop app alive until parent exits"
while kill -0 "${MAC_APP_PID}" 2>/dev/null; do
  if ! kill -0 "${PARENT_PID}" 2>/dev/null; then
    echo "[mac-host] parent process ${PARENT_PID} exited — stopping desktop app"
    kill_mac_app
    break
  fi
  sleep 2
done
if [[ -n "${MAC_APP_PID}" ]] && ! kill -0 "${MAC_APP_PID}" 2>/dev/null; then
  echo "[mac-host] desktop app exited before parent finished" >&2
fi
echo "[mac-host] desktop host finished"
