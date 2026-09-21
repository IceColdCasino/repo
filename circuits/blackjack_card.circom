/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./card_rank.circom";
include "circuits/comparators.circom";
include "circuits/mux1.circom";

// Base blackjack value for hard-sum (ace counts as 1).
// rank 0..7 (2-9) → rank+2; rank 8..11 (10,J,Q,K) → 10; rank 12 (ace) → 1
template RankToHardValue() {
  signal input rank;

  signal faceValue;
  signal pipValue;

  signal output value;
  signal output isAce;

  component eqAce;
  component gt7;
  component muxFace;
  component muxAce;

  eqAce = IsEqual();
  eqAce.in <== [rank, 12];
  isAce <== eqAce.out;

  gt7 = GreaterThan(4);
  gt7.in[0] <== rank;
  gt7.in[1] <== 7;

  pipValue <== rank + 2;
  faceValue <== 10;

  muxFace = Mux1();
  muxFace.s <== gt7.out;
  muxFace.c[0] <== pipValue;
  muxFace.c[1] <== faceValue;

  muxAce = Mux1();
  muxAce.s <== isAce;
  muxAce.c[0] <== muxFace.out;
  muxAce.c[1] <== 1;

  value <== muxAce.out;
}

template CardToHardValue(shoeSize) {
  signal input card;

  signal output value;
  signal output isAce;

  component rank;
  component val;

  rank = CardToRank(shoeSize);
  rank.card <== card;

  val = RankToHardValue();
  val.rank <== rank.rank;

  value <== val.value;
  isAce <== val.isAce;
}