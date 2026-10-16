#!/usr/bin/env zsh

mkdir -p build/ zkey/

set -ex

circuit=$1
if [ -z "$circuit" ]; then
  circuit="hand_eval_main"
fi

CIRCOM_LIBS=(-l node_modules/circomlib)

# cargo run --manifest-path rust/circom-assert-lint/Cargo.toml -- circuits/${circuit}.circom

# The sibling compiler at ../circom. CIRCOM overrides it.
script_dir=${0:A:h}
circom_bin=${CIRCOM:-${script_dir}/../circom/target/release/circom}
if [[ ! -x ${circom_bin} ]]; then
  echo "missing circom at ${circom_bin}"
  exit 1
fi

# Compile the circuit and capture output
compile_output=$(${circom_bin} circuits/${circuit}.circom "${CIRCOM_LIBS[@]}" -c --O2 --r1cs -o build 2>&1)
echo "$compile_output"

# Extract number of non-linear and linear constraints
# The lines look like:
# "non-linear constraints: 348593"
# "linear constraints: 1273"
non_linear=$(echo "$compile_output" | grep "non-linear constraints:" | tr -s ' ' | cut -d' ' -f3)
linear=$(echo "$compile_output" | grep "linear constraints:" | grep -v "non-linear" | tr -s ' ' | cut -d' ' -f3)

if [ -z "$non_linear" ]; then
  echo "Failed to extract non-linear constraints from circom output"
  exit 1
fi

# If linear constraints not found, assume 0
if [ -z "$linear" ]; then
  linear=0
fi

# Total constraints is the sum - we need to fit both in the ceremony
total_constraints=$((non_linear + linear))

echo "Circuit has $non_linear non-linear constraints"
echo "Circuit has $linear linear constraints"
echo "Total constraints to fit: $total_constraints"

# Calculate minimum power of 2 (minimum 16)
# Find smallest power where 2^power >= constraints
calculate_power() {
  local n=$1
  local min_power=16
  local power=$min_power
  
  # Keep incrementing power until 2^power >= n
  while [ $((2 ** power)) -lt $n ]; do
    power=$((power + 1))
  done
  
  echo $power
}

power=$(calculate_power $total_constraints)

# Override with manual power if provided as argument
if [ -n "$2" ]; then
  power=$2
  echo "Using manually specified power: $power"
else
  echo "Automatically calculated power: $power (for $total_constraints total constraints)"
fi

if [ $power -gt 28 ]; then
  echo "Power too high ($power), max is 28"
  exit 1
fi

suffix="_${power}"

if [ $power -eq 28 ]; then
  suffix=""
fi

if [ ! -f ~/ptau/powersOfTau28_hez_final${suffix}.ptau ]; then
  curl https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final${suffix}.ptau -o ~/ptau/powersOfTau28_hez_final${suffix}.ptau
fi

circuit_basename=$(basename "${circuit}")

if [[ -n ${ZKEY:-} ]]; then
  zkey_setup=$ZKEY
elif command -v zkey >/dev/null 2>&1; then
  zkey_setup=$(command -v zkey)
else
  echo "missing zkey from the IceColdCasino/groth16 formula"
  echo "brew trust --tap IceColdCasino/groth16"
  echo "brew tap IceColdCasino/groth16 https://github.com/IceColdCasino/groth16"
  echo "brew install icecoldcasino/groth16/zkey"
  exit 1
fi

mkdir -p zkey
out_zkey="zkey/${circuit_basename}_0001.zkey"
out_vk="zkey/${circuit_basename}_verification_key.json"

# Setup and contribute stay in memory. The final key is written once.
${zkey_setup} "build/${circuit_basename}.r1cs" "${HOME}/ptau/powersOfTau28_hez_final${suffix}.ptau" "${out_zkey}" "${out_vk}" "1st Contributor Name"

# Isolated mains are proved on their own. Their short names are not the
# witness files the game tests load (poker_share_main must not replace
# poker_share_hashout_main).
case ${circuit_basename} in
  poker_share_main|poker_hand_eval_main|poker_compare_hands_main|craps_bet_eval_main)
    echo "zkey ready for ${circuit_basename}; game witness comes from another main"
    exit 0
    ;;
esac

# Witness calculator used by libzkcasino. The file is named after the main;
# the library loads the short name (hashout mains drop that suffix).
short=${circuit_basename%_main}
short=${short%_hashout}
case ${short} in
  register) sub=register ;;
  shuffle_*) sub=shuffle ;;
  poker_*) sub=poker ;;
  baccarat_*) sub=baccarat ;;
  war_*) sub=war ;;
  blackjack_*) sub=blackjack ;;
  roulette_*) sub=roulette ;;
  craps_*) sub=craps ;;
  keno_*) sub=keno ;;
  slot_*) sub=slots ;;
  bingo_*) sub=bingo ;;
  *)
    echo "no witness directory for ${short}"
    exit 1
    ;;
esac
cpp_src="build/${circuit_basename}_cpp/${circuit_basename}.cpp"
dat_src="build/${circuit_basename}_cpp/${circuit_basename}.dat"
if [[ ! -f ${dat_src} ]]; then
  dat_src="build/${circuit_basename}.dat"
fi
if [[ ! -f ${cpp_src} || ! -f ${dat_src} ]]; then
  echo "missing witness outputs cpp=${cpp_src} dat=${dat_src}"
  exit 1
fi
cp "${cpp_src}" "libzkcasino/src/circuits/${sub}/${short}.cpp"
cp "${dat_src}" "libzkcasino/src/zig/dat/${short}.dat"
echo "installed witness ${short} from ${circuit_basename}"
