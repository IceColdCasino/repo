/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./card_rank.circom";
include "circuits/comparators.circom";
include "circuits/mux1.circom";

template EvaluateHands(shoeSize) {
  var nTotalCards = 4;

  signal input cards[nTotalCards];

  signal values[nTotalCards];
  signal initialWinner;
  signal warWinner;

  signal output winner; // 0 = player, 1 = dealer, 2 = tie

  component getRanks[nTotalCards];
  component initialLt;
  component initialEq;
  component warLt;
  component warEq;
  component winnerMux;

  for (var i = 0; i < nTotalCards; i++) {
    getRanks[i] = CardToRank(shoeSize);
    getRanks[i].card <== cards[i];
    values[i] <== getRanks[i].rank;
  }

  // cards[0] vs cards[1]; on tie compare cards[2] vs cards[3]
  // GreaterThan with swapped inputs encodes "values[0] < values[1]" → player loses.
  initialLt = GreaterThan(4);
  initialLt.in[0] <== values[1];
  initialLt.in[1] <== values[0];

  initialEq = IsEqual();
  initialEq.in <== [values[0], values[1]];

  warLt = GreaterThan(4);
  warLt.in[0] <== values[3];
  warLt.in[1] <== values[2];

  warEq = IsEqual();
  warEq.in <== [values[2], values[3]];

  initialWinner <== initialLt.out;
  warWinner <== warLt.out + 2 * warEq.out;

  winnerMux = Mux1();
  winnerMux.s <== initialEq.out;
  winnerMux.c[0] <== initialWinner;
  winnerMux.c[1] <== warWinner;
  winner <== winnerMux.out;
}