/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./helpers.circom";
include "circuits/babyjub.circom";

template InstantiateDeck(n, shoeSize, deckSize) {
  signal input cards[n];

  signal output out[n][2];

  component lt[n];
  component babyPbk[n];

  for (var i = 0; i < n; i++) {
    lt[i] = ConstrainLt(9, deckSize * shoeSize);
    lt[i].in <== cards[i];

    babyPbk[i] = parallel BabyPbk();
    babyPbk[i].in <== cards[i] + 1;

    out[i] <== [babyPbk[i].Ax, babyPbk[i].Ay];
  }
}
