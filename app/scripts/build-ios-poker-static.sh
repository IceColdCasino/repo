#!/usr/bin/env bash
# Build static poker witness (share + showdown) for linking into ios-lib (no dlopen).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_DIR="$ROOT/app"
LIBZK="$ROOT/libzkcasino"
WORK="$APP_DIR/.build-ios-witness"
OUT="$APP_DIR/ios/Libraries/libpoker_witness.a"
TARGET="${IOS_WITNESS_TARGET:-aarch64-ios-simulator}"
IOS_ZIG_OUT="$LIBZK/${IOS_WITNESS_PREFIX:-zig-out-ios-simulator}"
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
MIN_IOS="15.0"
GMP_A="$ROOT/rapidsnark/lib/ios-simulator/lib/libgmp.a"
IOS_LIB="$ROOT/rapidsnark/lib/ios-simulator/lib"

need_rebuild() {
  if [[ "${FORCE_IOS_POKER_STATIC_REBUILD:-0}" == "1" ]]; then return 0; fi
  if [[ ! -f "$OUT" ]]; then return 0; fi
  if [[ "$OUT" -ot "$LIBZK/src/zig/witness_api_poker_prefixed.zig" ]]; then return 0; fi
  if [[ "$OUT" -ot "$APP_DIR/scripts/build-ios-poker-static.sh" ]]; then return 0; fi
  return 1
}

if ! need_rebuild; then
  echo "[ios-poker-static] $OUT is up to date"
  exit 0
fi

if [[ ! -f "$IOS_ZIG_OUT/lib/libzkcasino-poker.a" ]]; then
  echo "[ios-poker-static] building iOS witness archives first..."
  bash "$APP_DIR/scripts/build-ios-witness.sh"
fi

OBJ_DIR="$WORK/poker-static"
rm -rf "$OBJ_DIR"
mkdir -p "$OBJ_DIR" "$(dirname "$OUT")"

echo "[ios-poker-static] compiling prefixed poker witness zcu"
(
  cd "$LIBZK"
  zig build-obj -OReleaseFast -target "$TARGET" -mcpu baseline -fPIC \
    -Mroot=src/zig/witness_api_poker_prefixed.zig \
    --name witness_api_poker_prefixed
  mv witness_api_poker_prefixed.o "$OBJ_DIR/"
)

echo "[ios-poker-static] extracting share + showdown circuit objects"
(
  cd "$OBJ_DIR"
  for member in \
    poker_share_poker_share.o poker_share_calcwit.o poker_share_main_bridge.o \
    poker_showdown_poker_showdown.o poker_showdown_calcwit.o poker_showdown_main_bridge.o; do
    ar x "$IOS_ZIG_OUT/lib/libzkcasino-poker.a" "$member"
    chmod u+rwx "$member"
  done
)

OBJCOPY="${IOS_WITNESS_OBJCOPY:-/opt/homebrew/opt/llvm/bin/llvm-objcopy}"
if [[ ! -x "$OBJCOPY" ]]; then
  echo "[ios-poker-static] error: llvm-objcopy required (tried $OBJCOPY)" >&2
  exit 1
fi
# Apple ld no longer honors -multiply_defined suppress; localize identical
# unprefixed calcwit exports in the secondary circuit object instead.
for sym in \
  _zkcasino_calcwit_reset_cpp_ctx \
  _zkcasino_calcwit_delete_cpp_ctx \
  _zkcasino_calcwit_get_zig_ctx \
  _zkcasino_calcwit_get_witness_cpp \
  __Z5fnv1aNSt3__112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEE
do
  "$OBJCOPY" --localize-symbol="$sym" "$OBJ_DIR/poker_showdown_calcwit.o"
done

if ! nm "$OBJ_DIR/poker_showdown_main_bridge.o" 2>/dev/null | rg -q "_poker_showdown_loadCircuitFromData"; then
  echo "[ios-poker-static] error: missing showdown symbols" >&2
  exit 1
fi

echo "[ios-poker-static] archiving $OUT"
# Keep circuit objects separate so private_extern entry points stay linkable.
libtool -static -o "$OUT" \
  "$OBJ_DIR/witness_api_poker_prefixed.o" \
  "$OBJ_DIR/poker_share_poker_share.o" \
  "$OBJ_DIR/poker_share_calcwit.o" \
  "$OBJ_DIR/poker_share_main_bridge.o" \
  "$OBJ_DIR/poker_showdown_poker_showdown.o" \
  "$OBJ_DIR/poker_showdown_calcwit.o" \
  "$OBJ_DIR/poker_showdown_main_bridge.o"
echo "[ios-poker-static] installed $(ls -lh "$OUT" | awk '{print $5, $9}')"
