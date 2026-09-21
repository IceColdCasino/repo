/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./helpers.circom";

// Per-bet result encoding (profit in 30ths so 9:5 / 7:6 / 3:2 stay integer):
//   0           lose
//   1           keep (push, still working, or off this roll)
//   1 + 30*p/q  win at p:q
//
// 1:1=31  2:1=61  9:5=55  7:5=43  7:6=36  3:2=46  6:5=37
// 1:2=16  2:3=21  5:6=26  4:1=121  7:1=211  9:1=271  15:1=451  30:1=901

template CrapsKeepLoseWin() {
  signal input hit;
  signal input lose;
  signal input winCode;

  signal output out;

  signal keep;

  hit * lose === 0;
  keep <== (1 - hit) * (1 - lose);
  out <== hit * winCode + keep;
}

template PointNumber() {
  signal input index;

  signal output out;

  signal acc[7];

  component eq[6];

  var nums[6] = [4, 5, 6, 8, 9, 10];
  acc[0] <== 0;
  for (var i = 0; i < 6; i++) {
    eq[i] = IsEqual();
    eq[i].in <== [index, i];
    acc[i + 1] <== acc[i] + eq[i].out * nums[i];
  }
  out <== acc[6];
}

template HardNumber() {
  signal input index;

  signal output out;

  signal acc[5];

  component eq[4];

  var nums[4] = [4, 6, 8, 10];
  acc[0] <== 0;
  for (var i = 0; i < 4; i++) {
    eq[i] = IsEqual();
    eq[i].in <== [index, i];
    acc[i + 1] <== acc[i] + eq[i].out * nums[i];
  }
  out <== acc[4];
}

template PlaceWinCode() {
  signal input index;

  signal output out;

  signal isOuter;
  signal isMid;
  signal isInner;
  signal outerPart;
  signal midPart;
  signal innerPart;

  component eq[6];

  for (var i = 0; i < 6; i++) {
    eq[i] = IsEqual();
    eq[i].in <== [index, i];
  }
  isOuter <== eq[0].out + eq[5].out;
  isMid <== eq[1].out + eq[4].out;
  isInner <== eq[2].out + eq[3].out;
  outerPart <== isOuter * 55;
  midPart <== isMid * 43;
  innerPart <== isInner * 36;
  out <== outerPart + midPart + innerPart;
}

template TrueOddsWinCode() {
  signal input index;

  signal output out;

  signal isOuter;
  signal isMid;
  signal isInner;
  signal outerPart;
  signal midPart;
  signal innerPart;

  component eq[6];

  for (var i = 0; i < 6; i++) {
    eq[i] = IsEqual();
    eq[i].in <== [index, i];
  }
  isOuter <== eq[0].out + eq[5].out;
  isMid <== eq[1].out + eq[4].out;
  isInner <== eq[2].out + eq[3].out;
  outerPart <== isOuter * 61;
  midPart <== isMid * 46;
  innerPart <== isInner * 37;
  out <== outerPart + midPart + innerPart;
}

template LayOddsWinCode() {
  signal input index;

  signal output out;

  signal isOuter;
  signal isMid;
  signal isInner;
  signal outerPart;
  signal midPart;
  signal innerPart;

  component eq[6];

  for (var i = 0; i < 6; i++) {
    eq[i] = IsEqual();
    eq[i].in <== [index, i];
  }
  isOuter <== eq[0].out + eq[5].out;
  isMid <== eq[1].out + eq[4].out;
  isInner <== eq[2].out + eq[3].out;
  outerPart <== isOuter * 16;
  midPart <== isMid * 21;
  innerPart <== isInner * 26;
  out <== outerPart + midPart + innerPart;
}

template CrapsRollFacts() {
  signal input diceValues[2];

  signal output total;
  signal output isTwo;
  signal output isThree;
  signal output isFour;
  signal output isSeven;
  signal output isNine;
  signal output isTen;
  signal output isEleven;
  signal output isTwelve;
  signal output isCraps;
  signal output isHard;

  signal isFace[11];

  component eqTotal[11];
  component hardEq;

  total <== diceValues[0] + diceValues[1] + 2;

  for (var t = 2; t <= 12; t++) {
    eqTotal[t - 2] = IsEqual();
    eqTotal[t - 2].in[0] <== total;
    eqTotal[t - 2].in[1] <== t;
    isFace[t - 2] <== eqTotal[t - 2].out;
  }

  isTwo <== isFace[0];
  isThree <== isFace[1];
  isFour <== isFace[2];
  isSeven <== isFace[5];
  isNine <== isFace[7];
  isTen <== isFace[8];
  isEleven <== isFace[9];
  isTwelve <== isFace[10];
  isCraps <== isTwo + isThree + isTwelve;

  hardEq = IsEqual();
  hardEq.in <== [diceValues[0], diceValues[1]];
  isHard <== hardEq.out;
}

template EvalPass() {
  signal input type;
  signal input phase;
  signal input point;
  signal input total;
  signal input isSeven;
  signal input isEleven;
  signal input isCraps;

  signal output out;

  signal comeOut;
  signal natural;
  signal coWin;
  signal coLose;
  signal ptWin;
  signal ptLose;
  signal hit;
  signal lose;
  signal resolved;

  component active;
  component hitEq;
  component settle;

  active = IsEqual();
  active.in <== [type, 0];

  comeOut <== 1 - phase;
  natural <== isSeven + isEleven;
  coWin <== comeOut * natural;
  coLose <== comeOut * isCraps;

  hitEq = IsEqual();
  hitEq.in <== [total, point];
  ptWin <== phase * hitEq.out;
  ptLose <== phase * isSeven;

  hit <== coWin + ptWin;
  lose <== coLose + ptLose;

  settle = CrapsKeepLoseWin();
  settle.hit <== hit;
  settle.lose <== lose;
  settle.winCode <== 31;
  resolved <== settle.out;

  out <== active.out * resolved;
}

template EvalDontPass() {
  signal input type;
  signal input phase;
  signal input point;
  signal input total;
  signal input isTwo;
  signal input isThree;
  signal input isTwelve;
  signal input isSeven;
  signal input isEleven;

  signal output out;

  signal comeOut;
  signal coWin;
  signal coLose;
  signal ptWin;
  signal ptLose;
  signal hit;
  signal lose;
  signal resolved;

  component active;
  component hitEq;
  component settle;

  active = IsEqual();
  active.in <== [type, 1];

  comeOut <== 1 - phase;
  coWin <== comeOut * (isTwo + isThree);
  coLose <== comeOut * (isSeven + isEleven);

  hitEq = IsEqual();
  hitEq.in <== [total, point];
  ptWin <== phase * isSeven;
  ptLose <== phase * hitEq.out;

  hit <== coWin + ptWin;
  lose <== coLose + ptLose;

  settle = CrapsKeepLoseWin();
  settle.hit <== hit;
  settle.lose <== lose;
  settle.winCode <== 31;
  resolved <== settle.out;

  out <== active.out * resolved;
}

template EvalCome() {
  signal input type;
  signal input modifier;
  signal input total;
  signal input isSeven;
  signal input isEleven;
  signal input isCraps;

  signal output out;

  signal isNew;
  signal estIndex;
  signal newWin;
  signal newLose;
  signal estHit;
  signal estLose;
  signal hit;
  signal lose;
  signal resolved;

  component active;
  component newEq;
  component comeNum;
  component hitEq;
  component settle;

  active = IsEqual();
  active.in <== [type, 2];

  newEq = IsZero();
  newEq.in <== modifier;
  isNew <== newEq.out;
  estIndex <== (1 - isNew) * (modifier - 1);

  comeNum = PointNumber();
  comeNum.index <== estIndex;

  newWin <== isNew * (isSeven + isEleven);
  newLose <== isNew * isCraps;

  hitEq = IsEqual();
  hitEq.in <== [total, comeNum.out];
  estHit <== (1 - isNew) * hitEq.out;
  estLose <== (1 - isNew) * isSeven;

  hit <== newWin + estHit;
  lose <== newLose + estLose;

  settle = CrapsKeepLoseWin();
  settle.hit <== hit;
  settle.lose <== lose;
  settle.winCode <== 31;
  resolved <== settle.out;

  out <== active.out * resolved;
}

template EvalDontCome() {
  signal input type;
  signal input modifier;
  signal input total;
  signal input isTwo;
  signal input isThree;
  signal input isSeven;
  signal input isEleven;

  signal output out;

  signal isNew;
  signal estIndex;
  signal newWin;
  signal newLose;
  signal estHit;
  signal estLose;
  signal hit;
  signal lose;
  signal resolved;

  component active;
  component newEq;
  component comeNum;
  component hitEq;
  component settle;

  active = IsEqual();
  active.in <== [type, 3];

  newEq = IsZero();
  newEq.in <== modifier;
  isNew <== newEq.out;
  estIndex <== (1 - isNew) * (modifier - 1);

  comeNum = PointNumber();
  comeNum.index <== estIndex;

  newWin <== isNew * (isTwo + isThree);
  newLose <== isNew * (isSeven + isEleven);

  hitEq = IsEqual();
  hitEq.in <== [total, comeNum.out];
  estHit <== (1 - isNew) * isSeven;
  estLose <== (1 - isNew) * hitEq.out;

  hit <== newWin + estHit;
  lose <== newLose + estLose;

  settle = CrapsKeepLoseWin();
  settle.hit <== hit;
  settle.lose <== lose;
  settle.winCode <== 31;
  resolved <== settle.out;

  out <== active.out * resolved;
}

template EvalOdds() {
  signal input type;
  signal input modifier;
  signal input phase;
  signal input point;
  signal input total;
  signal input isSeven;

  signal output out;

  signal family;
  signal idx;
  signal isPass;
  signal isDp;
  signal isCome;
  signal isDc;
  signal pointMatch;
  signal passWorking;
  signal dpWorking;
  signal comeWorking;
  signal passHit;
  signal passLose;
  signal dpHit;
  signal dpLose;
  signal comeHit;
  signal comeLose;
  signal dcHit;
  signal dcLose;
  signal takeCode;
  signal layCode;
  signal takeSide;
  signal laySide;
  signal takePart;
  signal layPart;
  signal winCode;
  signal hitPart[4];
  signal losePart[4];
  signal hit;
  signal lose;
  signal resolved;

  component active;
  component idxBound;
  component familyBound;
  component eqFamily[4];
  component oddsNum;
  component pointEq;
  component totalEq;
  component takeWin;
  component layWin;
  component settle;

  active = IsEqual();
  active.in <== [type, 4];

  family <-- modifier \ 6;
  idx <-- modifier % 6;
  modifier === family * 6 + idx;

  idxBound = ConstrainLt(3, 6);
  idxBound.in <== idx;

  familyBound = ConstrainLtIf(3, 4);
  familyBound.enabled <== active.out;
  familyBound.in <== family;

  for (var i = 0; i < 4; i++) {
    eqFamily[i] = IsEqual();
    eqFamily[i].in <== [family, i];
  }
  isPass <== eqFamily[0].out;
  isDp <== eqFamily[1].out;
  isCome <== eqFamily[2].out;
  isDc <== eqFamily[3].out;

  oddsNum = PointNumber();
  oddsNum.index <== idx;

  pointEq = IsEqual();
  pointEq.in <== [point, oddsNum.out];
  pointMatch <== pointEq.out;

  totalEq = IsEqual();
  totalEq.in <== [total, oddsNum.out];

  passWorking <== phase * pointMatch;
  dpWorking <== phase * pointMatch;
  comeWorking <== phase;

  passHit <== passWorking * totalEq.out;
  passLose <== passWorking * isSeven;
  dpHit <== dpWorking * isSeven;
  dpLose <== dpWorking * totalEq.out;
  comeHit <== comeWorking * totalEq.out;
  comeLose <== comeWorking * isSeven;
  dcHit <== isSeven;
  dcLose <== totalEq.out;

  takeWin = TrueOddsWinCode();
  takeWin.index <== idx;
  takeCode <== takeWin.out;

  layWin = LayOddsWinCode();
  layWin.index <== idx;
  layCode <== layWin.out;

  takeSide <== isPass + isCome;
  laySide <== isDp + isDc;
  takePart <== takeSide * takeCode;
  layPart <== laySide * layCode;
  winCode <== takePart + layPart;
  hitPart[0] <== isPass * passHit;
  hitPart[1] <== isDp * dpHit;
  hitPart[2] <== isCome * comeHit;
  hitPart[3] <== isDc * dcHit;
  hit <== hitPart[0] + hitPart[1] + hitPart[2] + hitPart[3];
  losePart[0] <== isPass * passLose;
  losePart[1] <== isDp * dpLose;
  losePart[2] <== isCome * comeLose;
  losePart[3] <== isDc * dcLose;
  lose <== losePart[0] + losePart[1] + losePart[2] + losePart[3];

  settle = CrapsKeepLoseWin();
  settle.hit <== hit;
  settle.lose <== lose;
  settle.winCode <== winCode;
  resolved <== settle.out;

  out <== active.out * resolved;
}

template EvalPlace() {
  signal input type;
  signal input modifier;
  signal input phase;
  signal input total;
  signal input isSeven;

  signal output out;

  signal hit;
  signal lose;
  signal resolved;

  component active;
  component placeNum;
  component hitEq;
  component winCode;
  component settle;

  active = IsEqual();
  active.in <== [type, 5];

  placeNum = PointNumber();
  placeNum.index <== modifier;

  hitEq = IsEqual();
  hitEq.in <== [total, placeNum.out];
  hit <== phase * hitEq.out;
  lose <== phase * isSeven;

  winCode = PlaceWinCode();
  winCode.index <== modifier;

  settle = CrapsKeepLoseWin();
  settle.hit <== hit;
  settle.lose <== lose;
  settle.winCode <== winCode.out;
  resolved <== settle.out;

  out <== active.out * resolved;
}

template EvalBuy() {
  signal input type;
  signal input modifier;
  signal input phase;
  signal input total;
  signal input isSeven;

  signal output out;

  signal hit;
  signal lose;
  signal resolved;

  component active;
  component buyNum;
  component hitEq;
  component winCode;
  component settle;

  active = IsEqual();
  active.in <== [type, 6];

  buyNum = PointNumber();
  buyNum.index <== modifier;

  hitEq = IsEqual();
  hitEq.in <== [total, buyNum.out];
  hit <== phase * hitEq.out;
  lose <== phase * isSeven;

  winCode = TrueOddsWinCode();
  winCode.index <== modifier;

  settle = CrapsKeepLoseWin();
  settle.hit <== hit;
  settle.lose <== lose;
  settle.winCode <== winCode.out;
  resolved <== settle.out;

  out <== active.out * resolved;
}

template EvalLay() {
  signal input type;
  signal input modifier;
  signal input total;
  signal input isSeven;

  signal output out;

  signal hit;
  signal lose;
  signal resolved;

  component active;
  component layNum;
  component hitEq;
  component winCode;
  component settle;

  active = IsEqual();
  active.in <== [type, 7];

  layNum = PointNumber();
  layNum.index <== modifier;

  hitEq = IsEqual();
  hitEq.in <== [total, layNum.out];
  hit <== isSeven;
  lose <== hitEq.out;

  winCode = LayOddsWinCode();
  winCode.index <== modifier;

  settle = CrapsKeepLoseWin();
  settle.hit <== hit;
  settle.lose <== lose;
  settle.winCode <== winCode.out;
  resolved <== settle.out;

  out <== active.out * resolved;
}

template EvalField() {
  signal input type;
  signal input isTwo;
  signal input isThree;
  signal input isFour;
  signal input isNine;
  signal input isTen;
  signal input isEleven;
  signal input isTwelve;

  signal output out;

  signal hit;
  signal lose;
  signal isDouble;
  signal doublePart;
  signal singlePart;
  signal notDouble;
  signal winCode;
  signal resolved;

  component active;
  component settle;

  active = IsEqual();
  active.in <== [type, 8];

  hit <== isTwo + isThree + isFour + isNine + isTen + isEleven + isTwelve;
  lose <== 1 - hit;
  isDouble <== isTwo + isTwelve;
  notDouble <== 1 - isDouble;
  doublePart <== isDouble * 61;
  singlePart <== notDouble * 31;
  winCode <== doublePart + singlePart;

  settle = CrapsKeepLoseWin();
  settle.hit <== hit;
  settle.lose <== lose;
  settle.winCode <== winCode;
  resolved <== settle.out;

  out <== active.out * resolved;
}

template EvalProposition() {
  signal input type;
  signal input modifier;
  signal input isTwo;
  signal input isThree;
  signal input isSeven;
  signal input isEleven;
  signal input isTwelve;

  signal output out;

  signal isType[7];
  signal hitPart[7];
  signal winPart[7];
  signal hitAcc[8];
  signal winAcc[8];
  signal hit;
  signal lose;
  signal winCode;
  signal resolved;

  component active;
  component eqMod[7];
  component settle;

  active = IsEqual();
  active.in <== [type, 9];

  for (var i = 0; i < 7; i++) {
    eqMod[i] = IsEqual();
    eqMod[i].in <== [modifier, i];
    isType[i] <== eqMod[i].out;
  }

  hitPart[0] <== isType[0] * isSeven;
  hitPart[1] <== isType[1] * (isTwo + isThree + isTwelve);
  hitPart[2] <== isType[2] * isEleven;
  hitPart[3] <== isType[3] * isThree;
  hitPart[4] <== isType[4] * isTwo;
  hitPart[5] <== isType[5] * isTwelve;
  hitPart[6] <== isType[6] * (isTwo + isTwelve);
  winPart[0] <== isType[0] * 121;
  winPart[1] <== isType[1] * 211;
  winPart[2] <== isType[2] * 451;
  winPart[3] <== isType[3] * 451;
  winPart[4] <== isType[4] * 901;
  winPart[5] <== isType[5] * 901;
  winPart[6] <== isType[6] * 451;
  hitAcc[0] <== 0;
  winAcc[0] <== 0;
  for (var i = 0; i < 7; i++) {
    hitAcc[i + 1] <== hitAcc[i] + hitPart[i];
    winAcc[i + 1] <== winAcc[i] + winPart[i];
  }
  hit <== hitAcc[7];
  lose <== 1 - hit;
  winCode <== winAcc[7];

  settle = CrapsKeepLoseWin();
  settle.hit <== hit;
  settle.lose <== lose;
  settle.winCode <== winCode;
  resolved <== settle.out;

  out <== active.out * resolved;
}

template EvalHardway() {
  signal input type;
  signal input modifier;
  signal input phase;
  signal input total;
  signal input isSeven;
  signal input isHard;

  signal output out;

  signal totalMatch;
  signal easy;
  signal hardHit;
  signal hit;
  signal lose;
  signal isOuter;
  signal notOuter;
  signal outerPart;
  signal innerPart;
  signal winCode;
  signal resolved;

  component active;
  component hardNum;
  component hitEq;
  component eq0;
  component eq3;
  component settle;

  active = IsEqual();
  active.in <== [type, 10];

  hardNum = HardNumber();
  hardNum.index <== modifier;

  hitEq = IsEqual();
  hitEq.in <== [total, hardNum.out];
  totalMatch <== hitEq.out;
  easy <== (1 - isHard) * totalMatch;
  hardHit <== isHard * totalMatch;
  hit <== phase * hardHit;
  lose <== phase * (easy + isSeven);

  eq0 = IsZero();
  eq0.in <== modifier;
  eq3 = IsEqual();
  eq3.in <== [modifier, 3];
  isOuter <== eq0.out + eq3.out;
  notOuter <== 1 - isOuter;
  outerPart <== isOuter * 211;
  innerPart <== notOuter * 271;
  winCode <== outerPart + innerPart;

  settle = CrapsKeepLoseWin();
  settle.hit <== hit;
  settle.lose <== lose;
  settle.winCode <== winCode;
  resolved <== settle.out;

  out <== active.out * resolved;
}

template EvalBig() {
  signal input type;
  signal input modifier;
  signal input phase;
  signal input total;
  signal input isSeven;

  signal output out;

  signal isSix;
  signal notSix;
  signal sixPart;
  signal eightPart;
  signal num;
  signal hit;
  signal lose;
  signal resolved;

  component active;
  component sixEq;
  component hitEq;
  component settle;

  active = IsEqual();
  active.in <== [type, 11];

  sixEq = IsZero();
  sixEq.in <== modifier;
  isSix <== sixEq.out;
  notSix <== 1 - isSix;
  sixPart <== isSix * 6;
  eightPart <== notSix * 8;
  num <== sixPart + eightPart;

  hitEq = IsEqual();
  hitEq.in <== [total, num];
  hit <== phase * hitEq.out;
  lose <== phase * isSeven;

  settle = CrapsKeepLoseWin();
  settle.hit <== hit;
  settle.lose <== lose;
  settle.winCode <== 31;
  resolved <== settle.out;

  out <== active.out * resolved;
}

template EvaluateCrapsBet() {
  signal input type;
  signal input modifier;
  signal input diceValues[2];
  signal input phase;
  signal input point;

  signal output out;

  component facts;
  component pass;
  component dontPass;
  component come;
  component dontCome;
  component odds;
  component place;
  component buy;
  component lay;
  component field;
  component proposition;
  component hardway;
  component big;

  facts = CrapsRollFacts();
  facts.diceValues <== diceValues;

  pass = EvalPass();
  pass.type <== type;
  pass.phase <== phase;
  pass.point <== point;
  pass.total <== facts.total;
  pass.isSeven <== facts.isSeven;
  pass.isEleven <== facts.isEleven;
  pass.isCraps <== facts.isCraps;

  dontPass = EvalDontPass();
  dontPass.type <== type;
  dontPass.phase <== phase;
  dontPass.point <== point;
  dontPass.total <== facts.total;
  dontPass.isTwo <== facts.isTwo;
  dontPass.isThree <== facts.isThree;
  dontPass.isTwelve <== facts.isTwelve;
  dontPass.isSeven <== facts.isSeven;
  dontPass.isEleven <== facts.isEleven;

  come = EvalCome();
  come.type <== type;
  come.modifier <== modifier;
  come.total <== facts.total;
  come.isSeven <== facts.isSeven;
  come.isEleven <== facts.isEleven;
  come.isCraps <== facts.isCraps;

  dontCome = EvalDontCome();
  dontCome.type <== type;
  dontCome.modifier <== modifier;
  dontCome.total <== facts.total;
  dontCome.isTwo <== facts.isTwo;
  dontCome.isThree <== facts.isThree;
  dontCome.isSeven <== facts.isSeven;
  dontCome.isEleven <== facts.isEleven;

  odds = EvalOdds();
  odds.type <== type;
  odds.modifier <== modifier;
  odds.phase <== phase;
  odds.point <== point;
  odds.total <== facts.total;
  odds.isSeven <== facts.isSeven;

  place = EvalPlace();
  place.type <== type;
  place.modifier <== modifier;
  place.phase <== phase;
  place.total <== facts.total;
  place.isSeven <== facts.isSeven;

  buy = EvalBuy();
  buy.type <== type;
  buy.modifier <== modifier;
  buy.phase <== phase;
  buy.total <== facts.total;
  buy.isSeven <== facts.isSeven;

  lay = EvalLay();
  lay.type <== type;
  lay.modifier <== modifier;
  lay.total <== facts.total;
  lay.isSeven <== facts.isSeven;

  field = EvalField();
  field.type <== type;
  field.isTwo <== facts.isTwo;
  field.isThree <== facts.isThree;
  field.isFour <== facts.isFour;
  field.isNine <== facts.isNine;
  field.isTen <== facts.isTen;
  field.isEleven <== facts.isEleven;
  field.isTwelve <== facts.isTwelve;

  proposition = EvalProposition();
  proposition.type <== type;
  proposition.modifier <== modifier;
  proposition.isTwo <== facts.isTwo;
  proposition.isThree <== facts.isThree;
  proposition.isSeven <== facts.isSeven;
  proposition.isEleven <== facts.isEleven;
  proposition.isTwelve <== facts.isTwelve;

  hardway = EvalHardway();
  hardway.type <== type;
  hardway.modifier <== modifier;
  hardway.phase <== phase;
  hardway.total <== facts.total;
  hardway.isSeven <== facts.isSeven;
  hardway.isHard <== facts.isHard;

  big = EvalBig();
  big.type <== type;
  big.modifier <== modifier;
  big.phase <== phase;
  big.total <== facts.total;
  big.isSeven <== facts.isSeven;

  out <== pass.out
    + dontPass.out
    + come.out
    + dontCome.out
    + odds.out
    + place.out
    + buy.out
    + lay.out
    + field.out
    + proposition.out
    + hardway.out
    + big.out;
}

template EvaluateCrapsBets(nBets) {
  assert(nBets >= 1 && nBets <= 12);

  signal input diceValues[2];
  signal input phase;
  signal input point;
  signal input in[nBets][2];
  signal input nActualBets;

  signal output out[nBets];

  component lt;
  component evaluateBets[nBets];
  component lessThan[nBets];

  lt = ConstrainLt(4, nBets + 1);
  lt.in <== nActualBets;

  for (var i = 0; i < nBets; i++) {
    evaluateBets[i] = parallel EvaluateCrapsBet();
    evaluateBets[i].type <== in[i][0];
    evaluateBets[i].modifier <== in[i][1];
    evaluateBets[i].diceValues <== diceValues;
    evaluateBets[i].phase <== phase;
    evaluateBets[i].point <== point;

    lessThan[i] = LessThan(4);
    lessThan[i].in <== [i, nActualBets];

    out[i] <== evaluateBets[i].out * lessThan[i].out;
  }
}
