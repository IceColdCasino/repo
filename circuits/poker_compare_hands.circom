/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "circuits/bitify.circom";
include "circuits/comparators.circom";
include "circuits/gates.circom";
include "./poker_hand_eval.circom";

template FindMaxHandFromEvaluatedHands(n) {
  signal input hands[n][7];

  signal maxHand[n + 1][6];
  signal eq_so_far[n][7];
  signal better[n][7];
  signal gt_eq_so_far[n][6];

  signal output out[6];

  component eq[n][6];
  component gt[n][6];
  component or[n][6];

  for (var i = 0; i < 6; i++) {
    maxHand[0][i] <== 0;
  }

  for (var h = 0; h < n; h++) {
    eq_so_far[h][0] <== 1;
    better[h][0] <== 0;

    for (var i = 0; i < 6; i++) {
      eq[h][i] = IsEqual();
      eq[h][i].in[0] <== hands[h][i];
      eq[h][i].in[1] <== maxHand[h][i];

      gt[h][i] = GreaterThan(4);
      gt[h][i].in[0] <== hands[h][i];
      gt[h][i].in[1] <== maxHand[h][i];

      gt_eq_so_far[h][i] <== eq_so_far[h][i] * gt[h][i].out;

      or[h][i] = OR();
      or[h][i].a <== better[h][i];
      or[h][i].b <== gt_eq_so_far[h][i];
      better[h][i+1] <== or[h][i].out;

      eq_so_far[h][i + 1] <== eq_so_far[h][i] * eq[h][i].out;
    }

    for (var i = 0; i < 6; i++) {
      maxHand[h + 1][i] <== better[h][6] * (hands[h][i] - maxHand[h][i]) + maxHand[h][i];
    }
  }

  out <== maxHand[n];
}

template CompareEvaluatedHandsToMaxHand(n) {
  signal input maxHand[6];
  signal input hands[n][7];

  signal flag[n][7];
  signal winnerCounter[n+1];
  signal winnerCount;

  signal output winners[n];

  component eqCheck[n][6];
  component andCheck[n][6];
  component winnerCountGt;
  component winnerCountLt;

  winnerCounter[0] <== 0;

  for (var h = 0; h < n; h++) {
    flag[h][0] <== 1;

    for (var i = 0; i < 6; i++) {
      eqCheck[h][i] = IsEqual();
      eqCheck[h][i].in <== [hands[h][i], maxHand[i]];
      andCheck[h][i] = AND();
      andCheck[h][i].a <== eqCheck[h][i].out;
      andCheck[h][i].b <== flag[h][i];
      flag[h][i+1] <== andCheck[h][i].out;
    }

    winners[h] <== flag[h][6];
    winnerCounter[h+1] <== winnerCounter[h] + winners[h];
  }

  winnerCount <== winnerCounter[n];

  winnerCountGt = ConstrainGt(4, 0);
  winnerCountGt.in <== winnerCount;
  winnerCountLt = ConstrainLt(4, n + 1);
  winnerCountLt.in <== winnerCount;
}

template ComputeWinners(n) {
  signal input hands[n][7];

  signal output winners[n];

  component maxHandFinder;
  component compareToMax;

  maxHandFinder = FindMaxHandFromEvaluatedHands(n);
  maxHandFinder.hands <== hands;

  compareToMax = CompareEvaluatedHandsToMaxHand(n);
  compareToMax.maxHand <== maxHandFinder.out;
  compareToMax.hands <== hands;

  winners <== compareToMax.winners;
}

template CompareHands(nPlayers) {
  assert(nPlayers > 1 && nPlayers < 11);

  signal input mask;
  signal input maxInPot;
  signal input playerCards[nPlayers][2];
  signal input sharedCards[5];

  signal activePair[nPlayers][nPlayers];

  signal output winnerMask;

  component maskLt;
  component num2Bits;
  component handEval[nPlayers];
  component winnerComputer;
  component bits2Num;
  component isZero;
  component sharedDistinct[5][5];
  component playerCardDistinct[nPlayers];
  component playerSharedDistinct[nPlayers][2][5];
  component totalNotOne;
  component totalLtMax;
  component playerPlayerDistinct[nPlayers][nPlayers][2][2];

  maskLt = ConstrainLt(11, 2 ** 10);
  maskLt.in <== mask;

  for (var i = 0; i < 5; i++) {
    for (var j = i + 1; j < 5; j++) {
      sharedDistinct[i][j] = ConstrainNotEqual();
      sharedDistinct[i][j].in <== [sharedCards[i], sharedCards[j]];
    }
  }

  // Literal width silences non-strict Num2Bits warnings; nPlayers < 11.
  num2Bits = Num2Bits(10);
  num2Bits.in <== mask;
  for (var p = nPlayers; p < 10; p++) {
    num2Bits.out[p] === 0;
  }

  var totalInPot = 0;

  for (var p = 0; p < nPlayers; p++) {
    var maskBit = num2Bits.out[p];
    playerCardDistinct[p] = IsEqual();
    playerCardDistinct[p].in <== [playerCards[p][0], playerCards[p][1]];
    playerCardDistinct[p].out * maskBit === 0;
    for (var k = 0; k < 2; k++) {
      for (var m = 0; m < 5; m++) {
        playerSharedDistinct[p][k][m] = IsEqual();
        playerSharedDistinct[p][k][m].in <== [playerCards[p][k], sharedCards[m]];
        playerSharedDistinct[p][k][m].out * maskBit === 0;
      }
    }

    totalInPot += maskBit;
  }

  totalNotOne = ConstrainNotEqual();
  totalNotOne.in <== [totalInPot, 1];
  totalLtMax = ConstrainLtSignal(4);
  totalLtMax.in <== [totalInPot, maxInPot + 1];

  for (var p = 0; p < nPlayers; p++) {
    var maskBitP = num2Bits.out[p];
    for (var q = p + 1; q < nPlayers; q++) {
      var maskBitQ = num2Bits.out[q];
      activePair[p][q] <== maskBitP * maskBitQ;
      for (var k = 0; k < 2; k++) {
        for (var l = 0; l < 2; l++) {
          playerPlayerDistinct[p][q][k][l] = IsEqual();
          playerPlayerDistinct[p][q][k][l].in <== [playerCards[p][k], playerCards[q][l]];
          playerPlayerDistinct[p][q][k][l].out * activePair[p][q] === 0;
        }
      }
    }
  }

  winnerComputer = ComputeWinners(nPlayers);

  for (var player = 0; player < nPlayers; player++) {
    var maskBit = num2Bits.out[player];
    var invMaskBit = 1 - maskBit;

    handEval[player] = HandEval(7);
    handEval[player].cards <== [
      sharedCards[0] * maskBit,
      sharedCards[1] * maskBit + invMaskBit * 1,
      sharedCards[2] * maskBit + invMaskBit * 2,
      sharedCards[3] * maskBit + invMaskBit * 3,
      sharedCards[4] * maskBit + invMaskBit * 4,
      playerCards[player][0] * maskBit + invMaskBit * 5,
      playerCards[player][1] * maskBit + invMaskBit * 6
    ];
    
    for (var i = 0; i < 7; i++) {
      winnerComputer.hands[player][i] <== handEval[player].evaluated[i] * maskBit;
    }
  }

  bits2Num = Bits2Num(10);
  for (var p = 0; p < nPlayers; p++) {
    bits2Num.in[p] <== winnerComputer.winners[p];
  }
  for (var p = nPlayers; p < 10; p++) {
    bits2Num.in[p] <== 0;
  }

  // If mask is 0 (no players in pot), winnerMask should be 0
  // Otherwise, use computed winners
  isZero = IsZero();
  isZero.in <== mask;
  
  winnerMask <== bits2Num.out * (1 - isZero.out);
}
