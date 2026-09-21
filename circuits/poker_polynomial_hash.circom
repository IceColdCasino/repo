/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.0.0;

include "./polynomial_hash.circom";
include "./helpers.circom";
include "circuits/comparators.circom";

// Hierarchical polynomial hash of 900 BN254 values.
//
// Uses random linear combination instead of powers of 2
// to make collisions computationally infeasible.
//
// Each input is a BN254 field element (up to 254 bits).
// The circuit extracts and combines low/high bits before hashing.
//
// Structure: [9 players][25 cards each][4 BN254 values per card]
// Only recipient rows i < nActualPlayers-1 and cards in
// {0..2*nActualPlayers-1} ∪ {20..24} contribute to the sum.
// ExtractAndCombine still runs on every fixed slot.
//
// SAFETY: After extraction:
//   - Each value < 2^129 (low + 2*high)
//   - Coefficients < 2^100
//   - Max term: (2^129 - 1) * (2^100 - 1) < 2^229
//   - Max sum (900 terms): 900 * 2^229 < 2^239
//   - 2^239 < BN254 prime (≈2^254) and < Ed25519 prime (≈2^255)
//   - No wraparound in either field → identical results!

template PokerPolynomialHash(nPlayers) {
  var nOthers = nPlayers - 1;
  var nCards = nPlayers * 2 + 5;
  var boardStart = nPlayers * 2; // 20 when nPlayers=10

  signal input in[nOthers][nCards][4];
  signal input nActualPlayers;

  signal twoN;
  signal recipientActive[nOthers];
  signal cardActive[nCards];
  signal slotActive[nOthers][nCards];
  signal term[nOthers][nCards][4];
  
  signal output out;

  component nBits;
  component geMin;
  component ltMax;
  component recipientActiveLt[nOthers];
  component cardHoleLt[boardStart];
  component extractors[nOthers][nCards][4];

  // Range-check nActualPlayers ∈ [2, 10]
  nBits = Num2Bits(4);
  nBits.in <== nActualPlayers;

  geMin = ConstrainGt(4, 1);
  geMin.in <== nActualPlayers;

  ltMax = ConstrainLt(4, nPlayers + 1);
  ltMax.in <== nActualPlayers;

  twoN <== nActualPlayers * 2;

  for (var i = 0; i < nOthers; i++) {
    // active iff i < nActualPlayers - 1  ⇔  (i+1) < nActualPlayers
    recipientActiveLt[i] = LessThan(4);
    recipientActiveLt[i].in[0] <== i + 1;
    recipientActiveLt[i].in[1] <== nActualPlayers;
    recipientActive[i] <== recipientActiveLt[i].out;
  }

  for (var j = 0; j < boardStart; j++) {
    // Hole slot j active iff j < 2 * nActualPlayers
    cardHoleLt[j] = LessThan(5);
    cardHoleLt[j].in[0] <== j;
    cardHoleLt[j].in[1] <== twoN;
    cardActive[j] <== cardHoleLt[j].out;
  }
  for (var j = boardStart; j < nCards; j++) {
    // Board cards 20–24 always included
    cardActive[j] <== 1;
  }

  var hash = 0;
  var idx = 0;

  for (var i = 0; i < nOthers; i++) {
    for (var j = 0; j < nCards; j++) {
      slotActive[i][j] <== recipientActive[i] * cardActive[j];
      for (var k = 0; k < 4; k++) {
        extractors[i][j][k] = parallel ExtractAndCombine();
        extractors[i][j][k].in <== in[i][j][k];
        // Two-signal product needs an intermediate; coeffs(idx) is constant
        term[i][j][k] <== extractors[i][j][k].out * slotActive[i][j];
        hash = hash + term[i][j][k] * coeffs(idx);
        idx++;
      }
    }
  }

  out <== hash;
}
