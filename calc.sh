#!/usr/bin/env zsh

mkdir -p build/ zkey/

set -ex

circuit=$1
if [ -z "$circuit" ]; then
  circuit="hand_eval_main"
fi

CIRCOM_LIBS=(-l node_modules/circomlib)

# cargo run --manifest-path rust/circom-assert-lint/Cargo.toml -- circuits/${circuit}.circom

# Compile the circuit and capture output
compile_output=$(circom circuits/${circuit}.circom "${CIRCOM_LIBS[@]}" -c --O2 --r1cs -o build 2>&1)
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

# Allow override for huge circuits (e.g. blackjack_showdown needs >>8GB heap).
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"

circuit_basename=$(basename "${circuit}")

# Create RAM disk for faster zkey operations.
# Override with RAMDISK_SIZE_MB for large circuits (need ~2x final zkey size).
RAMDISK_SIZE_MB=${RAMDISK_SIZE_MB:-4096}
RAMDISK_NAME="zkey_ramdisk_$$"
# Create RAM disk and trim whitespace from device path
RAMDISK_DEVICE=$(hdiutil attach -nomount ram://$((RAMDISK_SIZE_MB * 2048 * 2)) | tr -d '[:space:]')
echo "Created RAM disk device: ${RAMDISK_DEVICE}"

# Format the RAM disk
newfs_hfs -v "${RAMDISK_NAME}" "${RAMDISK_DEVICE}"

# Mount to /tmp/ instead of /Volumes/ for better permissions
RAMDISK_MOUNT="/tmp/${RAMDISK_NAME}"
mkdir -p "${RAMDISK_MOUNT}"
mount -t hfs "${RAMDISK_DEVICE}" "${RAMDISK_MOUNT}"

echo "RAM disk mounted at ${RAMDISK_MOUNT} (${RAMDISK_SIZE_MB}MB)"
df -h "${RAMDISK_MOUNT}" | head -1

# Work in RAM disk for zkey operations
ZKEY_RAM="${RAMDISK_MOUNT}/zkeys"
mkdir -p "${ZKEY_RAM}"

# Run snarkjs setup in RAM disk
bun x snarkjs groth16 setup build/${circuit_basename}.r1cs ~/ptau/powersOfTau28_hez_final${suffix}.ptau "${ZKEY_RAM}/${circuit_basename}_0000.zkey"
set +x
bun x snarkjs zkey contribute "${ZKEY_RAM}/${circuit_basename}_0000.zkey" "${ZKEY_RAM}/${circuit_basename}_0001.zkey" --name="1st Contributor Name" -v -e="$(head -c 2048 /dev/random | base64)"
set -x
bun x snarkjs zkey export verificationkey "${ZKEY_RAM}/${circuit_basename}_0001.zkey" "${ZKEY_RAM}/${circuit_basename}_verification_key.json"

# Copy results from RAM disk to zkey directory
echo "Copying zkeys from RAM disk to zkey/..."
mkdir -p $(pwd)/zkey/
# cp "${ZKEY_RAM}/${circuit_basename}_0000.zkey" $(pwd)/zkey/ # We only need to keep _0001
cp "${ZKEY_RAM}/${circuit_basename}_0001.zkey" $(pwd)/zkey/
cp "${ZKEY_RAM}/${circuit_basename}_verification_key.json" $(pwd)/zkey/

# Unmount and eject RAM disk
umount "${RAMDISK_MOUNT}"
hdiutil detach "${RAMDISK_DEVICE}"
echo "RAM disk ejected"
