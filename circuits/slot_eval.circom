/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "circuits/comparators.circom";
include "./helpers.circom";

// ---------------------------------------------------------------------------
// 3-reel classic (Wilson / Double Diamond style)
// Symbols: 0 blank, 1 cherry, 2 single bar, 3 double bar, 4 triple bar,
//          5 single 7, 6 double 7, 7 wild (Double Diamond)
// One center payline. Highest award only. coinBet in {1,2,3}.
// ---------------------------------------------------------------------------

template Max2(nBits) {
  signal input in[2];
  signal output out;

  signal pickA;
  signal pickB;

  component gt = GreaterThan(nBits);
  gt.in[0] <== in[0];
  gt.in[1] <== in[1];
  pickA <== gt.out * in[0];
  pickB <== (1 - gt.out) * in[1];
  out <== pickA + pickB;
}

// Circular reel: center stop index → (above, center, below).
template ReelWindow(nStops) {
  signal input centerIndex;
  signal input strip[nStops];

  signal output above;
  signal output center;
  signal output below;

  component eq[nStops];
  component indexLt = ConstrainLt(5, nStops);
  signal accAbove[nStops + 1];
  signal accCenter[nStops + 1];
  signal accBelow[nStops + 1];

  indexLt.in <== centerIndex;

  accAbove[0] <== 0;
  accCenter[0] <== 0;
  accBelow[0] <== 0;

  for (var i = 0; i < nStops; i++) {
    var up = (i + nStops - 1) % nStops;
    var down = (i + 1) % nStops;
    eq[i] = IsEqual();
    eq[i].in[0] <== centerIndex;
    eq[i].in[1] <== i;
    accAbove[i + 1] <== accAbove[i] + eq[i].out * strip[up];
    accCenter[i + 1] <== accCenter[i] + eq[i].out * strip[i];
    accBelow[i + 1] <== accBelow[i] + eq[i].out * strip[down];
  }

  above <== accAbove[nStops];
  center <== accCenter[nStops];
  below <== accBelow[nStops];
}

template IsSymbol(value) {
  signal input in;
  signal output out;

  component eq = IsEqual();
  eq.in[0] <== in;
  eq.in[1] <== value;
  out <== eq.out;
}

template ThreeReelPayColumn() {
  signal input coinBet;

  signal output col[7];

  component is1 = IsEqual();
  component is2 = IsEqual();
  component is3 = IsEqual();

  is1.in[0] <== coinBet;
  is1.in[1] <== 1;
  is2.in[0] <== coinBet;
  is2.in[1] <== 2;
  is3.in[0] <== coinBet;
  is3.in[1] <== 3;
  is1.out + is2.out + is3.out === 1;

  // combo: 0=3 double 7s, 1=3 single 7s, 2=any 3 7s,
  //        3=3 triple bars, 4=3 double bars, 5=3 single bars, 6=any 3 bars
  var table[7][3] = [
    [500, 1000, 6000],
    [200, 400, 600],
    [75, 150, 225],
    [40, 80, 120],
    [20, 40, 60],
    [10, 20, 30],
    [5, 10, 15]
  ];

  for (var c = 0; c < 7; c++) {
    col[c] <== is1.out * table[c][0] + is2.out * table[c][1] + is3.out * table[c][2];
  }
}

template EvaluateThreeReel() {
  signal input symbols[3];
  signal input coinBet;

  signal output payout;

  component isWild[3];
  component isSingle7[3];
  component isDouble7[3];
  component isSingleBar[3];
  component isDoubleBar[3];
  component isTripleBar[3];

  signal asDouble7[3];
  signal asSingle7[3];
  signal asSeven[3];
  signal asTripleBar[3];
  signal asDoubleBar[3];
  signal asSingleBar[3];
  signal asBar[3];

  for (var i = 0; i < 3; i++) {
    isWild[i] = IsSymbol(7);
    isWild[i].in <== symbols[i];
    isSingle7[i] = IsSymbol(5);
    isSingle7[i].in <== symbols[i];
    isDouble7[i] = IsSymbol(6);
    isDouble7[i].in <== symbols[i];
    isSingleBar[i] = IsSymbol(2);
    isSingleBar[i].in <== symbols[i];
    isDoubleBar[i] = IsSymbol(3);
    isDoubleBar[i].in <== symbols[i];
    isTripleBar[i] = IsSymbol(4);
    isTripleBar[i].in <== symbols[i];

    asDouble7[i] <== isWild[i].out + (1 - isWild[i].out) * isDouble7[i].out;
    asSingle7[i] <== isWild[i].out + (1 - isWild[i].out) * isSingle7[i].out;
    asSeven[i] <== isWild[i].out + (1 - isWild[i].out) * (isSingle7[i].out + isDouble7[i].out);
    asTripleBar[i] <== isWild[i].out + (1 - isWild[i].out) * isTripleBar[i].out;
    asDoubleBar[i] <== isWild[i].out + (1 - isWild[i].out) * isDoubleBar[i].out;
    asSingleBar[i] <== isWild[i].out + (1 - isWild[i].out) * isSingleBar[i].out;
    asBar[i] <== isWild[i].out + (1 - isWild[i].out) * (
      isSingleBar[i].out + isDoubleBar[i].out + isTripleBar[i].out
    );
  }

  signal threeDouble7;
  signal threeSingle7;
  signal anyThree7;
  signal threeTripleBar;
  signal threeDoubleBar;
  signal threeSingleBar;
  signal anyThreeBar;

  signal threeDouble7Mid;
  signal threeSingle7Mid;
  signal anyThree7Mid;
  signal threeTripleBarMid;
  signal threeDoubleBarMid;
  signal threeSingleBarMid;
  signal anyThreeBarMid;

  threeDouble7Mid <== asDouble7[0] * asDouble7[1];
  threeDouble7 <== threeDouble7Mid * asDouble7[2];
  threeSingle7Mid <== asSingle7[0] * asSingle7[1];
  threeSingle7 <== threeSingle7Mid * asSingle7[2];
  anyThree7Mid <== asSeven[0] * asSeven[1];
  anyThree7 <== anyThree7Mid * asSeven[2];
  threeTripleBarMid <== asTripleBar[0] * asTripleBar[1];
  threeTripleBar <== threeTripleBarMid * asTripleBar[2];
  threeDoubleBarMid <== asDoubleBar[0] * asDoubleBar[1];
  threeDoubleBar <== threeDoubleBarMid * asDoubleBar[2];
  threeSingleBarMid <== asSingleBar[0] * asSingleBar[1];
  threeSingleBar <== threeSingleBarMid * asSingleBar[2];
  anyThreeBarMid <== asBar[0] * asBar[1];
  anyThreeBar <== anyThreeBarMid * asBar[2];

  signal notWin[7];
  signal win[7];
  win[0] <== threeDouble7;
  notWin[0] <== 1 - win[0];
  win[1] <== threeSingle7 * notWin[0];
  notWin[1] <== notWin[0] * (1 - win[1]);
  win[2] <== anyThree7 * notWin[1];
  notWin[2] <== notWin[1] * (1 - win[2]);
  win[3] <== threeTripleBar * notWin[2];
  notWin[3] <== notWin[2] * (1 - win[3]);
  win[4] <== threeDoubleBar * notWin[3];
  notWin[4] <== notWin[3] * (1 - win[4]);
  win[5] <== threeSingleBar * notWin[4];
  notWin[5] <== notWin[4] * (1 - win[5]);
  win[6] <== anyThreeBar * notWin[5];
  notWin[6] <== notWin[5] * (1 - win[6]);

  component column = ThreeReelPayColumn();
  column.coinBet <== coinBet;

  signal acc[8];
  acc[0] <== 0;
  for (var c = 0; c < 7; c++) {
    acc[c + 1] <== acc[c] + win[c] * column.col[c];
  }
  payout <== acc[7];
}

// Wilson 22-stop strip (identical reels). plaintext = center stop index.
template EvaluateThreeReelStops() {
  var nStops = 22;
  var strip[22] = [
    3, 0, 5, 0, 3, 0, 6, 0, 4, 0, 5, 0, 2, 0, 5, 0, 2, 0, 6, 0, 4, 0
  ];

  signal input centers[3];
  signal input coinBet;

  signal output payout;

  component window[3];
  signal symbols[3];

  for (var r = 0; r < 3; r++) {
    window[r] = ReelWindow(nStops);
    window[r].centerIndex <== centers[r];
    for (var i = 0; i < nStops; i++) {
      window[r].strip[i] <== strip[i];
    }
    symbols[r] <== window[r].center;
  }

  component eval = EvaluateThreeReel();
  eval.symbols <== symbols;
  eval.coinBet <== coinBet;
  payout <== eval.payout;
}

// ---------------------------------------------------------------------------
// 5-reel Starburst-style: 5×3 window, 10 paylines both ways, expanding wilds
// on reels 2–4 (1-index). Multipliers are stored in tenths of the total bet.
// Symbols: 0 purple, 1 blue, 2 orange, 3 green, 4 yellow, 5 lucky 7, 6 BAR, 7 wild
// ---------------------------------------------------------------------------

template StarburstPayMult10() {
  signal input symbol;
  signal input count;

  signal output out;

  var table[7][3] = [
    [5, 10, 25],
    [5, 10, 25],
    [7, 15, 40],
    [8, 20, 50],
    [10, 25, 60],
    [25, 60, 120],
    [50, 200, 250]
  ];

  component eqSym[7];
  component eqCount[3];
  signal term[7][3];
  signal kind[7][4];
  signal row[8];

  for (var s = 0; s < 7; s++) {
    eqSym[s] = IsEqual();
    eqSym[s].in[0] <== symbol;
    eqSym[s].in[1] <== s;
  }
  for (var k = 0; k < 3; k++) {
    eqCount[k] = IsEqual();
    eqCount[k].in[0] <== count;
    eqCount[k].in[1] <== k + 3;
  }

  row[0] <== 0;
  for (var s = 0; s < 7; s++) {
    kind[s][0] <== 0;
    for (var k = 0; k < 3; k++) {
      term[s][k] <== eqSym[s].out * eqCount[k].out * table[s][k];
      kind[s][k + 1] <== kind[s][k] + term[s][k];
    }
    row[s + 1] <== row[s] + kind[s][3];
  }
  out <== row[7];
}

template ExpandStarburstWilds() {
  signal input grid[5][3];
  signal output out[5][3];

  component isWild[5][3];
  signal hasWild[5];

  for (var r = 0; r < 5; r++) {
    for (var k = 0; k < 3; k++) {
      isWild[r][k] = IsSymbol(7);
      isWild[r][k].in <== grid[r][k];
    }
  }

  signal noWild01[5];
  signal noWild[5];
  for (var r = 0; r < 5; r++) {
    noWild01[r] <== (1 - isWild[r][0].out) * (1 - isWild[r][1].out);
    noWild[r] <== noWild01[r] * (1 - isWild[r][2].out);
    hasWild[r] <== 1 - noWild[r];
  }

  for (var k = 0; k < 3; k++) {
    out[0][k] <== grid[0][k];
    out[4][k] <== grid[4][k];
  }
  for (var r = 1; r < 4; r++) {
    for (var k = 0; k < 3; k++) {
      out[r][k] <== hasWild[r] * 7 + (1 - hasWild[r]) * grid[r][k];
    }
  }
}

// Count consecutive matches from the left. Wilds on reels 2–4 substitute.
// All-wild lines pay as BAR (highest symbol).
template CountMatchFromLeft() {
  signal input symbols[5];

  signal output count;
  signal output symbol;

  component isWild[5];
  component eqTarget[5];

  signal seen[5];
  signal target[5];
  signal pick[5];
  signal pickedSym[5];
  signal keptTarget[5];
  signal match[5];
  signal run[5];

  for (var i = 0; i < 5; i++) {
    isWild[i] = IsSymbol(7);
    isWild[i].in <== symbols[i];
  }

  // Wilds only substitute on reels 2–4 (indices 1,2,3).
  signal wildSub[5];
  wildSub[0] <== 0;
  wildSub[1] <== isWild[1].out;
  wildSub[2] <== isWild[2].out;
  wildSub[3] <== isWild[3].out;
  wildSub[4] <== 0;

  seen[0] <== 1 - wildSub[0];
  target[0] <== (1 - wildSub[0]) * symbols[0];
  pick[0] <== 0;

  for (var i = 1; i < 5; i++) {
    pick[i] <== (1 - seen[i - 1]) * (1 - wildSub[i]);
    pickedSym[i] <== pick[i] * symbols[i];
    keptTarget[i] <== (1 - pick[i]) * target[i - 1];
    target[i] <== pickedSym[i] + keptTarget[i];
    seen[i] <== seen[i - 1] + pick[i];
  }

  signal allWild;
  component targetIsWild = IsEqual();
  allWild <== 1 - seen[4];
  targetIsWild.in[0] <== target[4];
  targetIsWild.in[1] <== 7;
  signal useBar;
  useBar <== allWild + (1 - allWild) * targetIsWild.out;
  symbol <== useBar * 6 + (1 - useBar) * target[4];

  for (var i = 0; i < 5; i++) {
    eqTarget[i] = IsEqual();
    eqTarget[i].in[0] <== symbols[i];
    eqTarget[i].in[1] <== symbol;
    match[i] <== wildSub[i] + (1 - wildSub[i]) * eqTarget[i].out;
  }

  run[0] <== match[0];
  for (var i = 1; i < 5; i++) {
    run[i] <== run[i - 1] * match[i];
  }

  count <== run[0] + run[1] + run[2] + run[3] + run[4];
}

template EvaluatePaylineBothWays() {
  signal input symbols[5];

  signal output out;

  component ltr = CountMatchFromLeft();
  component rtl = CountMatchFromLeft();
  component payL = StarburstPayMult10();
  component payR = StarburstPayMult10();
  component mx = Max2(16);

  ltr.symbols <== symbols;
  rtl.symbols <== [symbols[4], symbols[3], symbols[2], symbols[1], symbols[0]];

  payL.symbol <== ltr.symbol;
  payL.count <== ltr.count;
  payR.symbol <== rtl.symbol;
  payR.count <== rtl.count;

  mx.in[0] <== payL.out;
  mx.in[1] <== payR.out;
  out <== mx.out;
}

template EvaluateFiveReelWindow() {
  signal input symbols[15];
  signal input coinBet;

  signal output payout;

  signal grid[5][3];
  for (var r = 0; r < 5; r++) {
    for (var k = 0; k < 3; k++) {
      grid[r][k] <== symbols[r * 3 + k];
    }
  }

  component expand = ExpandStarburstWilds();
  expand.grid <== grid;

  // 10 fixed Starburst-style paylines (row 0=top, 1=mid, 2=bot).
  var lines[10][5] = [
    [1, 1, 1, 1, 1],
    [0, 0, 0, 0, 0],
    [2, 2, 2, 2, 2],
    [0, 1, 2, 1, 0],
    [2, 1, 0, 1, 2],
    [0, 0, 1, 2, 2],
    [2, 2, 1, 0, 0],
    [1, 0, 0, 0, 1],
    [1, 2, 2, 2, 1],
    [0, 1, 1, 1, 0]
  ];

  component lineEval[10];
  signal linePay[10];
  signal acc[11];

  acc[0] <== 0;
  for (var line = 0; line < 10; line++) {
    lineEval[line] = EvaluatePaylineBothWays();
    for (var r = 0; r < 5; r++) {
      var row = lines[line][r];
      lineEval[line].symbols[r] <== expand.out[r][row];
    }
    linePay[line] <== lineEval[line].out;
    acc[line + 1] <== acc[line] + linePay[line];
  }

  // coinBet is 1, 2, or 3 coins (same book as 3-reel / share).
  component is1 = IsEqual();
  component is2 = IsEqual();
  component is3 = IsEqual();
  is1.in <== [coinBet, 1];
  is2.in <== [coinBet, 2];
  is3.in <== [coinBet, 3];
  is1.out + is2.out + is3.out === 1;

  payout <== acc[10] * coinBet;
}

// Five center stop indices. Above/below come from the public 22-stop strips.
template EvaluateFiveReelStops() {
  var nStops = 22;
  // Reels 1 and 5: no wilds. Reels 2–4: wild at stops 7 and 15.
  var strips[5][22] = [
    [0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0],
    [0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 7, 3, 4, 5, 6, 0, 1, 2, 7, 3, 4, 5],
    [0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 7, 3, 4, 5, 6, 0, 1, 2, 7, 3, 4, 5],
    [0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 7, 3, 4, 5, 6, 0, 1, 2, 7, 3, 4, 5],
    [0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0]
  ];

  signal input centers[5];
  signal input coinBet;

  signal output payout;

  component window[5];
  signal symbols[15];

  for (var r = 0; r < 5; r++) {
    window[r] = ReelWindow(nStops);
    window[r].centerIndex <== centers[r];
    for (var i = 0; i < nStops; i++) {
      window[r].strip[i] <== strips[r][i];
    }
    symbols[r * 3] <== window[r].above;
    symbols[r * 3 + 1] <== window[r].center;
    symbols[r * 3 + 2] <== window[r].below;
  }

  component eval = EvaluateFiveReelWindow();
  eval.symbols <== symbols;
  eval.coinBet <== coinBet;
  payout <== eval.payout;
}
