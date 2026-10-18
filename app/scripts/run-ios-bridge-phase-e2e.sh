#!/usr/bin/env bash
# iOS native bridge single-phase E2E (prove via C bridge, verify on game server).
#
# Usage:
#   bash app/scripts/run-ios-bridge-phase-e2e.sh register_p0
#   IOS_E2E_POLL_SECONDS=45 bash app/scripts/run-ios-bridge-phase-e2e.sh shuffle_p0
set -euo pipefail

PHASE_NAME="${1:?usage: run-ios-bridge-phase-e2e.sh <phase_name> e.g. register_p0}"
source "$(dirname "$0")/ios-simulator-common.sh"
ios_sim_init_paths

API_BASE="${E2E_API_BASE:-http://127.0.0.1:3847}"
if [[ "$PHASE_NAME" == *showdown* ]]; then
  PHASE_TIMEOUT="${IOS_E2E_SHOWDOWN_TIMEOUT:-120}"
elif [[ "$PHASE_NAME" == *share* ]]; then
  PHASE_TIMEOUT="${IOS_E2E_SHARE_TIMEOUT:-60}"
else
  PHASE_TIMEOUT="${IOS_E2E_PHASE_TIMEOUT:-30}"
fi
POLL_SECONDS="${IOS_E2E_POLL_SECONDS:-$((PHASE_TIMEOUT + 15))}"
SKIP_BUILD="${SKIP_IOS_E2E_BUILD:-0}"

echo "[ios-bridge-phase] phase=${PHASE_NAME} api=${API_BASE} prove_timeout=${PHASE_TIMEOUT}s poll=${POLL_SECONDS}s"

health_ok() {
  curl -sf "${API_BASE}/api/health?backend=local" >/dev/null 2>&1
}

if ! health_ok; then
  echo "[ios-bridge-phase] starting game server..."
  PORT=3847 nohup bash "$ROOT/scripts/run-server.sh" >>"${ROOT}/.ios-bridge-phase-server.log" 2>&1 &
  for (( i = 0; i < 60; i++ )); do
    health_ok && break
    sleep 1
  done
  health_ok || { echo "[ios-bridge-phase] server failed to start" >&2; exit 1; }
fi

CHECKPOINT="${APP_DIR}/testdata/bridge-chain/checkpoints/ios/${PHASE_NAME}.json"
if [[ "${BRIDGE_CHAIN_FORCE:-0}" != "1" ]] && [[ -f "${CHECKPOINT}" ]]; then
  if python3 -c "import json,sys; c=json.load(open(sys.argv[1])); sys.exit(0 if c.get('passed') and c.get('verified') else 1)" "${CHECKPOINT}" 2>/dev/null; then
    echo "[ios-bridge-phase] skip ${PHASE_NAME} (checkpoint passed)"
    exit 0
  fi
fi

if [[ "$SKIP_BUILD" != "1" ]]; then
  ios_sim_build_deps
fi
if [[ "$SKIP_BUILD" != "1" ]] || ! ios_sim_find_built_app >/dev/null 2>&1; then
  ios_sim_build_app
fi

APP_PATH="$(ios_sim_find_built_app)"
UDID="$(ios_sim_udid)"
DIST="${APP_PATH}/frontend/dist"
if [[ -d "$DIST" ]]; then
  printf 'window.__ZK_LAUNCH_CONFIG = { manualSetup: false, apiBase: %s };\n' \
    "$(python3 -c "import json; print(json.dumps('${API_BASE}'))")" > "${DIST}/launch-config.js"
fi
ios_sim_prepare "$UDID"
xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP_PATH"

if container="$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" data 2>/dev/null)"; then
  rm -f "$container/Documents/e2e-results.json" "$container/Documents/bridge-phase-artifact.json"
fi

echo "[ios-bridge-phase] launching -e2e_bridge_phase ${PHASE_NAME}"
LAUNCH_ENV=( -e IOS_E2E_SHUFFLE_TIMEOUT "$PHASE_TIMEOUT" -e IOS_E2E_REGISTER_TIMEOUT "$PHASE_TIMEOUT" )
if [[ "$PHASE_NAME" == *showdown* ]]; then
  LAUNCH_ENV+=( -e IOS_E2E_SHOWDOWN_TIMEOUT "$PHASE_TIMEOUT" )
elif [[ "$PHASE_NAME" == *share* ]]; then
  LAUNCH_ENV+=( -e IOS_E2E_SHARE_TIMEOUT "$PHASE_TIMEOUT" )
fi
xcrun simctl launch "$UDID" "$BUNDLE_ID" \
  "${LAUNCH_ENV[@]}" \
  -e2e_automation -e2e_bridge_phase "$PHASE_NAME" \
  "$(ios_sim_zkey_launch_args)" >/dev/null

elapsed=0
last_log=0
while (( elapsed < POLL_SECONDS )); do
  if container="$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" data 2>/dev/null)"; then
    results="$container/Documents/e2e-results.json"
    artifact="$container/Documents/bridge-phase-artifact.json"
    if [[ -f "$results" ]]; then
      if ! python3 -c "import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if r.get('complete',True) else 2)" "$results" 2>/dev/null; then
        sleep 1
        elapsed=$((elapsed + 1))
        continue
      fi
      if ! python3 -c "import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if r.get('passed') else 1)" "$results" 2>/dev/null; then
        echo "[ios-bridge-phase] native prove failed — see $results" >&2
        cat "$results" >&2
        exit 1
      fi
      if [[ ! -f "$artifact" ]]; then
        echo "[ios-bridge-phase] missing bridge-phase-artifact.json" >&2
        exit 1
      fi
      mkdir -p "$(dirname "$CHECKPOINT")"
      python3 - <<PY
import json, urllib.request
artifact_path = ${artifact@Q}
checkpoint_path = ${CHECKPOINT@Q}
api_base = ${API_BASE@Q}
phase_name = ${PHASE_NAME@Q}
with open(artifact_path) as f:
    art = json.load(f)
proof = art.get("proof")
signals = art.get("publicSignals")
circuit = art.get("circuitName")
if not circuit:
    with open(artifact_path.replace("bridge-phase-artifact", "e2e-results")) as rf:
        pass
payload_path = f"${APP_DIR}/ios/testdata/bridge-chain/{phase_name}_payload.json"
with open(payload_path) as pf:
    payload = json.load(pf)
    circuit = payload["circuitName"]
if not proof or not signals:
    raise SystemExit("artifact missing proof/publicSignals")
body = json.dumps({"circuitName": circuit, "proof": proof, "publicSignals": signals}).encode()
req = urllib.request.Request(
    api_base.rstrip("/") + "/api/zk/verify",
    data=body,
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req) as res:
    verified = json.load(res).get("valid") is True
if not verified:
    raise SystemExit("server verify failed")
manifest_path = "${APP_DIR}/ios/testdata/bridge-chain/manifest.json"
meta = json.load(open(manifest_path))["phases"][phase_name]
checkpoint = {
    "platform": "ios",
    "phase": phase_name.split("_")[0],
    "playerIndex": meta["playerIndex"],
    "circuitName": circuit,
    "passed": True,
    "verified": True,
    "at": art.get("at"),
    "proof": proof,
    "publicSignals": signals,
}
with open(checkpoint_path, "w") as f:
    json.dump(checkpoint, f, indent=2)
print(f"[ios-bridge-phase] PASS {phase_name} verified on server")
PY
      exit 0
    fi
  fi
  if (( elapsed - last_log >= 5 )); then
    last_log=$elapsed
    echo "[ios-bridge-phase] waiting… ${elapsed}s / ${POLL_SECONDS}s"
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

echo "[ios-bridge-phase] timed out after ${POLL_SECONDS}s" >&2
exit 1
