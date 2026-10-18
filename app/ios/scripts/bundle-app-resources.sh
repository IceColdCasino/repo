#!/usr/bin/env bash
# Bundle frontend dist, witness dylibs, zkeys, and testdata into the iOS app.
# Simulator: omit zkey/ (installd rejects symlinks); pass -e2e_zkey_root at launch.
# Device: copy required zkeys into the app bundle.
set -euo pipefail

DIST_SRC="${SRCROOT}/../frontend/dist"
APP_BUNDLE="${TARGET_BUILD_DIR}/${WRAPPER_NAME}"
DIST_DST="${APP_BUNDLE}/frontend/dist"

if [[ ! -d "${DIST_SRC}" ]]; then
  echo "error: frontend dist missing at ${DIST_SRC} — build on the host: cd app/frontend && npx vite build" >&2
  exit 1
fi
mkdir -p "${DIST_DST}"
rsync -a "${DIST_SRC}/" "${DIST_DST}/"

FRAMEWORKS_SRC="${SRCROOT}/Frameworks"
FRAMEWORKS_DST="${APP_BUNDLE}/Frameworks"
if [[ -d "${FRAMEWORKS_SRC}" ]]; then
  mkdir -p "${FRAMEWORKS_DST}"
  rsync -a "${FRAMEWORKS_SRC}/" "${FRAMEWORKS_DST}/"
  chmod +x "${FRAMEWORKS_DST}"/*.dylib 2>/dev/null || true
  # Large witness dylibs (e.g. libzkcasino-poker ~69MB) fail dlopen unsigned on simulator.
  for dylib in "${FRAMEWORKS_DST}"/*.dylib; do
    [[ -f "${dylib}" ]] || continue
    codesign -f -s - "${dylib}" 2>/dev/null || true
  done
fi

ZKEY_REPO="${SRCROOT}/../../zkey"
ZKEY_DST="${APP_BUNDLE}/zkey"
rm -rf "${ZKEY_DST}"

ZKEY_NAMES=(
  register_main
  shuffle_1_deck_52_main
  poker_share_hashout_main
  poker_showdown_hashout_main
)

if [[ "${EFFECTIVE_PLATFORM_NAME:-}" == "-iphonesimulator" ]] || [[ "${PLATFORM_NAME:-}" == "iphonesimulator" ]]; then
  echo "[bundle] simulator: skipping zkey/ (use -e2e_zkey_root=\$REPO at launch)"
else
  echo "[bundle] device: copying zkeys into app bundle"
  mkdir -p "${ZKEY_DST}"
  for name in "${ZKEY_NAMES[@]}"; do
    src="${ZKEY_REPO}/${name}_0001.zkey"
    if [[ -f "${src}" ]]; then
      cp "${src}" "${ZKEY_DST}/"
    else
      echo "warning: missing zkey ${src}" >&2
    fi
  done
fi

TESTDATA_SRC="${SRCROOT}/testdata"
TESTDATA_DST="${APP_BUNDLE}/testdata"
if [[ -d "${TESTDATA_SRC}" ]]; then
  mkdir -p "${TESTDATA_DST}"
  rsync -a "${TESTDATA_SRC}/" "${TESTDATA_DST}/"
fi
