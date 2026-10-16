/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "circuits/bitify.circom";
include "circuits/poseidon.circom";
include "./seal_weights.circom";
include "./showdown.circom";

// One sealed coefficient. The weight table stays a function so a slot's 512
// constants occupy that witness thread's stack, not the parent.
template SealSlotRows(slot) {
  var nBits = 128;
  var nRows = 4;

  signal input bits[nBits];
  signal output row[nRows];

  var weights[nRows][nBits] = sealSlotWeights(slot);
  for (var k = 0; k < nRows; k++) {
    var sum = 0;
    for (var j = 0; j < nBits; j++) {
      sum += weights[k][j] * bits[j];
    }
    row[k] <== sum;
  }
}

// Arcis seals `nLive` coefficients of 128 bits with bit 127 set. The weight
// table has two slots, and the commitment is the sum of those slots only.
// Each weight is below 2^242, so the two-slot sum is below 2^253 and matches
// the BaseField25519 rows Arcis revealed. The commitment is the Poseidon hash
// of the four sums.
template SealCommitment(nLive) {
  var nBits = 128;
  var nRows = 4;
  assert(nLive > 0 && nLive <= 2);

  signal input coefficients[nLive];

  signal output out;

  component bits[nLive];
  component slot[nLive];
  component rowHash;

  for (var i = 0; i < nLive; i++) {
    bits[i] = Num2BitsStrict(nBits);
    bits[i].in <== coefficients[i];
    bits[i].out[nBits - 1] === 1;
    slot[i] = parallel SealSlotRows(i);
    slot[i].bits <== bits[i].out;
  }

  var rows[nRows];
  for (var k = 0; k < nRows; k++) {
    rows[k] = 0;
  }
  for (var i = 0; i < nLive; i++) {
    for (var k = 0; k < nRows; k++) {
      rows[k] += slot[i].row[k];
    }
  }

  rowHash = Poseidon(nRows);
  for (var k = 0; k < nRows; k++) {
    rowHash.inputs[k] <== rows[k];
  }

  out <== rowHash.out;
}

// The seal commitment HashMain hashed must be the commitment of these
// coefficients. The polynomial uses every one of them.
template SealedShowdownHash(nTerms) {
  assert(nTerms > 0 && nTerms <= 2);

  signal input sealCommitment;
  signal input results[nTerms];
  signal input coefficients[nTerms];

  signal output out;

  component seal;
  component poly;

  seal = parallel SealCommitment(nTerms);
  seal.coefficients <== coefficients;
  sealCommitment === seal.out;

  poly = ShowdownPolynomialHash(nTerms);
  poly.results <== results;
  poly.coefficients <== coefficients;

  out <== poly.out;
}
