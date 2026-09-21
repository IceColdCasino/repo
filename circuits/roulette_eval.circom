/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "circuits/comparators.circom";
include "./helpers.circom";

// Payout table (returned multiplier on win; 0 on loss):
// 0 Straight up   35:1   modifier = pocket (EU: 0-36; US: 0-36, 37 = 00)
// 1 Row (US only) 17:1   0 and 00
// 2 Split         17:1   modifier indexes vertical then horizontal splits (see Split)
// 3 Street        11:1   modifier 0..11 → (3s+1..3s+3)
// 4 Corner         8:1   modifier 0..21 → grid corner (see Corner)
// 5 Top line      EU 8:1 {0,1,2,3} / US 6:1 {0,00,1,2,3}
// 6 Double street  5:1   modifier 0..10 → streets s and s+1 (3s+1 .. 3s+6)
// 7 Column         2:1   modifier 0..2 → 1st / 2nd / 3rd column
// 8 Dozen          2:1   modifier 0..2 → 1-12 / 13-24 / 25-36
// 9 Even / Odd     1:1   modifier 0 = even, 1 = odd (0 and 00 lose)
// 10 Red / Black   1:1   modifier 0 = red, 1 = black (0 and 00 lose)
// 11 Half          1:1   modifier 0 = 1-18, 1 = 19-36 (0 and 00 lose)
//
// Use EvaluateBetEU for 37-pocket wheels and EvaluateBetUS for 38-pocket wheels.
//
// Table layout (row r=0 bottom, r=2 top; col j=0 left):
//   n(r,j) = 3*j + 1 + r
//   3  6  9 ...
//   2  5  8 ...
//   1  4  7 ...

function column0() { return [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34]; }
function column1() { return [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35]; }
function column2() { return [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36]; }

function redPockets() {
  return [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
}

function blackPockets() {
  return [2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35];
}

function evenPockets() {
  return [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36];
}

function oddPockets() {
  return [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35];
}

function splitLow(m) {
  if (m < 24) {
    var j = m % 12;
    var r = (m - j) / 12;
    return 3 * j + 1 + r;
  }
  var t = m - 24;
  var j = t % 11;
  var r = (t - j) / 11;
  return 3 * j + 1 + r;
}

function splitHigh(m) {
  if (m < 24) {
    var j = m % 12;
    var r = (m - j) / 12;
    return 3 * j + 2 + r;
  }
  var t = m - 24;
  var j = t % 11;
  var r = (t - j) / 11;
  return 3 * j + 4 + r;
}

function cornerPocket(m, k) {
  var j = m % 11;
  var r = (m - j) / 11;
  if (k == 0) {
    return 3 * j + 1 + r;
  }
  if (k == 1) {
    return 3 * j + 2 + r;
  }
  if (k == 2) {
    return 3 * j + 4 + r;
  }
  return 3 * j + 5 + r;
}

template OrN(n) {
  signal input in[n];

  signal acc[n + 1];

  signal output out;

  acc[0] <== 0;
  for (var i = 0; i < n; i++) {
    acc[i + 1] <== acc[i] + in[i] - acc[i] * in[i];
  }
  out <== acc[n];
}

template IsActiveType() {
  signal input type;
  signal input expected;

  signal output out;

  component eq;

  eq = IsEqual();
  eq.in <== [type, expected];
  out <== eq.out;
}

// Bit width must cover max derived bounds used while inactive types still
// receive another bet's modifier (e.g. Dozen: 12*modifier+12 with modifier≤63).
template InInclusiveRange() {
  signal input winner;
  signal input lo;
  signal input hi;

  signal winnerPlus1;
  signal hiPlus1;

  signal output out;

  component ge;
  component le;

  // winner >= lo  ⇔  lo < winner+1;  winner <= hi  ⇔  winner < hi+1
  // (avoids Num2Bits on lo-1 which underflows when lo=0)
  winnerPlus1 <== winner + 1;
  hiPlus1 <== hi + 1;

  ge = LessThan(10);
  ge.in[0] <== lo;
  ge.in[1] <== winnerPlus1;

  le = LessThan(10);
  le.in[0] <== winner;
  le.in[1] <== hiPlus1;

  out <== ge.out * le.out;
}

template IsInList(n) {
  signal input winner;
  signal input set[n];

  signal hit[n];

  signal output out;

  component eq[n];
  component or;

  for (var i = 0; i < n; i++) {
    eq[i] = IsEqual();
    eq[i].in <== [winner, set[i]];
    hit[i] <== eq[i].out;
  }

  or = OrN(n);
  or.in <== hit;
  out <== or.out;
}

template IsZeroOrDoubleZero() {
  signal input winner;

  signal output out;

  component eq0;
  component eq00;

  eq0 = IsEqual();
  eq0.in <== [winner, 0];

  eq00 = IsEqual();
  eq00.in <== [winner, 37];

  out <== eq0.out + eq00.out - eq0.out * eq00.out;
}

// 0 - Straight up
template StraightUp() {
  signal input type;
  signal input modifier;
  signal input winner;

  signal output out;

  component active;
  component eq;

  active = IsActiveType();
  active.type <== type;
  active.expected <== 0;

  eq = IsEqual();
  eq.in <== [modifier, winner];

  out <== 35 * active.out * eq.out;
}

// 1 - Row (US only: 0 and 00)
template RowUS() {
  signal input type;
  signal input winner;

  signal output out;

  component active;
  component zeros;

  active = IsActiveType();
  active.type <== type;
  active.expected <== 1;

  zeros = IsZeroOrDoubleZero();
  zeros.winner <== winner;

  out <== 17 * active.out * zeros.out;
}

// 2 - Split (57 interior splits: 24 vertical + 33 horizontal)
// Vertical modifier m in [0,23]:  j = m % 12, r = m \ 12  → {3j+1+r, 3j+2+r}
// Horizontal modifier m in [24,56]: t = m - 24, j = t % 11, r = t \ 11 → {3j+1+r, 3j+4+r}
template Split() {
  signal input type;
  signal input modifier;
  signal input winner;

  signal pairHit[57];
  signal modHit[57];
  signal acc[58];

  signal output out;

  component active;
  component eqMod[57];
  component eqLow[57];
  component eqHigh[57];

  active = IsActiveType();
  active.type <== type;
  active.expected <== 2;

  acc[0] <== 0;
  for (var m = 0; m < 57; m++) {
    eqMod[m] = IsEqual();
    eqMod[m].in <== [modifier, m];

    eqLow[m] = IsEqual();
    eqLow[m].in <== [winner, splitLow(m)];

    eqHigh[m] = IsEqual();
    eqHigh[m].in <== [winner, splitHigh(m)];

    pairHit[m] <== eqLow[m].out + eqHigh[m].out - eqLow[m].out * eqHigh[m].out;
    modHit[m] <== eqMod[m].out * pairHit[m];
    acc[m + 1] <== acc[m] + modHit[m] - acc[m] * modHit[m];
  }

  out <== 17 * active.out * acc[57];
}

// 3 - Street
template Street() {
  signal input type;
  signal input modifier;
  signal input winner;

  signal lo;
  signal hi;

  signal output out;

  component active;
  component range;

  active = IsActiveType();
  active.type <== type;
  active.expected <== 3;

  lo <== 3 * modifier + 1;
  hi <== 3 * modifier + 3;

  range = InInclusiveRange();
  range.winner <== winner;
  range.lo <== lo;
  range.hi <== hi;

  out <== 11 * active.out * range.out;
}

// 4 - Corner (22 interior corners)
// modifier m in [0,21]: j = m % 11, r = m \ 11 → {3j+1+r, 3j+2+r, 3j+4+r, 3j+5+r}
template Corner() {
  signal input type;
  signal input modifier;
  signal input winner;

  signal pocketHit[22][4];
  signal pAcc[22][5];
  signal cornerHit[22];
  signal modHit[22];
  signal acc[23];

  signal output out;

  component active;
  component eqMod[22];
  component eqPocket[22][4];

  active = IsActiveType();
  active.type <== type;
  active.expected <== 4;

  acc[0] <== 0;
  for (var m = 0; m < 22; m++) {
    eqMod[m] = IsEqual();
    eqMod[m].in <== [modifier, m];

    pAcc[m][0] <== 0;
    for (var k = 0; k < 4; k++) {
      eqPocket[m][k] = IsEqual();
      eqPocket[m][k].in <== [winner, cornerPocket(m, k)];
      pocketHit[m][k] <== eqPocket[m][k].out;
      pAcc[m][k + 1] <== pAcc[m][k] + pocketHit[m][k] - pAcc[m][k] * pocketHit[m][k];
    }
    cornerHit[m] <== pAcc[m][4];
    modHit[m] <== eqMod[m].out * cornerHit[m];
    acc[m + 1] <== acc[m] + modHit[m] - acc[m] * modHit[m];
  }

  out <== 8 * active.out * acc[22];
}

// 5 - Top line (EU: 0, 1, 2, 3)
template TopLineEU() {
  signal input type;
  signal input winner;

  signal pockets[4];

  signal output out;

  component active;
  component hit;

  active = IsActiveType();
  active.type <== type;
  active.expected <== 5;

  pockets[0] <== 0;
  pockets[1] <== 1;
  pockets[2] <== 2;
  pockets[3] <== 3;

  hit = IsInList(4);
  hit.winner <== winner;
  hit.set <== pockets;

  out <== 8 * active.out * hit.out;
}

// 5 - Top line (US: 0, 00, 1, 2, 3)
template TopLineUS() {
  signal input type;
  signal input winner;

  signal pockets[5];

  signal output out;

  component active;
  component hit;

  active = IsActiveType();
  active.type <== type;
  active.expected <== 5;

  pockets[0] <== 0;
  pockets[1] <== 37;
  pockets[2] <== 1;
  pockets[3] <== 2;
  pockets[4] <== 3;

  hit = IsInList(5);
  hit.winner <== winner;
  hit.set <== pockets;

  out <== 6 * active.out * hit.out;
}

// 6 - Double street
template DoubleStreet() {
  signal input type;
  signal input modifier;
  signal input winner;

  signal lo;
  signal hi;

  signal output out;

  component active;
  component range;

  active = IsActiveType();
  active.type <== type;
  active.expected <== 6;

  lo <== 3 * modifier + 1;
  hi <== 3 * modifier + 6;

  range = InInclusiveRange();
  range.winner <== winner;
  range.lo <== lo;
  range.hi <== hi;

  out <== 5 * active.out * range.out;
}

// 7 - Column
template Column() {
  signal input type;
  signal input modifier;
  signal input winner;

  signal col0Hit;
  signal col1Hit;
  signal notCol0;
  signal notCol1;
  signal col2Sel;
  signal col2Hit;
  signal hit;

  signal output out;

  component active;
  component isCol0;
  component isCol1;
  component inCol0;
  component inCol1;
  component inCol2;

  active = IsActiveType();
  active.type <== type;
  active.expected <== 7;

  isCol0 = IsEqual();
  isCol0.in <== [modifier, 0];

  isCol1 = IsEqual();
  isCol1.in <== [modifier, 1];

  inCol0 = IsInList(12);
  inCol0.winner <== winner;
  inCol0.set <== column0();

  inCol1 = IsInList(12);
  inCol1.winner <== winner;
  inCol1.set <== column1();

  inCol2 = IsInList(12);
  inCol2.winner <== winner;
  inCol2.set <== column2();

  col0Hit <== isCol0.out * inCol0.out;
  col1Hit <== isCol1.out * inCol1.out;
  notCol0 <== 1 - isCol0.out;
  notCol1 <== 1 - isCol1.out;
  col2Sel <== notCol0 * notCol1;
  col2Hit <== col2Sel * inCol2.out;
  hit <== col0Hit + col1Hit + col2Hit;

  out <== 2 * active.out * hit;
}

// 8 - Dozen
template Dozen() {
  signal input type;
  signal input modifier;
  signal input winner;

  signal lo;
  signal hi;

  signal output out;

  component active;
  component range;

  active = IsActiveType();
  active.type <== type;
  active.expected <== 8;

  lo <== 12 * modifier + 1;
  hi <== 12 * modifier + 12;

  range = InInclusiveRange();
  range.winner <== winner;
  range.lo <== lo;
  range.hi <== hi;

  out <== 2 * active.out * range.out;
}

// 9 - Even / Odd (outside bet: 0 and 00 lose)
template EvenOdd() {
  signal input type;
  signal input modifier;
  signal input winner;

  signal evenPart;
  signal oddPart;
  signal parityMatch;
  signal inRangeMatch;

  signal output out;

  component active;
  component inPlay;
  component wantsEven;
  component inEven;
  component inOdd;

  active = IsActiveType();
  active.type <== type;
  active.expected <== 9;

  inPlay = InInclusiveRange();
  inPlay.winner <== winner;
  inPlay.lo <== 1;
  inPlay.hi <== 36;

  wantsEven = IsZero();
  wantsEven.in <== modifier;

  inEven = IsInList(18);
  inEven.winner <== winner;
  inEven.set <== evenPockets();

  inOdd = IsInList(18);
  inOdd.winner <== winner;
  inOdd.set <== oddPockets();

  evenPart <== wantsEven.out * inEven.out;
  oddPart <== (1 - wantsEven.out) * inOdd.out;
  parityMatch <== evenPart + oddPart;
  inRangeMatch <== inPlay.out * parityMatch;

  out <== active.out * inRangeMatch;
}

// 10 - Red / Black
template RedBlack() {
  signal input type;
  signal input modifier;
  signal input winner;

  signal redPart;
  signal blackPart;
  signal hit;

  signal output out;

  component active;
  component wantsRed;
  component inRed;
  component inBlack;

  active = IsActiveType();
  active.type <== type;
  active.expected <== 10;

  wantsRed = IsZero();
  wantsRed.in <== modifier;

  inRed = IsInList(18);
  inRed.winner <== winner;
  inRed.set <== redPockets();

  inBlack = IsInList(18);
  inBlack.winner <== winner;
  inBlack.set <== blackPockets();

  redPart <== wantsRed.out * inRed.out;
  blackPart <== (1 - wantsRed.out) * inBlack.out;
  hit <== redPart + blackPart;

  out <== active.out * hit;
}

// 11 - 1-18 / 19-36
template Half() {
  signal input type;
  signal input modifier;
  signal input winner;

  signal lowPart;
  signal highPart;
  signal hit;

  signal output out;

  component active;
  component wantsLow;
  component low;
  component high;

  active = IsActiveType();
  active.type <== type;
  active.expected <== 11;

  wantsLow = IsZero();
  wantsLow.in <== modifier;

  low = InInclusiveRange();
  low.winner <== winner;
  low.lo <== 1;
  low.hi <== 18;

  high = InInclusiveRange();
  high.winner <== winner;
  high.lo <== 19;
  high.hi <== 36;

  lowPart <== wantsLow.out * low.out;
  highPart <== (1 - wantsLow.out) * high.out;
  hit <== lowPart + highPart;

  out <== active.out * hit;
}

template EvaluateBet(deckSize) {
  assert(deckSize == 37 || deckSize == 38);

  signal input type;
  signal input modifier;
  signal input winner;

  signal rowOut;
  signal topLineOut;

  signal output out;

  component straightUp;
  component split;
  component street;
  component corner;
  component topLineEU;
  component topLineUS;
  component row;
  component doubleStreet;
  component column;
  component dozen;
  component evenOdd;
  component redBlack;
  component half;

  straightUp = StraightUp();
  straightUp.type <== type;
  straightUp.modifier <== modifier;
  straightUp.winner <== winner;

  split = Split();
  split.type <== type;
  split.modifier <== modifier;
  split.winner <== winner;

  street = Street();
  street.type <== type;
  street.modifier <== modifier;
  street.winner <== winner;

  corner = Corner();
  corner.type <== type;
  corner.modifier <== modifier;
  corner.winner <== winner;

  if (deckSize == 37) {
    topLineEU = TopLineEU();
    topLineEU.type <== type;
    topLineEU.winner <== winner;
    topLineOut <== topLineEU.out;
    rowOut <== 0;
  } else {
    topLineUS = TopLineUS();
    topLineUS.type <== type;
    topLineUS.winner <== winner;
    topLineOut <== topLineUS.out;

    row = RowUS();
    row.type <== type;
    row.winner <== winner;
    rowOut <== row.out;
  }

  doubleStreet = DoubleStreet();
  doubleStreet.type <== type;
  doubleStreet.modifier <== modifier;
  doubleStreet.winner <== winner;

  column = Column();
  column.type <== type;
  column.modifier <== modifier;
  column.winner <== winner;

  dozen = Dozen();
  dozen.type <== type;
  dozen.modifier <== modifier;
  dozen.winner <== winner;

  evenOdd = EvenOdd();
  evenOdd.type <== type;
  evenOdd.modifier <== modifier;
  evenOdd.winner <== winner;

  redBlack = RedBlack();
  redBlack.type <== type;
  redBlack.modifier <== modifier;
  redBlack.winner <== winner;

  half = Half();
  half.type <== type;
  half.modifier <== modifier;
  half.winner <== winner;

  out <== straightUp.out
    + rowOut
    + split.out
    + street.out
    + corner.out
    + topLineOut
    + doubleStreet.out
    + column.out
    + dozen.out
    + evenOdd.out
    + redBlack.out
    + half.out;
}

template EvaluateBets(nBets, deckSize) {
  assert(deckSize == 37 || deckSize == 38);

  signal input winner;
  signal input in[nBets][2];
  signal input nActualBets;

  signal output out[nBets];

  component lt;
  component evaluateBets[nBets];
  component lessThan[nBets];

  // 0 <= nActualBets <= nBets
  lt = ConstrainLt(4, nBets + 1);
  lt.in <== nActualBets;

  for (var i = 0; i < nBets; i++) {
    evaluateBets[i] = parallel EvaluateBet(deckSize);
    evaluateBets[i].type <== in[i][0];
    evaluateBets[i].modifier <== in[i][1];
    evaluateBets[i].winner <== winner;

    lessThan[i] = LessThan(4);
    lessThan[i].in <== [i, nActualBets];

    out[i] <== evaluateBets[i].out * lessThan[i].out;
  }
}
