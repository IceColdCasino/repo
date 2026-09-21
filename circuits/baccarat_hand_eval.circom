/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "circuits/mux1.circom";
include "./helpers.circom";
include "./baccarat_card.circom";

template Mod10Sum2() {
  signal input a;
  signal input b;

  signal sum;
  signal sumMinus10;
  signal gte10Part;

  signal output out;

  component lt10;

  sum <== a + b;
  sumMinus10 <== sum - 10;

  lt10 = LessThan(5);
  lt10.in[0] <== sum;
  lt10.in[1] <== 10;

  gte10Part <== (1 - lt10.out) * sumMinus10;
  out <== lt10.out * sum + gte10Part;
}

template InRangeInclusive(low, high) {
  signal input v;

  signal output out;

  component geLow;
  component leHigh;
  component andGate;

  geLow = GreaterThan(4);
  geLow.in[0] <== v;
  geLow.in[1] <== low - 1;

  leHigh = GreaterThan(4);
  leHigh.in[0] <== high;
  leHigh.in[1] <== v;

  andGate = AND();
  andGate.a <== geLow.out;
  andGate.b <== leHigh.out;

  out <== andGate.out;
}

template DealerDrawsAfterPlayerDraw() {
  signal input dealerTotal;
  signal input playerThird;

  signal drawFor3;
  signal drawFor4;
  signal drawFor5;
  signal drawFor6;
  signal drawFlag[7];

  signal output out;

  component dealerEq[8];
  component p3Not8;
  component p3In2to7;
  component p3In4to7;
  component p3In6to7;

  for (var d = 0; d < 8; d++) {
    dealerEq[d] = IsEqual();
    dealerEq[d].in <== [dealerTotal, d];
  }

  p3Not8 = IsEqual();
  p3Not8.in <== [playerThird, 8];

  p3In2to7 = InRangeInclusive(2, 7);
  p3In2to7.v <== playerThird;

  p3In4to7 = InRangeInclusive(4, 7);
  p3In4to7.v <== playerThird;

  p3In6to7 = InRangeInclusive(6, 7);
  p3In6to7.v <== playerThird;

  drawFor3 <== 1 - p3Not8.out;
  drawFor4 <== p3In2to7.out;
  drawFor5 <== p3In4to7.out;
  drawFor6 <== p3In6to7.out;

  drawFlag[0] <== dealerEq[0].out;
  drawFlag[1] <== dealerEq[1].out;
  drawFlag[2] <== dealerEq[2].out;
  drawFlag[3] <== dealerEq[3].out * drawFor3;
  drawFlag[4] <== dealerEq[4].out * drawFor4;
  drawFlag[5] <== dealerEq[5].out * drawFor5;
  drawFlag[6] <== dealerEq[6].out * drawFor6;

  out <== drawFlag[0] + drawFlag[1] + drawFlag[2] + drawFlag[3]
       + drawFlag[4] + drawFlag[5] + drawFlag[6];
}

template EvaluateHands(shoeSize) {
  signal input cards[6];

  signal values[6];
  signal playerTotal2;
  signal dealerTotal2;
  signal natural;
  signal playerDraws;
  signal dealerDrawsWhenPlayerStood;
  signal dealerDrawsAfterPlayerDraw;
  signal dealerDraws;
  signal dealerThird;
  signal playerFinal;
  signal dealerFinal;
  signal notNatural;
  signal playerStoodFlag;
  signal dealerDrawsAfterPlayerDrawFlag;
  signal playerTotalAfterDraw;
  signal dealerTotalAfterDraw;
  signal playerDrawsActive;

  signal output winner; // 0 = player, 1 = dealer, 2 = tie

  component cardToRank[6];
  component playerSum;
  component dealerSum;
  component playerNatural;
  component dealerNatural;
  component naturalOr;
  component playerLe5;
  component dealerLe5;
  component dealerDrawRules;
  component playerDrawSum;
  component dealerDrawSum;
  component playerDrawMux;
  component dealerDrawMux;
  component playerNaturalMux;
  component dealerNaturalMux;
  component dealerThirdMux;
  component dealerGtPlayer;
  component tie;

  for (var i = 0; i < 6; i++) {
    cardToRank[i] = CardToRank(shoeSize);
    cardToRank[i].card <== cards[i];
    values[i] <== cardToRank[i].rank;
  }

  playerSum = Mod10Sum2();
  playerSum.a <== values[0];
  playerSum.b <== values[1];
  playerTotal2 <== playerSum.out;

  dealerSum = Mod10Sum2();
  dealerSum.a <== values[2];
  dealerSum.b <== values[3];
  dealerTotal2 <== dealerSum.out;

  playerNatural = GreaterThan(4);
  playerNatural.in[0] <== playerTotal2;
  playerNatural.in[1] <== 7;

  dealerNatural = GreaterThan(4);
  dealerNatural.in[0] <== dealerTotal2;
  dealerNatural.in[1] <== 7;

  naturalOr = OR();
  naturalOr.a <== playerNatural.out;
  naturalOr.b <== dealerNatural.out;
  natural <== naturalOr.out;

  playerLe5 = LessThan(5);
  playerLe5.in[0] <== playerTotal2;
  playerLe5.in[1] <== 6;

  notNatural <== 1 - natural;
  playerDraws <== notNatural * playerLe5.out;

  dealerLe5 = LessThan(5);
  dealerLe5.in[0] <== dealerTotal2;
  dealerLe5.in[1] <== 6;
  playerStoodFlag <== notNatural * (1 - playerDraws);
  dealerDrawsWhenPlayerStood <== playerStoodFlag * dealerLe5.out;

  dealerDrawRules = DealerDrawsAfterPlayerDraw();
  dealerDrawRules.dealerTotal <== dealerTotal2;
  dealerDrawRules.playerThird <== values[4];
  
  playerDrawsActive <== notNatural * playerDraws;
  dealerDrawsAfterPlayerDrawFlag <== playerDrawsActive * dealerDrawRules.out;
  dealerDrawsAfterPlayerDraw <== dealerDrawsAfterPlayerDrawFlag;

  dealerDraws <== dealerDrawsWhenPlayerStood + dealerDrawsAfterPlayerDraw;

  // Player third card is always values[4]. Dealer uses values[5] if the player
  // drew, otherwise values[4].
  dealerThirdMux = Mux1();
  dealerThirdMux.c[0] <== values[4];
  dealerThirdMux.c[1] <== values[5];
  dealerThirdMux.s <== playerDraws;
  dealerThird <== dealerThirdMux.out;

  playerDrawSum = Mod10Sum2();
  playerDrawSum.a <== playerTotal2;
  playerDrawSum.b <== values[4];

  playerDrawMux = Mux1();
  playerDrawMux.c[0] <== playerTotal2;
  playerDrawMux.c[1] <== playerDrawSum.out;
  playerDrawMux.s <== playerDraws;
  playerTotalAfterDraw <== playerDrawMux.out;

  playerNaturalMux = Mux1();
  playerNaturalMux.c[0] <== playerTotalAfterDraw;
  playerNaturalMux.c[1] <== playerTotal2;
  playerNaturalMux.s <== natural;
  playerFinal <== playerNaturalMux.out;

  dealerDrawSum = Mod10Sum2();
  dealerDrawSum.a <== dealerTotal2;
  dealerDrawSum.b <== dealerThird;

  dealerDrawMux = Mux1();
  dealerDrawMux.c[0] <== dealerTotal2;
  dealerDrawMux.c[1] <== dealerDrawSum.out;
  dealerDrawMux.s <== dealerDraws;
  dealerTotalAfterDraw <== dealerDrawMux.out;

  dealerNaturalMux = Mux1();
  dealerNaturalMux.c[0] <== dealerTotalAfterDraw;
  dealerNaturalMux.c[1] <== dealerTotal2;
  dealerNaturalMux.s <== natural;
  dealerFinal <== dealerNaturalMux.out;

  dealerGtPlayer = GreaterThan(4);
  dealerGtPlayer.in[0] <== dealerFinal;
  dealerGtPlayer.in[1] <== playerFinal;

  tie = IsEqual();
  tie.in <== [playerFinal, dealerFinal];

  winner <== dealerGtPlayer.out + 2 * tie.out;
}