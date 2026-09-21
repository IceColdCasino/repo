/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./helpers.circom";
include "./elgamal.circom";

// When enabled=1, require in == 0. When enabled=0, unconstrained.
template ConstrainZeroIf() {
  signal input enabled;
  signal input in;

  enabled * in === 0;
}

// Pack type (low 4 bits) + modifier (high 6 bits) into one Fr.
// packed = type + modifier * 16; type < 12 and modifier < 57 from ConstrainBet*.
template PackBet() {
  signal input type;
  signal input modifier;

  signal output out;

  component typeBits;
  component modBits;
  component pack;

  typeBits = Num2Bits(4);
  typeBits.in <== type;

  modBits = Num2Bits(6);
  modBits.in <== modifier;

  pack = Bits2Num(10);
  for (var i = 0; i < 4; i++) {
    pack.in[i] <== typeBits.out[i];
  }
  for (var i = 0; i < 6; i++) {
    pack.in[4 + i] <== modBits.out[i];
  }

  out <== pack.out;
}

template UniqueActualScalarBets(nBets) {
  assert(nBets >= 1 && nBets <= 20);

  var nPairs = nBets * (nBets - 1) / 2;

  signal input nActualBets;
  signal input plaintextBets[nBets];

  signal bothActive[nPairs];

  component active[nBets];
  component eq[nPairs];

  for (var i = 0; i < nBets; i++) {
    // i < nActualBets (i is a constant; nActualBets ≤ nBets ≤ 20)
    active[i] = LessThan(5);
    active[i].in[0] <== i;
    active[i].in[1] <== nActualBets;
  }

  var k = 0;
  for (var i = 0; i < nBets; i++) {
    for (var j = i + 1; j < nBets; j++) {
      bothActive[k] <== active[i].out * active[j].out;
      eq[k] = IsEqual();
      eq[k].in <== [plaintextBets[i], plaintextBets[j]];
      bothActive[k] * eq[k].out === 0;
      k++;
    }
  }
}

// Require packed (type||modifier) values unique among bets[0 .. nActualBets).
// Inactive slots (i >= nActualBets) may repeat padding freely.
// Outputs packedBets so CommitBet can reuse PackBet without recomputing.
template UniqueActualBets(nBets) {
  assert(nBets >= 1 && nBets <= 12);

  var nPairs = nBets * (nBets - 1) / 2;

  signal input nActualBets;
  signal input plaintextBets[nBets][2];

  signal bothActive[nPairs];

  signal output packedBets[nBets];

  component pack[nBets];
  component uniqueActualScalarBets;

  for (var i = 0; i < nBets; i++) {
    pack[i] = PackBet();
    pack[i].type <== plaintextBets[i][0];
    pack[i].modifier <== plaintextBets[i][1];
    packedBets[i] <== pack[i].out;
  }

  uniqueActualScalarBets = UniqueActualScalarBets(nBets);
  uniqueActualScalarBets.nActualBets <== nActualBets;
  uniqueActualScalarBets.plaintextBets <== packedBets;
}

