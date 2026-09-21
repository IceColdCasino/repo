/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./helpers.circom";

template CardToRank(shoeSize) {
  var nCards = 52 * shoeSize;
  var baccaratRanks[13] = [2, 3, 4, 5, 6, 7, 8, 9, 0, 0, 0, 0, 1];

  signal input card; // Card number (0 to 51)

  signal rankCounter[nCards + 1];
  
  signal output rank; // 0 to 9

  component lt;
  component rankLt;
  component eqCheck[nCards];
  component ltOrCheck[nCards];
  component ltOrCheck2[nCards];

  lt = ConstrainLt(9, nCards);
  lt.in <== card;

  rankCounter[0] <== 0;

  for (var d = 0; d < shoeSize; d++) {
    for (var s = 0; s < 4; s++) {
      for (var r = 0; r < 13; r++) {
        var i = d * 52 + s * 13 + r;

        eqCheck[i] = IsEqual();
        eqCheck[i].in <== [card, i];

        ltOrCheck[i] = LessThanOR(6);
        ltOrCheck[i].in <== [rankCounter[i], baccaratRanks[r] * eqCheck[i].out];
        rankCounter[i + 1] <== ltOrCheck[i].out;
      }
    }
  }

  rank <== rankCounter[nCards];

  rankLt = ConstrainLt(4, 10);
  rankLt.in <== rank;
}
