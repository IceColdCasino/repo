/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./helpers.circom";

template CardToRankAndSuit() {
  var nCards = 52;

  signal input card; // Card number (0 to 51)

  signal rankCounter[nCards + 1];
  signal suitCounter[nCards + 1];

  signal output rank; // 0 to 12
  signal output suit; // 0 to 3

  component lt;
  component eqCheck[nCards];
  component ltOrCheck[nCards];
  component ltOrCheck2[nCards];

  lt = ConstrainLt(6, nCards);
  lt.in <== card;

  rankCounter[0] <== 0;
  suitCounter[0] <== 0;

  for (var s = 0; s < 4; s++) {
    for (var r = 0; r < 13; r++) {
      var i = s * 13 + r;

      eqCheck[i] = IsEqual();
      eqCheck[i].in <== [card, i];

      ltOrCheck[i] = LessThanOR(6);
      ltOrCheck[i].in <== [rankCounter[i], r * eqCheck[i].out];
      rankCounter[i + 1] <== ltOrCheck[i].out;

      ltOrCheck2[i] = LessThanOR(6);
      ltOrCheck2[i].in <== [suitCounter[i], s * eqCheck[i].out];
      suitCounter[i + 1] <== ltOrCheck2[i].out;
    }
  }

  rank <== rankCounter[nCards];
  suit <== suitCounter[nCards];

  card === rank + suit * 13;
}
