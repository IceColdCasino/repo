#!/usr/bin/env bash
# Cross-compile libzkcasino witness dylibs for iOS Simulator and install into app/ios/Frameworks.
#
# Zig 0.17 cannot link iOS dynamic libraries directly ("unable to find libSystem").
# We build static archives with Zig, then package dylibs with clang++ + Apple ld.
#
# Witness .dat files are NOT embedded — set zkcasino_set_dat_root at runtime.
set -euo pipefail

unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_DIR="$ROOT/app"
LIBZK="$ROOT/libzkcasino"
IOS_ZIG_PREFIX="${IOS_WITNESS_PREFIX:-zig-out-ios-simulator}"
IOS_ZIG_OUT="$LIBZK/$IOS_ZIG_PREFIX"
FRAMEWORKS="$APP_DIR/ios/Frameworks"
IOS_LIB="$ROOT/rapidsnark/lib/ios-simulator/lib"
GMP_A="$IOS_LIB/libgmp.a"
TARGET="${IOS_WITNESS_TARGET:-aarch64-ios-simulator}"
OPTIMIZE="${IOS_WITNESS_OPTIMIZE:-ReleaseFast}"
MIN_IOS="15.0"
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
WORK="$APP_DIR/.build-ios-witness"

# name|api_file|circuit,circuit,...
WITNESS_LIBS=(
  "zkcasino|src/zig/witness_api.zig|register"
  "zkcasino-shuffle-1-deck-52|src/zig/witness_api_shuffle_1_deck_52.zig|shuffle_1_deck_52"
  "zkcasino-shuffle-6-deck-52|src/zig/witness_api_shuffle_6_deck_52.zig|shuffle_6_deck_52"
  "zkcasino-shuffle-8-deck-52|src/zig/witness_api_shuffle_8_deck_52.zig|shuffle_8_deck_52"
  "zkcasino-shuffle-1-deck-37|src/zig/witness_api_shuffle_1_deck_37.zig|shuffle_1_deck_37"
  "zkcasino-shuffle-1-deck-38|src/zig/witness_api_shuffle_1_deck_38.zig|shuffle_1_deck_38"
  "zkcasino-poker|src/zig/witness_api_poker.zig|poker_share,poker_showdown"
  "zkcasino-baccarat|src/zig/witness_api_baccarat.zig|baccarat_share,baccarat_showdown"
  "zkcasino-war|src/zig/witness_api_war.zig|war_share,war_showdown"
  "zkcasino-blackjack|src/zig/witness_api_blackjack.zig|blackjack_share,blackjack_action,blackjack_showdown"
  "zkcasino-roulette|src/zig/witness_api_roulette.zig|roulette_share_bet_37,roulette_share_bet_38,roulette_showdown_37,roulette_showdown_38"
)

DYLIBS=(libfr.dylib)
for entry in "${WITNESS_LIBS[@]}"; do
  IFS='|' read -r name _api _circuits <<<"$entry"
  DYLIBS+=("lib${name}.dylib")
done

circuit_objects() {
  local circuits_csv="$1"
  local circuit
  local -a out=()
  IFS=',' read -r -a circuits <<<"$circuits_csv"
  for circuit in "${circuits[@]}"; do
    out+=(
      "${circuit}_${circuit}.o"
      "${circuit}_calcwit.o"
      "${circuit}_main_bridge.o"
    )
  done
  printf '%s\n' "${out[@]}"
}

# Apple ld no longer honors -multiply_defined suppress. Localize the identical
# unprefixed C/C++ exports in every calcwit.o after the first so multi-circuit
# libs can link (prefixed create_ctx / Circom_CalcWit symbols stay global).
OBJCOPY="${IOS_WITNESS_OBJCOPY:-/opt/homebrew/opt/llvm/bin/llvm-objcopy}"
CALCWIT_DUP_SYMS=(
  _zkcasino_calcwit_reset_cpp_ctx
  _zkcasino_calcwit_delete_cpp_ctx
  _zkcasino_calcwit_get_zig_ctx
  _zkcasino_calcwit_get_witness_cpp
  __Z5fnv1aNSt3__112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEE
)

localize_secondary_calcwit() {
  local obj="$1"
  if [[ ! -x "$OBJCOPY" ]]; then
    echo "[ios-witness] error: llvm-objcopy required to link multi-circuit libs (tried $OBJCOPY)" >&2
    exit 1
  fi
  local sym
  for sym in "${CALCWIT_DUP_SYMS[@]}"; do
    "$OBJCOPY" --localize-symbol="$sym" "$obj"
  done
}

need_rebuild() {
  if [[ "${FORCE_IOS_WITNESS_REBUILD:-0}" == "1" ]]; then
    return 0
  fi
  local newest_dylib=0
  for name in "${DYLIBS[@]}"; do
    local path="$FRAMEWORKS/$name"
    if [[ ! -f "$path" ]]; then
      return 0
    fi
    if ! otool -l "$path" 2>/dev/null | awk '/cmd LC_BUILD_VERSION/{getline; getline; if ($2 != 7) exit 1} END{exit 0}'; then
      echo "[ios-witness] $path is not an iOS simulator binary — rebuilding"
      return 0
    fi
    if otool -L "$path" 2>/dev/null | rg -q homebrew; then
      echo "[ios-witness] $path links Homebrew — rebuilding"
      return 0
    fi
    local mt
    mt="$(stat -f %m "$path" 2>/dev/null || echo 0)"
    if (( mt > newest_dylib )); then
      newest_dylib=$mt
    fi
  done
  local src
  for src in \
    "$APP_DIR/scripts/build-ios-witness.sh" \
    "$LIBZK/build.zig" \
    "$LIBZK/src/witness_common/main_bridge.cpp" \
    "$LIBZK/src/witness_common/calcwit.cpp" \
    "$LIBZK/src/circuits/"*.cpp \
    "$LIBZK/src/zig/witness_api"*.zig
  do
    if [[ -f "$src" ]]; then
      local src_mt
      src_mt="$(stat -f %m "$src" 2>/dev/null || echo 0)"
      if (( src_mt > newest_dylib )); then
        echo "[ios-witness] $(basename "$src") newer than Frameworks dylibs — rebuilding"
        return 0
      fi
    fi
  done
  echo "[ios-witness] iOS simulator witness dylibs already present in $FRAMEWORKS"
  return 1
}

validate_dylib() {
  local path="$1"
  echo "[ios-witness] validating $path"
  otool -l "$path" | awk '/cmd LC_BUILD_VERSION/{getline; getline; platform=$2; exit} END{if (platform != 7) {print "expected iOS simulator platform 7, got", platform > "/dev/stderr"; exit 1}}'
  if otool -L "$path" | rg -q homebrew; then
    echo "[ios-witness] error: $path still links Homebrew" >&2
    otool -L "$path" >&2
    exit 1
  fi
}

link_fr_dylib() {
  local out="$FRAMEWORKS/libfr.dylib"
  echo "[ios-witness] linking $out"
  clang++ -shared -arch arm64 -isysroot "$SDK" -mios-simulator-version-min="$MIN_IOS" \
    -Wl,-force_load,"$IOS_LIB/libfr.a" \
    -Wl,-force_load,"$IOS_LIB/libfq.a" \
    "$GMP_A" \
    -install_name @rpath/libfr.dylib \
    -o "$out"
  validate_dylib "$out"
}

build_zcu_object() {
  local api_rel="$1"
  local out_o="$2"
  echo "[ios-witness] zig build-obj $api_rel -> $out_o"
  (
    cd "$LIBZK"
    zig build-obj -OReleaseFast -target "$TARGET" -mcpu baseline -fPIC \
      -Mroot="$api_rel" \
      --name "$(basename "${out_o%.o}")"
    mv "$(basename "${out_o%.o}").o" "$out_o"
  )
}

link_witness_dylib() {
  local lib_name="$1"
  local api_rel="$2"
  local circuits_csv="$3"

  local dylib_name="lib${lib_name}.dylib"
  local archive="$IOS_ZIG_OUT/lib/lib${lib_name}.a"
  local zcu_o="$WORK/lib${lib_name}_zcu.o"
  local out="$FRAMEWORKS/$dylib_name"
  local obj_dir="$WORK/objects/${dylib_name%.dylib}"
  rm -rf "$obj_dir"
  mkdir -p "$obj_dir"

  if [[ ! -f "$archive" ]]; then
    echo "[ios-witness] error: missing archive $archive" >&2
    exit 1
  fi

  local -a members=()
  while IFS= read -r member; do
    [[ -n "$member" ]] || continue
    members+=("$member")
  done < <(circuit_objects "$circuits_csv")

  echo "[ios-witness] extracting ${#members[@]} objects from $(basename "$archive") for $dylib_name"
  (
    cd "$obj_dir"
    for member in "${members[@]}"; do
      ar x "$archive" "$member"
      chmod u+rwx "$member"
    done
  )

  build_zcu_object "$api_rel" "$zcu_o"

  local -a circuit_objs=()
  for member in "${members[@]}"; do
    circuit_objs+=("$obj_dir/$member")
  done

  local -a circuits=()
  IFS=',' read -r -a circuits <<<"$circuits_csv"
  if (( ${#circuits[@]} > 1 )); then
    local i circuit
    for (( i = 1; i < ${#circuits[@]}; i++ )); do
      circuit="${circuits[$i]}"
      echo "[ios-witness] localizing duplicate calcwit exports in ${circuit}_calcwit.o"
      localize_secondary_calcwit "$obj_dir/${circuit}_calcwit.o"
    done
  fi

  local -a objects=("$zcu_o")
  # ARM64 ASM libfr exports C `Fr_raw*`; generic C++ libfr only has mangled names.
  # Zig fr.zig needs C linkage — add wrappers only when ASM C symbols are absent.
  if ! nm "$IOS_LIB/libfr.a" 2>/dev/null | rg -q 'T _Fr_rawAdd$'; then
    local fr_c_abi_o="$WORK/objects/fr_c_abi.o"
    if [[ ! -f "$fr_c_abi_o" ]]; then
      echo "[ios-witness] compiling fr_c_abi.cpp (C wrappers for mangled Fr_raw*)"
      clang++ -c -arch arm64 -isysroot "$SDK" -mios-simulator-version-min="$MIN_IOS" \
        -O2 -fPIC \
        -o "$fr_c_abi_o" \
        "$LIBZK/src/witness_common/fr_c_abi.cpp"
    fi
    objects+=("$fr_c_abi_o")
  else
    echo "[ios-witness] libfr.a already exports C Fr_raw* (ASM) — skip fr_c_abi"
  fi
  # Link circuit objects directly (do not ld -r merge): a relocatable merge turns
  # private_extern circuit entry points into locals, leaving ZCU refs dynamically
  # undefined under -undefined dynamic_lookup.
  objects+=("${circuit_objs[@]}")

  echo "[ios-witness] linking $out"
  clang++ -shared -arch arm64 -isysroot "$SDK" -mios-simulator-version-min="$MIN_IOS" \
    "${objects[@]}" \
    -Wl,-force_load,"$IOS_LIB/libfr.a" \
    -Wl,-force_load,"$IOS_LIB/libfq.a" \
    "$GMP_A" \
    -Wl,-undefined,dynamic_lookup \
    -Wl,-install_name,"@rpath/$dylib_name" \
    -Wl,-rpath,@loader_path \
    -o "$out"
  if nm -u "$out" 2>/dev/null | rg -q '^_Fr_raw'; then
    echo "[ios-witness] error: $out still has undefined Fr_raw* C symbols:" >&2
    nm -u "$out" | rg '^_Fr_raw' >&2 || true
    exit 1
  fi
  validate_dylib "$out"
}

if ! need_rebuild; then
  exit 0
fi

if [[ ! -f "$GMP_A" ]]; then
  echo "[ios-witness] building static GMP for iOS simulator..."
  bash "$APP_DIR/scripts/build-ios-gmp.sh" iphonesimulator
fi

if [[ ! -f "$IOS_LIB/librapidsnark.a" ]]; then
  echo "[ios-witness] building rapidsnark for iOS simulator..."
  bash "$APP_DIR/scripts/build-ios-rapidsnark.sh"
fi

mkdir -p "$FRAMEWORKS" "$WORK/objects"

echo "[ios-witness] cross-compiling all libzkcasino static archives for $TARGET -> $IOS_ZIG_PREFIX/..."
(
  cd "$LIBZK"
  env -u CPATH -u C_INCLUDE_PATH -u CPLUS_INCLUDE_PATH \
    zig build \
      -p "$IOS_ZIG_PREFIX" \
      -Dtarget="$TARGET" \
      -Dcircuit-set=all \
      -Dwitness-link=static \
      -Doptimize="$OPTIMIZE"
)

link_fr_dylib

for entry in "${WITNESS_LIBS[@]}"; do
  IFS='|' read -r name api circuits <<<"$entry"
  link_witness_dylib "$name" "$api" "$circuits"
done

# Remove obsolete names from earlier layouts.
rm -f \
  "$FRAMEWORKS/libzkcasino-shuffle-single.dylib" \
  "$FRAMEWORKS/libzkcasino-poker-showdown.dylib" \
  "$FRAMEWORKS/libzkcasino-shuffle-six.dylib" \
  "$FRAMEWORKS/libzkcasino-shuffle-eight.dylib"

echo "[ios-witness] installed witness dylibs:"
ls -lh "${DYLIBS[@]/#/$FRAMEWORKS/}"
