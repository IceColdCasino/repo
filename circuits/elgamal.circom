/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "circuits/babyjub.circom";
include "circuits/escalarmulfix.circom";
include "circuits/escalarmulany.circom";
include "circuits/bitify.circom";
include "circuits/comparators.circom";
include "./helpers.circom";

function BASE8() {
  return [
    5299619240641551281634865583518297030282874472190772894086521144482721001553,
    16950150798460657717958625567821834550301663161624707787222815936182638968203
  ];
}

/**
 * ElGamal encryption on BabyJub curve
 * 
 * Encryption:
 *   c0 = r * G (where G is the base point)
 *   c1 = plaintext + r * publicKey
 * 
 * Input:
 *   - plaintext[2]: Point to encrypt [x, y]
 *   - publicKey[2]: Recipient's public key [x, y] = sk * G
 *   - r: Random scalar (private)
 * 
 * Output:
 *   - ciphertext[4]: [c0.x, c0.y, c1.x, c1.y]
 */
template Encrypt() {
  signal input plaintext[2];
  signal input publicKey[2];
  signal input randomness;

  signal output ciphertext[4];

  component randomnessBits;
  component c0Mul;
  component rPk;
  component c1Add;

  // Step 1: Compute c0 = r * G
  // Use EscalarMulFix since we're multiplying by the fixed base point G
  randomnessBits = Num2Bits(253);
  randomnessBits.in <== randomness;

  c0Mul = EscalarMulFix(253, BASE8());
  c0Mul.e <== randomnessBits.out;

  // Step 2: Compute r * publicKey
  rPk = EscalarMulAny(253);
  rPk.p <== publicKey;
  rPk.e <== randomnessBits.out;

  // Step 3: Compute c1 = plaintext + r * publicKey
  c1Add = BabyAdd();
  c1Add.x1 <== plaintext[0];
  c1Add.y1 <== plaintext[1];
  c1Add.x2 <== rPk.out[0];
  c1Add.y2 <== rPk.out[1];

  // Output ciphertext [c0.x, c0.y, c1.x, c1.y]
  ciphertext <== [
    c0Mul.out[0],
    c0Mul.out[1],
    c1Add.xout,
    c1Add.yout
  ];
}

template AddRandomness() {
  signal input ciphertext[4];
  signal input publicKey[2];
  signal input randomness;

  signal output out[4];

  component isZeroRandomness;
  component randomnessBits;
  component randomnessG;
  component randomnessPublicKey;
  component c0Add;
  component c1Add;

  // Constrain randomness != 0 (non-zero randomness required for valid encryption)
  isZeroRandomness = IsZero();
  isZeroRandomness.in <== randomness;
  isZeroRandomness.out === 0;  // Must NOT be zero

  randomnessBits = Num2Bits(253);
  randomnessBits.in <== randomness;

  randomnessG = EscalarMulFix(253, BASE8());
  randomnessG.e <== randomnessBits.out;
  
  c0Add = BabyAdd();
  c0Add.x1 <== ciphertext[0];
  c0Add.y1 <== ciphertext[1];
  c0Add.x2 <== randomnessG.out[0];
  c0Add.y2 <== randomnessG.out[1];
  
  randomnessPublicKey = EscalarMulAny(253);
  randomnessPublicKey.p <== publicKey;
  randomnessPublicKey.e <== randomnessBits.out;
  
  c1Add = BabyAdd();
  c1Add.x1 <== ciphertext[2];
  c1Add.y1 <== ciphertext[3];
  c1Add.x2 <== randomnessPublicKey.out[0];
  c1Add.y2 <== randomnessPublicKey.out[1];
  
  out <== [
    c0Add.xout,
    c0Add.yout,
    c1Add.xout,
    c1Add.yout
  ];
}

/**
 * ElGamal decryption on BabyJub curve
 * 
 * Decryption:
 *   plaintext = c1 - sk * c0
 *             = c1 + (-sk * c0)
 * 
 * Input:
 *   - ciphertext[4]: [c0.x, c0.y, c1.x, c1.y]
 *   - privateKey: Secret key (sk)
 * 
 * Output:
 *   - plaintext[2]: Decrypted point [x, y]
 */
template Decrypt() {
  signal input ciphertext[4];
  signal input privateKey;

  signal negSkC0[2];

  signal output plaintext[2];

  component skBits;
  component skC0Mul;
  component c1Add;

  // Step 1: Compute sk * c0
  skBits = Num2Bits(253);
  skBits.in <== privateKey;

  skC0Mul = EscalarMulAny(253);
  skC0Mul.p <== [ciphertext[0], ciphertext[1]]; // c0
  skC0Mul.e <== skBits.out;

  // Step 2: Negate sk * c0: (-x, y)
  negSkC0 <== [0 - skC0Mul.out[0], skC0Mul.out[1]];

  // Step 3: Compute plaintext = c1 + (-sk * c0)
  c1Add = BabyAdd();
  c1Add.x1 <== ciphertext[2];
  c1Add.y1 <== ciphertext[3];
  c1Add.x2 <== negSkC0[0];
  c1Add.y2 <== negSkC0[1];

  plaintext <== [c1Add.xout, c1Add.yout];
}

template PartialDecrypt() {
  signal input c0[2];    // First component of ElGamal ciphertext (point)
  signal input privateKey;   // Player's secret key (scalar)

  signal output partial[2];  // Partial decryption: sk * c0

  component isZeroC0;
  component privateKeyBits;
  component multiply;
  
  // Verify c0 is a valid point (not identity)
  isZeroC0 = IsZero();
  isZeroC0.in <== c0[0];
  isZeroC0.out === 0;
  
  // Compute sk * c0 using EscalarMulAny for variable base point
  // First convert privateKey to bits
  privateKeyBits = Num2Bits(253);
  privateKeyBits.in <== privateKey;
  
  multiply = EscalarMulAny(253);
  multiply.p <== c0;
  multiply.e <== privateKeyBits.out;
  
  partial <== multiply.out;
}

template AggregatePublicKey(nKeys) {
  signal input publicKeys[nKeys][2];

  signal accumulator[nKeys][2];
  
  signal output key[2];

  component adder[nKeys - 1];

  accumulator[0] <== publicKeys[0];
  
  for (var i = 0; i < nKeys - 1; i++) {
    adder[i] = BabyAdd();
    adder[i].x1 <== accumulator[i][0];
    adder[i].y1 <== accumulator[i][1];
    adder[i].x2 <== publicKeys[i + 1][0];
    adder[i].y2 <== publicKeys[i + 1][1];
    accumulator[i + 1] <== [adder[i].xout, adder[i].yout];
  }

  key <== accumulator[nKeys - 1];
}

template VerifyKey() {
  signal input privateKey;
  signal input publicKey[2];

  component babyPbk;
  component eq[2];

  babyPbk = BabyPbk();
  babyPbk.in <== privateKey;

  for (var i = 0; i < 2; i++) {
    eq[i] = IsEqual();
    eq[i].in[0] <== publicKey[i];
  }
  
  eq[0].in[1] <== babyPbk.Ax;
  eq[1].in[1] <== babyPbk.Ay;

  eq[0].out * eq[1].out === 1;
}

/**
 * Public key check using selector approach
 * Verifies that publicKey matches publicKeys[playerIndex]
 */
template PublicKeyCheck(nPlayers) {
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input publicKey[2];  // Prover's claimed public key
  
  signal pkSelector[nPlayers];
  signal selectedPK[2];
  signal partialSum[nPlayers+1][2];
  
  component playerIndexLt;
  component indexEq[nPlayers];
  component pkCheck[2];

  playerIndexLt = ConstrainLt(4, nPlayers);
  playerIndexLt.in <== playerIndex;
  
  // Create selector (1 at playerIndex, 0 elsewhere)
  for (var i = 0; i < nPlayers; i++) {
    indexEq[i] = IsEqual();
    indexEq[i].in[0] <== i;
    indexEq[i].in[1] <== playerIndex;
    pkSelector[i] <== indexEq[i].out;
  }
  
  // Calculate selected public key using selector
  // selectedPK[j] = sum(pkSelector[i] * publicKeys[i][j]) for all i
  // Using incremental addition with signals
  for (var j = 0; j < 2; j++) {
    partialSum[0][j] <== 0;
    for (var i = 0; i < nPlayers; i++) {
      // partialSum[i+1] = partialSum[i] + pkSelector[i] * publicKeys[i][j]
      // This is quadratic: (pkSelector[i]) * (publicKeys[i][j]) + partialSum[i]
      partialSum[i+1][j] <== partialSum[i][j] + pkSelector[i] * publicKeys[i][j];
    }
    selectedPK[j] <== partialSum[nPlayers][j];
  }
  
  // Verify selected key matches claimed key
  for (var i = 0; i < 2; i++) {
    pkCheck[i] = IsEqual();
    pkCheck[i].in[0] <== selectedPK[i];
    pkCheck[i].in[1] <== publicKey[i];
  }
  
  pkCheck[0].out * pkCheck[1].out === 1;
}
