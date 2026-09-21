/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./helpers.circom";
include "circuits/comparators.circom";

// Pack won (0/1) and 1-based completion index: won * 256 + index.
template PackBingoTerm() {
  signal input won;
  signal input completionIndex;

  signal output out;

  out <== won * 256 + completionIndex;
}

// Quadratic AND of n bits (pairwise product chain).
template AndBits(n) {
  signal input in[n];
  signal output out;

  signal acc[n];
  acc[0] <== in[0];
  for (var i = 1; i < n; i++) {
    acc[i] <== acc[i - 1] * in[i];
  }
  out <== acc[n - 1];
}

// Quadratic OR of n bits: 1 − Π(1 − in[i]).
template OrBits(n) {
  signal input in[n];
  signal output out;

  signal notAcc[n];
  notAcc[0] <== 1 - in[0];
  for (var i = 1; i < n; i++) {
    notAcc[i] <== notAcc[i - 1] * (1 - in[i]);
  }
  out <== 1 - notAcc[n - 1];
}

// First time `hit` is 1 while `active` is 1; otherwise keep prior index.
template FirstCompletion() {
  signal input prevIndex;
  signal input hit;
  signal input active;
  signal input ballIndex1;

  signal output out;

  signal hitActive;
  signal just;
  component isFirst;

  isFirst = IsZero();
  isFirst.in <== prevIndex;
  hitActive <== hit * active;
  just <== isFirst.out * hitActive;
  out <== prevIndex + just * ballIndex1;
}

// 75-ball pattern:
//   0 = any line (5 rows, 5 cols, 2 diags; free center counts)
//   1 = four corners
//   2 = blackout (all 25, center already free)
template Evaluate75(nMax) {
  signal input cells[25];
  signal input balls[nMax];
  signal input nCalled;
  signal input patternId;

  signal output packed;

  signal marked[nMax + 1][25];
  signal ballPlus[nMax];
  signal calledActive[nMax];
  signal line[nMax][12];
  signal anyLine[nMax];
  signal corners[nMax];
  signal blackoutAcc[nMax][26];
  signal blackout[nMax];
  signal isPat0[nMax];
  signal isPat1[nMax];
  signal isPat2[nMax];
  signal hit[nMax];
  signal hit0[nMax];
  signal hit1[nMax];
  signal hit2[nMax];
  signal firstIdx[nMax + 1];
  signal matchCell[nMax][25];

  component ltCalled[nMax];
  component eqBall[nMax][25];
  component eqPat0[nMax];
  component eqPat1[nMax];
  component eqPat2[nMax];
  component first[nMax];
  component andRow[nMax][5];
  component andCol[nMax][5];
  component andDiag0[nMax];
  component andDiag1[nMax];
  component orLine[nMax];
  component andCorners[nMax];
  component wonZ;
  component pack;

  for (var c = 0; c < 25; c++) {
    marked[0][c] <== (c == 12) ? 1 : 0;
  }
  firstIdx[0] <== 0;

  for (var t = 0; t < nMax; t++) {
    ltCalled[t] = LessThan(8);
    ltCalled[t].in <== [t, nCalled];
    calledActive[t] <== ltCalled[t].out;
    ballPlus[t] <== balls[t] + 1;

    for (var c = 0; c < 25; c++) {
      eqBall[t][c] = IsEqual();
      eqBall[t][c].in <== [cells[c], ballPlus[t]];
      matchCell[t][c] <== eqBall[t][c].out * calledActive[t];
      marked[t + 1][c] <== marked[t][c] + (1 - marked[t][c]) * matchCell[t][c];
    }

    for (var r = 0; r < 5; r++) {
      andRow[t][r] = AndBits(5);
      andRow[t][r].in[0] <== marked[t + 1][r * 5];
      andRow[t][r].in[1] <== marked[t + 1][r * 5 + 1];
      andRow[t][r].in[2] <== marked[t + 1][r * 5 + 2];
      andRow[t][r].in[3] <== marked[t + 1][r * 5 + 3];
      andRow[t][r].in[4] <== marked[t + 1][r * 5 + 4];
      line[t][r] <== andRow[t][r].out;
    }
    for (var col = 0; col < 5; col++) {
      andCol[t][col] = AndBits(5);
      andCol[t][col].in[0] <== marked[t + 1][col];
      andCol[t][col].in[1] <== marked[t + 1][5 + col];
      andCol[t][col].in[2] <== marked[t + 1][10 + col];
      andCol[t][col].in[3] <== marked[t + 1][15 + col];
      andCol[t][col].in[4] <== marked[t + 1][20 + col];
      line[t][5 + col] <== andCol[t][col].out;
    }
    andDiag0[t] = AndBits(5);
    andDiag0[t].in[0] <== marked[t + 1][0];
    andDiag0[t].in[1] <== marked[t + 1][6];
    andDiag0[t].in[2] <== marked[t + 1][12];
    andDiag0[t].in[3] <== marked[t + 1][18];
    andDiag0[t].in[4] <== marked[t + 1][24];
    line[t][10] <== andDiag0[t].out;
    andDiag1[t] = AndBits(5);
    andDiag1[t].in[0] <== marked[t + 1][4];
    andDiag1[t].in[1] <== marked[t + 1][8];
    andDiag1[t].in[2] <== marked[t + 1][12];
    andDiag1[t].in[3] <== marked[t + 1][16];
    andDiag1[t].in[4] <== marked[t + 1][20];
    line[t][11] <== andDiag1[t].out;

    orLine[t] = OrBits(12);
    for (var k = 0; k < 12; k++) {
      orLine[t].in[k] <== line[t][k];
    }
    anyLine[t] <== orLine[t].out;

    andCorners[t] = AndBits(4);
    andCorners[t].in[0] <== marked[t + 1][0];
    andCorners[t].in[1] <== marked[t + 1][4];
    andCorners[t].in[2] <== marked[t + 1][20];
    andCorners[t].in[3] <== marked[t + 1][24];
    corners[t] <== andCorners[t].out;

    blackoutAcc[t][0] <== 1;
    for (var c = 0; c < 25; c++) {
      blackoutAcc[t][c + 1] <== blackoutAcc[t][c] * marked[t + 1][c];
    }
    blackout[t] <== blackoutAcc[t][25];

    eqPat0[t] = IsEqual();
    eqPat0[t].in <== [patternId, 0];
    eqPat1[t] = IsEqual();
    eqPat1[t].in <== [patternId, 1];
    eqPat2[t] = IsEqual();
    eqPat2[t].in <== [patternId, 2];
    isPat0[t] <== eqPat0[t].out;
    isPat1[t] <== eqPat1[t].out;
    isPat2[t] <== eqPat2[t].out;

    hit0[t] <== isPat0[t] * anyLine[t];
    hit1[t] <== isPat1[t] * corners[t];
    hit2[t] <== isPat2[t] * blackout[t];
    hit[t] <== hit0[t] + hit1[t] + hit2[t];

    first[t] = FirstCompletion();
    first[t].prevIndex <== firstIdx[t];
    first[t].hit <== hit[t];
    first[t].active <== calledActive[t];
    first[t].ballIndex1 <== t + 1;
    firstIdx[t + 1] <== first[t].out;
  }

  wonZ = IsZero();
  wonZ.in <== firstIdx[nMax];

  pack = PackBingoTerm();
  pack.won <== 1 - wonZ.out;
  pack.completionIndex <== firstIdx[nMax];
  packed <== pack.out;
}

// 90-ball: 3×9. A row is complete when its 5 numbers are marked.
// Terms: one line, two lines, full house — each with its own completion index.
template Evaluate90(nMax) {
  signal input cells[27];
  signal input balls[nMax];
  signal input nCalled;

  signal output packed[3];

  signal marked[nMax + 1][27];
  signal ballPlus[nMax];
  signal calledActive[nMax];
  signal rowCount[nMax][3];
  signal rowDone[nMax][3];
  signal lines[nMax];
  signal first1[nMax + 1];
  signal first2[nMax + 1];
  signal firstH[nMax + 1];
  signal isNumber[27];
  signal matchIfCalled[nMax][27];
  signal matchCell[nMax][27];

  component ltCalled[nMax];
  component eqBall[nMax][27];
  component isZero[27];
  component rowEq[nMax][3];
  component ge1[nMax];
  component ge2[nMax];
  component ge3[nMax];
  component firstOne[nMax];
  component firstTwo[nMax];
  component firstHouse[nMax];
  component won1;
  component won2;
  component wonH;
  component pack1;
  component pack2;
  component packH;

  for (var c = 0; c < 27; c++) {
    isZero[c] = IsZero();
    isZero[c].in <== cells[c];
    isNumber[c] <== 1 - isZero[c].out;
    marked[0][c] <== 0;
  }
  first1[0] <== 0;
  first2[0] <== 0;
  firstH[0] <== 0;

  for (var t = 0; t < nMax; t++) {
    ltCalled[t] = LessThan(8);
    ltCalled[t].in <== [t, nCalled];
    calledActive[t] <== ltCalled[t].out;
    ballPlus[t] <== balls[t] + 1;

    for (var c = 0; c < 27; c++) {
      eqBall[t][c] = IsEqual();
      eqBall[t][c].in <== [cells[c], ballPlus[t]];
      matchIfCalled[t][c] <== eqBall[t][c].out * calledActive[t];
      matchCell[t][c] <== matchIfCalled[t][c] * isNumber[c];
      marked[t + 1][c] <== marked[t][c] + (1 - marked[t][c]) * matchCell[t][c];
    }

    for (var r = 0; r < 3; r++) {
      rowCount[t][r] <== marked[t + 1][r * 9]
        + marked[t + 1][r * 9 + 1]
        + marked[t + 1][r * 9 + 2]
        + marked[t + 1][r * 9 + 3]
        + marked[t + 1][r * 9 + 4]
        + marked[t + 1][r * 9 + 5]
        + marked[t + 1][r * 9 + 6]
        + marked[t + 1][r * 9 + 7]
        + marked[t + 1][r * 9 + 8];
      rowEq[t][r] = IsEqual();
      rowEq[t][r].in <== [rowCount[t][r], 5];
      rowDone[t][r] <== rowEq[t][r].out;
    }
    lines[t] <== rowDone[t][0] + rowDone[t][1] + rowDone[t][2];

    ge1[t] = GreaterEqThan(3);
    ge1[t].in <== [lines[t], 1];
    ge2[t] = GreaterEqThan(3);
    ge2[t].in <== [lines[t], 2];
    ge3[t] = GreaterEqThan(3);
    ge3[t].in <== [lines[t], 3];

    firstOne[t] = FirstCompletion();
    firstOne[t].prevIndex <== first1[t];
    firstOne[t].hit <== ge1[t].out;
    firstOne[t].active <== calledActive[t];
    firstOne[t].ballIndex1 <== t + 1;
    first1[t + 1] <== firstOne[t].out;

    firstTwo[t] = FirstCompletion();
    firstTwo[t].prevIndex <== first2[t];
    firstTwo[t].hit <== ge2[t].out;
    firstTwo[t].active <== calledActive[t];
    firstTwo[t].ballIndex1 <== t + 1;
    first2[t + 1] <== firstTwo[t].out;

    firstHouse[t] = FirstCompletion();
    firstHouse[t].prevIndex <== firstH[t];
    firstHouse[t].hit <== ge3[t].out;
    firstHouse[t].active <== calledActive[t];
    firstHouse[t].ballIndex1 <== t + 1;
    firstH[t + 1] <== firstHouse[t].out;
  }

  won1 = IsZero();
  won1.in <== first1[nMax];
  won2 = IsZero();
  won2.in <== first2[nMax];
  wonH = IsZero();
  wonH.in <== firstH[nMax];

  pack1 = PackBingoTerm();
  pack1.won <== 1 - won1.out;
  pack1.completionIndex <== first1[nMax];
  pack2 = PackBingoTerm();
  pack2.won <== 1 - won2.out;
  pack2.completionIndex <== first2[nMax];
  packH = PackBingoTerm();
  packH.won <== 1 - wonH.out;
  packH.completionIndex <== firstH[nMax];

  packed <== [pack1.out, pack2.out, packH.out];
}
