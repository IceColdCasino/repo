/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "circuits/comparators.circom";
include "circuits/mux1.circom";
include "circuits/gates.circom";
include "./helpers.circom";
include "./blackjack_card.circom";
include "./blackjack_constants.circom";

template HandValue(maxCards) {
  signal input cards[maxCards];
  signal input cardCount;

  signal active[maxCards];
  signal hardAcc[maxCards + 1];
  signal aceAcc[maxCards + 1];
  signal softSum;
  signal softOk;
  signal hardSum;

  signal output bestValue;
  signal output isBust;
  signal output isBlackjack;
  /// 1 when bestValue uses soft ace (softOk); needed for dealer H17/S17.
  signal output isSoft;

  component cardVal[maxCards];
  component ltCount[maxCards];
  component gt21Soft;
  component hasAce;
  component softMux;
  component gt21Best;
  component eq2;
  component eq21;
  component andBJ;

  hardAcc[0] <== 0;
  aceAcc[0] <== 0;

  for (var i = 0; i < maxCards; i++) {
    cardVal[i] = CardToHardValue(8);
    cardVal[i].card <== cards[i];

    ltCount[i] = LessThan(5);
    ltCount[i].in[0] <== i;
    ltCount[i].in[1] <== cardCount;
    active[i] <== ltCount[i].out;

    hardAcc[i + 1] <== hardAcc[i] + cardVal[i].value * active[i];
    aceAcc[i + 1] <== aceAcc[i] + cardVal[i].isAce * active[i];
  }

  hardSum <== hardAcc[maxCards];
  softSum <== hardSum + 10;

  // Hand sums reach up to 140 (13 cards × 10 + soft 10), and the constant 21
  // itself needs 5 bits, so these comparators must be 8-bit (operands < 256).
  gt21Soft = GreaterThan(8);
  gt21Soft.in[0] <== softSum;
  gt21Soft.in[1] <== 21;

  hasAce = GreaterThan(4);
  hasAce.in[0] <== aceAcc[maxCards];
  hasAce.in[1] <== 0;

  softOk <== hasAce.out * (1 - gt21Soft.out);
  isSoft <== softOk;

  softMux = Mux1();
  softMux.s <== softOk;
  softMux.c[0] <== hardSum;
  softMux.c[1] <== softSum;

  bestValue <== softMux.out;

  gt21Best = GreaterThan(8);
  gt21Best.in[0] <== bestValue;
  gt21Best.in[1] <== 21;
  isBust <== gt21Best.out;

  eq2 = IsEqual();
  eq2.in <== [cardCount, 2];

  eq21 = IsEqual();
  eq21.in <== [bestValue, 21];

  andBJ = AND();
  andBJ.a <== eq2.out;
  andBJ.b <== eq21.out;
  isBlackjack <== andBJ.out * (1 - isBust);
}

// 0=lose, 1=push, 2=win, 3=player natural blackjack (dealer non-BJ)
template CompareHandToDealer() {
  signal input playerValue;
  signal input playerBust;
  signal input playerBlackjack;
  signal input dealerValue;
  signal input dealerBust;
  signal input dealerBlackjack;

  signal notPBust;
  signal notDBust;
  signal cmpWin;
  signal cmpPush;
  signal bothOk;
  signal notBothBJ;
  signal notPBJ;
  signal notDBJ;
  signal ok1;
  signal ok2;
  signal okNoBj;
  signal selDealerBust;
  signal selBothBJ;
  signal selPlayerBJ;
  signal pbjOk;

  signal output out;

  component pBust;
  component dBust;
  component pBJ;
  component dBJ;
  component bothBJ;
  component pGtD;
  component pEqD;
  component mux0;
  component mux1;
  component mux2;
  component mux3;
  component mux4;
  component mux5;

  pBust = IsEqual();
  pBust.in <== [playerBust, 1];

  dBust = IsEqual();
  dBust.in <== [dealerBust, 1];

  pBJ = IsEqual();
  pBJ.in <== [playerBlackjack, 1];

  dBJ = IsEqual();
  dBJ.in <== [dealerBlackjack, 1];

  bothBJ = AND();
  bothBJ.a <== pBJ.out;
  bothBJ.b <== dBJ.out;

  // playerValue/dealerValue can reach 140, so 8-bit comparison (operands < 256).
  pGtD = GreaterThan(8);
  pGtD.in[0] <== playerValue;
  pGtD.in[1] <== dealerValue;

  pEqD = IsEqual();
  pEqD.in <== [playerValue, dealerValue];

  notPBust <== 1 - pBust.out;
  notDBust <== 1 - dBust.out;
  notBothBJ <== 1 - bothBJ.out;
  notPBJ <== 1 - pBJ.out;
  notDBJ <== 1 - dBJ.out;

  bothOk <== notPBust * notDBust;
  ok1 <== bothOk * notBothBJ;
  // Value compare only when neither side has a natural (dealer BJ beats made 21).
  
  okNoBj <== ok1 * notPBJ;
  ok2 <== okNoBj * notDBJ;
  cmpWin <== ok2 * pGtD.out;
  cmpPush <== ok2 * pEqD.out;

  selDealerBust <== dBust.out * notPBust;
  selBothBJ <== bothBJ.out * bothOk;
  
  pbjOk <== pBJ.out * notDBJ;
  selPlayerBJ <== pbjOk * bothOk;

  mux1 = Mux1();
  mux1.s <== selDealerBust;
  mux1.c[0] <== 0;
  mux1.c[1] <== 2;

  mux2 = Mux1();
  mux2.s <== selBothBJ;
  mux2.c[0] <== mux1.out;
  mux2.c[1] <== 1;

  mux3 = Mux1();
  mux3.s <== selPlayerBJ;
  mux3.c[0] <== mux2.out;
  mux3.c[1] <== 3;

  mux4 = Mux1();
  mux4.s <== cmpWin;
  mux4.c[0] <== mux3.out;
  mux4.c[1] <== 2;

  mux5 = Mux1();
  mux5.s <== cmpPush;
  mux5.c[0] <== mux4.out;
  mux5.c[1] <== 1;

  mux0 = Mux1();
  mux0.s <== pBust.out;
  mux0.c[0] <== mux5.out;
  mux0.c[1] <== 0;

  out <== mux0.out;
}

// One non-busted hand vs dealer. Production showdown path.
// `cards` is dense: player used || dealer used || pad (nUsed = playerCardCount + dealerCardCount).
template EvaluateHand() {
  var nCardsPerHand = maxCardsPerHand();
  var nDealerCards = maxDealerCards();
  var nTotalCards = nCardsPerHand + nDealerCards;

  signal input cards[nTotalCards];
  signal input playerCardCount;
  signal input dealerCardCount;

  signal dealerPick[nDealerCards][nTotalCards];
  signal dealerAcc[nDealerCards][nTotalCards + 1];
  signal dealerCards[nDealerCards];

  signal output out;

  component ltPlayerCards;
  component ltDealerCards;
  component playerHand;
  component dealerIdxEq[nDealerCards][nTotalCards];
  component dealerHand;
  component cmp;

  ltPlayerCards = ConstrainLt(4, nCardsPerHand);
  ltPlayerCards.in <== playerCardCount;

  ltDealerCards = ConstrainLt(4, nDealerCards);
  ltDealerCards.in <== dealerCardCount;

  playerHand = HandValue(nCardsPerHand);
  for (var i = 0; i < nCardsPerHand; i++) {
    playerHand.cards[i] <== cards[i];
  }
  playerHand.cardCount <== playerCardCount;

  // Bust hands settle via action proof; showdown requires a live hand.
  playerHand.isBust === 0;
  // Soft flag is unused here (value + isBlackjack drive outcomes).
  playerHand.isSoft * (playerHand.isSoft - 1) === 0;

  for (var d = 0; d < nDealerCards; d++) {
    dealerAcc[d][0] <== 0;
    for (var j = 0; j < nTotalCards; j++) {
      dealerIdxEq[d][j] = IsEqual();
      dealerIdxEq[d][j].in[0] <== j;
      dealerIdxEq[d][j].in[1] <== playerCardCount + d;
      dealerPick[d][j] <== cards[j] * dealerIdxEq[d][j].out;
      dealerAcc[d][j + 1] <== dealerAcc[d][j] + dealerPick[d][j];
    }
    dealerCards[d] <== dealerAcc[d][nTotalCards];
  }

  dealerHand = HandValue(nDealerCards);
  dealerHand.cards <== dealerCards;
  dealerHand.cardCount <== dealerCardCount;

  dealerHand.isSoft * (dealerHand.isSoft - 1) === 0;

  cmp = CompareHandToDealer();
  cmp.playerValue <== playerHand.bestValue;
  cmp.playerBust <== playerHand.isBust;
  cmp.playerBlackjack <== playerHand.isBlackjack;
  cmp.dealerValue <== dealerHand.bestValue;
  cmp.dealerBust <== dealerHand.isBust;
  cmp.dealerBlackjack <== dealerHand.isBlackjack;

  out <== cmp.out;
}
