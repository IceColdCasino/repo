/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./poker_card.circom";

template CardMapper(n) {
  assert(n >= 5 && n <= 7);

  signal input cards[n];

  signal rankMapCounter[n+1][13];
  signal suitMapCounter[n+1][4];

  signal output rankMap[13];
  signal output suitMap[4];

  component cartToRankAndSuit[n];
  component rankEqCheck[n][13];
  component suitEqCheck[n][13];
  component rankCountLt[n][13];
  component suitCountLt[n][4];

  for (var r = 0; r < 13; r++) {
    rankMapCounter[0][r] <== 0;
  }

  for (var s = 0; s < 4; s++) {
    suitMapCounter[0][s] <== 0;
  }

  for (var i = 0; i < n; i++) {
    cartToRankAndSuit[i] = CardToRankAndSuit();
    cartToRankAndSuit[i].card <== cards[i];

    for (var r = 0; r < 13; r++) {
      rankEqCheck[i][r] = IsEqual();
      rankEqCheck[i][r].in <== [cartToRankAndSuit[i].rank, r];
      rankMapCounter[i+1][r] <== rankMapCounter[i][r] + 1 * rankEqCheck[i][r].out;
      rankCountLt[i][r] = ConstrainLt(4, 5);
      rankCountLt[i][r].in <== rankMapCounter[i+1][r];
    }

    for (var s = 0; s < 4; s++) {
      suitEqCheck[i][s] = IsEqual();
      suitEqCheck[i][s].in <== [cartToRankAndSuit[i].suit, s];
      suitMapCounter[i+1][s] <== suitMapCounter[i][s] + 1 * suitEqCheck[i][s].out;
      suitCountLt[i][s] = ConstrainLt(4, n + 1);
      suitCountLt[i][s].in <== suitMapCounter[i+1][s];
    }
  }

  rankMap <== rankMapCounter[n];
  suitMap <== suitMapCounter[n];
}

template StraightFlushChecker(n) { // 9
  assert(n >= 5 && n <= 7);

  signal input cards[n];

  signal straightFlushCounter[5][10][6];
  signal straightFlushCardCounter[5][10][5][n + 1];
  signal straightFlushHighCardForRankCounter[5][11];
  signal straightFlushHighCardForSuitCounter[5][11];
  signal highRank[5];
  signal highSuit[5];
  signal handRank;

  signal output evaluated[7];

  component eqCheck[4][10][5][n];
  component ltCheck[4][10];
  component ltOrCheck[4][10];
  component ltOrCheck2[4][10];
  component ltOrCheck3[4];
  component ltOrCheck4[4];
  component ltCheck2;
  component wheelCheck;
  component orCheck;

  highRank[0] <== 0;
  highSuit[0] <== 0;

  for (var s = 0; s < 4; s++) {
    straightFlushHighCardForRankCounter[s][10] <== 0;
    straightFlushHighCardForSuitCounter[s][10] <== 0;

    for (var r = 12; r > 2; r--) {
      var checkIndex = r - 3;

      straightFlushCounter[s][checkIndex][0] <== 0;

      for (var i = 0; i < 5; i++) {
        var rankIndex = r < i ? 12 : r - i;

        straightFlushCardCounter[s][checkIndex][i][0] <== 0;

        for (var c = 0; c < n; c++) {
          eqCheck[s][checkIndex][i][c] = IsEqual();
          eqCheck[s][checkIndex][i][c].in <== [s * 13 + rankIndex, cards[c]];
          straightFlushCardCounter[s][checkIndex][i][c+1] <== straightFlushCardCounter[s][checkIndex][i][c] + eqCheck[s][checkIndex][i][c].out;
        }

        straightFlushCounter[s][checkIndex][i+1] <== straightFlushCounter[s][checkIndex][i] + straightFlushCardCounter[s][checkIndex][i][n];
      }

      ltCheck[s][checkIndex] = LessThan(4);
      ltCheck[s][checkIndex].in <== [4, straightFlushCounter[s][checkIndex][5]];
      ltOrCheck[s][checkIndex] = LessThanOR(4);
      ltOrCheck[s][checkIndex].in <== [straightFlushHighCardForRankCounter[s][checkIndex+1], ltCheck[s][checkIndex].out * r];
      straightFlushHighCardForRankCounter[s][checkIndex] <== ltOrCheck[s][checkIndex].out;
      ltOrCheck2[s][checkIndex] = LessThanOR(4);
      ltOrCheck2[s][checkIndex].in <== [straightFlushHighCardForSuitCounter[s][checkIndex+1], ltCheck[s][checkIndex].out * s];
      straightFlushHighCardForSuitCounter[s][checkIndex] <== ltOrCheck2[s][checkIndex].out;
    }

    ltOrCheck3[s] = LessThanOR(4);
    ltOrCheck3[s].in <== [highRank[s], straightFlushHighCardForRankCounter[s][0]];
    highRank[s + 1] <== ltOrCheck3[s].out;

    ltOrCheck4[s] = LessThanOR(4);
    ltOrCheck4[s].in <== [highSuit[s], straightFlushHighCardForSuitCounter[s][0]];
    highSuit[s + 1] <== ltOrCheck4[s].out;
  }

  ltCheck2 = LessThan(4);
  ltCheck2.in <== [2, highRank[4]];
  handRank <== ltCheck2.out * 9;

  handRank * (handRank - 9) === 0;

  wheelCheck = IsEqual();
  wheelCheck.in <== [highRank[4], 3];
  orCheck = OR();
  orCheck.a <== wheelCheck.out * 12;
  orCheck.b <== (1 - wheelCheck.out) * (highRank[4] - 4 * ltCheck2.out);

  evaluated <== [
    handRank,
    ltCheck2.out * highRank[4],
    ltCheck2.out * highRank[4] - 1 * ltCheck2.out,
    ltCheck2.out * highRank[4] - 2 * ltCheck2.out,
    ltCheck2.out * highRank[4] - 3 * ltCheck2.out,
    ltCheck2.out * orCheck.out,
    highSuit[4]
  ];
}

template FourOfAKindChecker() { // 8
  signal input rankMap[13];

  signal kindCounter[14];
  signal kickerCounter[14];
  signal handRank;
  signal kind;
  signal kicker;

  signal output evaluated[7];

  component andCheck[13];
  component eqCheck[13];
  component gtCheck[13];
  component gtCheck2[13];
  component gtCheck3;
  component orCheck[13];
  component orCheck2[13];

  kindCounter[13] <== 0;
  kickerCounter[13] <== 0;

  for (var r = 12; r >= 0; r--) {
    eqCheck[r] = IsEqual();
    eqCheck[r].in <== [rankMap[r], 4];

    orCheck[r] = OR();
    orCheck[r].a <== eqCheck[r].out * (r + 1);
    orCheck[r].b <== (1 - eqCheck[r].out) * kindCounter[r+1];
    kindCounter[r] <== orCheck[r].out;

    gtCheck[r] = LessThan(4);
    gtCheck[r].in <== [0, rankMap[r]];

    andCheck[r] = AND();
    andCheck[r].a <== (1 - eqCheck[r].out);
    andCheck[r].b <== gtCheck[r].out;

    gtCheck2[r] = LessThan(4);
    gtCheck2[r].in <== [kickerCounter[r+1], andCheck[r].out * r];

    orCheck2[r] = OR();
    orCheck2[r].a <== gtCheck2[r].out * r;
    orCheck2[r].b <== (1 - gtCheck2[r].out) * kickerCounter[r+1];

    kickerCounter[r] <== orCheck2[r].out;
  }

  gtCheck3 = LessThan(4);
  gtCheck3.in <== [0, kindCounter[0]];

  handRank <== gtCheck3.out * 8;
  kind <== gtCheck3.out * kindCounter[0] - gtCheck3.out;
  kicker <== kickerCounter[0];

  handRank * (handRank - 8) === 0;

  evaluated <== [
    handRank,
    kind,
    kicker,
    0,
    0,
    0,
    0
  ];
}

template FullHouseChecker() { // 7
  signal input rankMap[13];

  signal set[14];
  signal pair[14];
  signal nextPair[13];
  signal handRank;

  signal output evaluated[7];

  component eqCheck[13];
  component ltCheck[13];
  component ltCheck2[13];
  component ltCheck3[13];
  component ltCheck4[13];
  component orCheck[13];
  component orCheck2[13];
  component gtCheck;
  component gtCheck2;

  set[13] <== 0;
  pair[13] <== 0;

  for (var r = 12; r >= 0; r--) {
    ltCheck[r] = LessThan(4);
    ltCheck[r].in <== [0, set[r + 1]];

    ltCheck2[r] = LessThan(4);
    ltCheck2[r].in <== [2, rankMap[r]];

    orCheck[r] = OR();
    orCheck[r].a <== ltCheck[r].out * set[r + 1];
    orCheck[r].b <== (1 - ltCheck[r].out) * ltCheck2[r].out * (r + 1);
    set[r] <== orCheck[r].out;

    eqCheck[r] = IsEqual();
    eqCheck[r].in <== [set[r], r + 1];

    ltCheck3[r] = LessThan(4);
    ltCheck3[r].in <== [pair[r + 1], 1];

    ltCheck4[r] = LessThan(4);
    ltCheck4[r].in <== [1, rankMap[r]];

    nextPair[r] <== (1 - eqCheck[r].out) * ltCheck4[r].out * (r + 1);

    orCheck2[r] = OR();
    orCheck2[r].a <== (1 - ltCheck3[r].out) * pair[r + 1];
    orCheck2[r].b <== ltCheck3[r].out * nextPair[r];
    pair[r] <== orCheck2[r].out;
  }

  gtCheck = LessThan(4);
  gtCheck.in <== [0, set[0]];

  gtCheck2 = LessThan(4);
  gtCheck2.in <== [0, pair[0]];

  handRank <== gtCheck.out * gtCheck2.out * 7;

  evaluated <== [
    handRank,
    gtCheck.out * set[0] - gtCheck.out,
    gtCheck2.out * pair[0] - gtCheck2.out,
    0,
    0,
    0,
    0
  ];
}

template FlushChecker(n) { // 6
  assert(n >= 5 && n <= 7);

  signal input cards[n];
  signal input suitMap[4];

  signal isFlushCounter[5];
  signal flushCounter[5];
  signal handRank;
  signal flushSuit;
  signal filteredCardRanks[n][14];
  signal filteredRanks[n];
  signal kickers[5];

  signal output evaluated[7];

  component ltCheck[4];
  component eqCheck[n][13];
  component ltOrCheck[n][13];
  component sortDesc;

  isFlushCounter[0] <== 0;
  flushCounter[0] <== 0;

  for (var s = 0; s < 4; s++) {
    ltCheck[s] = LessThan(4);
    ltCheck[s].in <== [4, suitMap[s]];
    isFlushCounter[s+1] <== isFlushCounter[s] + ltCheck[s].out;
    flushCounter[s+1] <== flushCounter[s] + s * ltCheck[s].out;
  }

  handRank <== isFlushCounter[4] * 6;
  flushSuit <== flushCounter[4];

  handRank * (handRank - 6) === 0;

  for (var c = 0; c < n; c++) {
    filteredCardRanks[c][13] <== 0;

    for (var r = 12; r >= 0; r--) {
      eqCheck[c][r] = IsEqual();
      eqCheck[c][r].in <== [flushSuit * 13 + r, cards[c]];
      ltOrCheck[c][r] = LessThanOR(4);
      ltOrCheck[c][r].in <== [filteredCardRanks[c][r + 1], eqCheck[c][r].out * r];
      filteredCardRanks[c][r] <== ltOrCheck[c][r].out;
    }

    filteredRanks[c] <== filteredCardRanks[c][0];
  }

  sortDesc = SortDescending(n, 5);
  sortDesc.in <== filteredRanks;

  for (var i = 0; i < 5; i++) {
    kickers[i] <== isFlushCounter[4] * sortDesc.out[i];
  }

  // Range checks (not pairwise order): non-flush kickers are all 0 and must still satisfy.
  component flushKickerLt[5];
  flushKickerLt[0] = ConstrainLt(4, 13);
  flushKickerLt[0].in <== kickers[0];
  flushKickerLt[1] = ConstrainLt(4, 12);
  flushKickerLt[1].in <== kickers[1];
  flushKickerLt[2] = ConstrainLt(4, 11);
  flushKickerLt[2].in <== kickers[2];
  flushKickerLt[3] = ConstrainLt(4, 10);
  flushKickerLt[3].in <== kickers[3];
  flushKickerLt[4] = ConstrainLt(4, 9);
  flushKickerLt[4].in <== kickers[4];

  evaluated <== [
    handRank,
    kickers[0],
    kickers[1],
    kickers[2],
    kickers[3],
    kickers[4],
    flushSuit
  ];
}

template StraightChecker() { // 5
  signal input rankMap[13];

  signal output evaluated[7];

  signal kickerCounter[11];
  signal handRank;

  component andCheck[10][6];
  component ltCheck[10][5];
  component ltOrCheck[10];
  component ltCheck2;
  component wheelCheck;
  component orCheck;

  kickerCounter[10] <== 0;

  for (var r = 12; r > 2; r--) {
    var checkIndex = r - 3;

    for (var i = 0; i < 5; i++) {
      var rankIndex = r < i ? 12 : r - i;

      ltCheck[checkIndex][i] = LessThan(4);
      ltCheck[checkIndex][i].in <== [0, rankMap[rankIndex]];
      andCheck[checkIndex][i] = AND();
      andCheck[checkIndex][i].a <== i < 1 ? 1 : andCheck[checkIndex][i-1].out;
      andCheck[checkIndex][i].b <== ltCheck[checkIndex][i].out;
    }

    ltOrCheck[checkIndex] = LessThanOR(4);
    ltOrCheck[checkIndex].in <== [kickerCounter[checkIndex + 1], andCheck[checkIndex][4].out * r];
    kickerCounter[checkIndex] <== ltOrCheck[checkIndex].out;
  }

  ltCheck2 = LessThan(4);
  ltCheck2.in <== [2, kickerCounter[0]];
  handRank <== 5 * ltCheck2.out;

  handRank * (handRank - 5) === 0;

  wheelCheck = IsEqual();
  wheelCheck.in <== [kickerCounter[0], 3];
  orCheck = OR();
  orCheck.a <== wheelCheck.out * 12;
  orCheck.b <== (1 - wheelCheck.out) * (kickerCounter[0] - 4 * ltCheck2.out);

  evaluated <== [
    handRank,
    ltCheck2.out * kickerCounter[0],
    ltCheck2.out * kickerCounter[0] - 1 * ltCheck2.out,
    ltCheck2.out * kickerCounter[0] - 2 * ltCheck2.out,
    ltCheck2.out * kickerCounter[0] - 3 * ltCheck2.out,
    ltCheck2.out * orCheck.out,
    0
  ];
}

template ThreeOfAKindChecker() { // 4
  signal input rankMap[13];

  signal kindCounter[14];
  signal filteredRanks[13];
  signal handRank;
  signal kind;
  signal kickers[2];

  signal output evaluated[7];

  component eqCheck[13];
  component eqCheck2[13];
  component orCheck[13];
  component ltCheck;
  component sortDesc;

  kindCounter[13] <== 0;

  for (var r = 12; r >= 0; r--) {
    eqCheck[r] = IsEqual();
    eqCheck[r].in <== [rankMap[r], 3];
    orCheck[r] = OR();
    orCheck[r].a <== eqCheck[r].out * (r + 1);
    orCheck[r].b <== (1 - eqCheck[r].out) * kindCounter[r+1];
    kindCounter[r] <== orCheck[r].out;

    eqCheck2[r] = IsEqual();
    eqCheck2[r].in <== [rankMap[r], 1];
    filteredRanks[r] <== eqCheck2[r].out * r;
  }

  ltCheck = LessThan(4);
  ltCheck.in <== [0, kindCounter[0]];

  handRank <== ltCheck.out * 4;

  handRank * (handRank - 4) === 0;

  kind <== ltCheck.out * kindCounter[0] - ltCheck.out;

  sortDesc = SortDescending(13, 2);
  sortDesc.in <== filteredRanks;

  kickers <== [
    ltCheck.out * sortDesc.out[0],
    ltCheck.out * sortDesc.out[1]
  ];

  evaluated <== [
    handRank,
    kind,
    kickers[0],
    kickers[1],
    0,
    0,
    0
  ];
}

template PairChecker() { // 2,3
  signal input rankMap[13];

  signal filteredKinds[13];
  signal filteredRanks[13];
  signal handRank;
  signal handRankPairProduct;

  signal output evaluated[7];

  component eqCheck[13];
  component eqCheck2[13];
  component ltCheck;
  component ltCheck2;
  component ltCheck3;
  component sortDescKinds;
  component sortDescKickers;
  component orCheck2;
  component orCheck3;
  component orCheck4;
  component hasThirdPair;
  component maxExtraKicker;

  for (var r = 12; r >= 0; r--) {
    eqCheck[r] = IsEqual();
    eqCheck[r].in <== [rankMap[r], 2];
    filteredKinds[r] <== eqCheck[r].out * (r + 1);

    eqCheck2[r] = IsEqual();
    eqCheck2[r].in <== [rankMap[r], 1];
    filteredRanks[r] <== eqCheck2[r].out * r;
  }

  sortDescKinds = SortDescending(13, 3);
  sortDescKinds.in <== filteredKinds;

  ltCheck = LessThan(4);
  ltCheck.in <== [0, sortDescKinds.out[0]];

  ltCheck2 = LessThan(4);
  ltCheck2.in <== [0, sortDescKinds.out[1]];

  ltCheck3 = LessThan(4);
  ltCheck3.in <== [0, ltCheck.out + ltCheck2.out];

  handRank <== ltCheck3.out * (ltCheck.out + ltCheck2.out + 1);

  handRankPairProduct <== handRank * (handRank - 2);
  handRankPairProduct * (handRank - 3) === 0;

  sortDescKickers = SortDescending(13, 3);
  sortDescKickers.in <== filteredRanks;

  hasThirdPair = LessThan(4);
  hasThirdPair.in <== [0, sortDescKinds.out[2]];

  maxExtraKicker = LessThanOR(4);
  maxExtraKicker.in <== [
    hasThirdPair.out * (sortDescKinds.out[2] - 1),
    sortDescKickers.out[0]
  ];

  orCheck2 = OR();
  orCheck2.a <== ltCheck2.out * (sortDescKinds.out[1] - 1);
  orCheck2.b <== (1 - ltCheck2.out) * sortDescKickers.out[0];

  orCheck3 = OR();
  orCheck3.a <== ltCheck2.out * maxExtraKicker.out;
  orCheck3.b <== (1 - ltCheck2.out) * sortDescKickers.out[1];

  orCheck4 = OR();
  orCheck4.a <== ltCheck2.out * 0;
  orCheck4.b <== (1 - ltCheck2.out) * sortDescKickers.out[2];

  evaluated <== [
    handRank,
    ltCheck.out * (sortDescKinds.out[0] - 1),
    orCheck2.out,
    orCheck3.out,
    orCheck4.out,
    0,
    0
  ];
}

template HighCardChecker() { // 1
  signal input rankMap[13];

  signal filteredRanks[13];

  signal output evaluated[7];

  component eqCheck[13];
  component sortDesc;

  for (var r = 12; r >= 0; r--) {
    eqCheck[r] = IsEqual();
    eqCheck[r].in <== [rankMap[r], 1];
    filteredRanks[r] <== eqCheck[r].out * r;
  }

  sortDesc = SortDescending(13, 5);
  sortDesc.in <== filteredRanks;

  evaluated <== [
    1,
    sortDesc.out[0],
    sortDesc.out[1],
    sortDesc.out[2],
    sortDesc.out[3],
    sortDesc.out[4],
    0
  ];
}

template HandEval(n) {
  assert(n >= 5 && n <= 7);

  signal input cards[n];

  signal intermediateEvals[8][7];
  signal intermediateEvalCounter[9][7];
  signal flushStraightProduct;

  signal output evaluated[7];

  component cardMaps;
  component straightFlushCheck;
  component fourOfAKindCheck;
  component fullHouseCheck;
  component flushCheck;
  component straightCheck;
  component threeOfAKindCheck;
  component pairCheck;
  component highCardCheck;
  component ltCheck[8];
  component orCheck[8][7];

  cardMaps = CardMapper(n);
  cardMaps.cards <== cards;

  straightFlushCheck = StraightFlushChecker(n);
  straightFlushCheck.cards <== cards;
  intermediateEvals[7] <== straightFlushCheck.evaluated;

  fourOfAKindCheck = FourOfAKindChecker();
  fourOfAKindCheck.rankMap <== cardMaps.rankMap;
  intermediateEvals[6] <== fourOfAKindCheck.evaluated;

  fullHouseCheck = FullHouseChecker();
  fullHouseCheck.rankMap <== cardMaps.rankMap;
  intermediateEvals[5] <== fullHouseCheck.evaluated;

  flushCheck = FlushChecker(n);
  flushCheck.cards <== cards;
  flushCheck.suitMap <== cardMaps.suitMap;
  intermediateEvals[4] <== flushCheck.evaluated;

  straightCheck = StraightChecker();
  straightCheck.rankMap <== cardMaps.rankMap;
  intermediateEvals[3] <== straightCheck.evaluated;

  flushStraightProduct <== flushCheck.evaluated[0] * straightCheck.evaluated[0];
  straightFlushCheck.evaluated[0] * (flushStraightProduct - 30) === 0;

  threeOfAKindCheck = ThreeOfAKindChecker();
  threeOfAKindCheck.rankMap <== cardMaps.rankMap;
  intermediateEvals[2] <== threeOfAKindCheck.evaluated;

  pairCheck = PairChecker();
  pairCheck.rankMap <== cardMaps.rankMap;
  intermediateEvals[1] <== pairCheck.evaluated;

  highCardCheck = HighCardChecker();
  highCardCheck.rankMap <== cardMaps.rankMap;
  intermediateEvals[0] <== highCardCheck.evaluated;

  intermediateEvalCounter[8] <== [0, 0, 0, 0, 0, 0, 0];

  for (var i = 7; i >= 0; i--) {
    ltCheck[i] = LessThan(4);
    ltCheck[i].in <== [intermediateEvalCounter[i+1][0], intermediateEvals[i][0]];

    for (var j = 0; j < 7; j++) {
      orCheck[i][j] = OR();
      orCheck[i][j].a <== ltCheck[i].out * intermediateEvals[i][j];
      orCheck[i][j].b <== (1 - ltCheck[i].out) * intermediateEvalCounter[i+1][j];
      intermediateEvalCounter[i][j] <== orCheck[i][j].out;
    }
  }

  evaluated <== intermediateEvalCounter[0];
}
