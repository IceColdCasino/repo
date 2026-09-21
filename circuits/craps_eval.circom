/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "circuits/comparators.circom";

// Phase-local action class is `action % 3`:
//   0 Pass wins    1 Don't Pass wins    2 continue
//
// Come-out (phase = 0), `point` must be 0:
//   0 NATURAL   7 or 11
//   1 CRAPS     2, 3, or 12
//   2 POINT     4, 5, 6, 8, 9, or 10  (pointOut = total)
//
// Point (phase = 1), `point` in {4,5,6,8,9,10}:
//   3 PASS      total == point
//   4 SEVEN_OUT total == 7
//   5 REROLL    any other total
template CrapsEval() {
  signal input diceValues[2];
  signal input phase;
  signal input point;

  signal output action;
  signal output pointOut;

  signal total;
  signal isFace[11];
  signal natural;
  signal craps;
  signal box;
  signal pointMatch[6];
  signal validPointAcc[7];
  signal validPoint;
  signal comeOut;
  signal comeNatural;
  signal comeCraps;
  signal comePoint;
  signal hitPoint;
  signal sevenOut;
  signal notHit;
  signal notSeven;
  signal phaseNotHit;
  signal reroll;
  signal established;
  signal echoed;

  component eqTotal[11];
  component eqPoint[6];
  component hitEq;

  total <== diceValues[0] + diceValues[1] + 2;

  for (var t = 2; t <= 12; t++) {
    eqTotal[t - 2] = IsEqual();
    eqTotal[t - 2].in[0] <== total;
    eqTotal[t - 2].in[1] <== t;
    isFace[t - 2] <== eqTotal[t - 2].out;
  }

  natural <== isFace[5] + isFace[9];
  craps <== isFace[0] + isFace[1] + isFace[10];
  box <== isFace[2] + isFace[3] + isFace[4] + isFace[6] + isFace[7] + isFace[8];

  var pointVals[6] = [4, 5, 6, 8, 9, 10];
  validPointAcc[0] <== 0;
  for (var i = 0; i < 6; i++) {
    eqPoint[i] = IsEqual();
    eqPoint[i].in[0] <== point;
    eqPoint[i].in[1] <== pointVals[i];
    pointMatch[i] <== eqPoint[i].out;
    validPointAcc[i + 1] <== validPointAcc[i] + pointMatch[i];
  }
  validPoint <== validPointAcc[6];

  comeOut <== 1 - phase;
  comeOut * point === 0;
  phase * (1 - validPoint) === 0;

  comeNatural <== comeOut * natural;
  comeCraps <== comeOut * craps;
  comePoint <== comeOut * box;

  hitEq = IsEqual();
  hitEq.in[0] <== total;
  hitEq.in[1] <== point;

  hitPoint <== phase * hitEq.out;
  sevenOut <== phase * isFace[5];
  notHit <== 1 - hitEq.out;
  notSeven <== 1 - isFace[5];
  phaseNotHit <== phase * notHit;
  reroll <== phaseNotHit * notSeven;

  action <== comeCraps + 2 * comePoint + 3 * hitPoint + 4 * sevenOut + 5 * reroll;

  established <== comePoint * total;
  echoed <== phase * point;
  pointOut <== established + echoed;
}
