/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "circuits/comparators.circom";

// publicKeys are the other seats. The first nActualPlayers - 1 keys are real.
// The padded seats are the BabyJub identity (0, 1).
template ActualPlayersCheck(nOthers) {
  assert(nOthers <= 15);

  signal input publicKeys[nOthers][2];
  signal input nActualPlayers;

  signal activeBound;
  signal yMinus1[nOthers];
  signal bothIdentity[nOthers];
  signal inactive[nOthers];

  component activeLt[nOthers];
  component isZeroX[nOthers];
  component isZeroY[nOthers];

  activeBound <== nActualPlayers - 1;

  for (var i = 0; i < nOthers; i++) {
    activeLt[i] = LessThan(4);
    activeLt[i].in[0] <== i;
    activeLt[i].in[1] <== activeBound;

    isZeroX[i] = IsZero();
    isZeroX[i].in <== publicKeys[i][0];

    yMinus1[i] <== publicKeys[i][1] - 1;
    isZeroY[i] = IsZero();
    isZeroY[i].in <== yMinus1[i];

    bothIdentity[i] <== isZeroX[i].out * isZeroY[i].out;
    inactive[i] <== 1 - activeLt[i].out;

    activeLt[i].out * bothIdentity[i] === 0;
    inactive[i] * publicKeys[i][0] === 0;
    inactive[i] * yMinus1[i] === 0;
  }
}
