/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./helpers.circom";

// Count how many of the first nActualBets spots appear in the 20-number draw.
template Evaluate(nBets, nSelection) {
  signal input plaintextValues[nSelection];
  signal input plaintextBets[nBets];
  signal input nActualBets;

  signal output out;

  signal matches[nSelection * nBets + 1];

  component eq[nSelection * nBets];
  component lt[nBets];

  matches[0] <== 0;

  for (var i = 0; i < nBets; i++) {
    lt[i] = LessThan(5);
    lt[i].in <== [i, nActualBets];

    for (var j = 0; j < nSelection; j++) {
      eq[i * nSelection + j] = IsEqual();
      eq[i * nSelection + j].in <== [plaintextBets[i], plaintextValues[j]];

      matches[i * nSelection + j + 1] <== matches[i * nSelection + j] + eq[i * nSelection + j].out * lt[i].out;
    }
  }

  out <== matches[nSelection * nBets];
}
