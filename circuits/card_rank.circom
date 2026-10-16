/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./helpers.circom";

// Map a n-deck shoe card index (0..(52 * n - 1))) to rank 0..12 (2=0, 3=1, ..., Ace=12).
template CardToRank() {
  var nCards = 52;

  signal input card;
  
  signal rankCounter[nCards + 1];

  signal output rank;

  component lt;
  component rankLt;
  component eqCheck[nCards];
  component ltOrCheck[nCards];

  lt = ConstrainLt(9, 52);
  lt.in <== card;

  rankCounter[0] <== 0;

  for (var s = 0; s < 4; s++) {
    for (var r = 0; r < 13; r++) {
      var i = s * 13 + r;

      eqCheck[i] = IsEqual();
      eqCheck[i].in <== [card, i];

      ltOrCheck[i] = LessThanOR(6);
      ltOrCheck[i].in <== [rankCounter[i], r * eqCheck[i].out];
      rankCounter[i + 1] <== ltOrCheck[i].out;
    }
  }


  rank <== rankCounter[nCards];

  rankLt = ConstrainLt(4, 13);
  rankLt.in <== rank;
}