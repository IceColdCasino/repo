/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./bet.circom";
include "./hash.circom";

// Placement constraints for a single roulette bet (type + modifier).
// Modifier ranges match roulette_bet_eval.circom:
// 0 Straight up   US: 0..37 (00=37) / EU: 0..36
// 1 Row (US only) modifier must be 0
// 2 Split         0..56
// 3 Street        0..11
// 4 Corner        0..21
// 5 Top line      modifier must be 0
// 6 Double street 0..10
// 7 Column        0..2
// 8 Dozen         0..2
// 9 Even/Odd      0..1
// 10 Red/Black    0..1
// 11 Half         0..1

// American 38-pocket wheel (0-36, 37 = 00). Types 0..11.
template ConstrainBetUS() {
  signal input type;
  signal input modifier;

  component typeBound;
  component isType[12];
  component straightUp;
  component row;
  component split;
  component street;
  component corner;
  component topLine;
  component doubleStreet;
  component column;
  component dozen;
  component evenOdd;
  component redBlack;
  component half;

  // type ∈ [0, 11]
  typeBound = ConstrainLt(4, 12);
  typeBound.in <== type;

  for (var i = 0; i < 12; i++) {
    isType[i] = IsEqual();
    isType[i].in <== [type, i];
  }

  // 0 - Straight up: modifier < 38
  straightUp = ConstrainLtIf(6, 38);
  straightUp.enabled <== isType[0].out;
  straightUp.in <== modifier;

  // 1 - Row: no modifier
  row = ConstrainZeroIf();
  row.enabled <== isType[1].out;
  row.in <== modifier;

  // 2 - Split: modifier < 57
  split = ConstrainLtIf(6, 57);
  split.enabled <== isType[2].out;
  split.in <== modifier;

  // 3 - Street: modifier < 12
  street = ConstrainLtIf(4, 12);
  street.enabled <== isType[3].out;
  street.in <== modifier;

  // 4 - Corner: modifier < 22
  corner = ConstrainLtIf(5, 22);
  corner.enabled <== isType[4].out;
  corner.in <== modifier;

  // 5 - Top line: no modifier
  topLine = ConstrainZeroIf();
  topLine.enabled <== isType[5].out;
  topLine.in <== modifier;

  // 6 - Double street: modifier < 11
  doubleStreet = ConstrainLtIf(4, 11);
  doubleStreet.enabled <== isType[6].out;
  doubleStreet.in <== modifier;

  // 7 - Column: modifier < 3
  column = ConstrainLtIf(2, 3);
  column.enabled <== isType[7].out;
  column.in <== modifier;

  // 8 - Dozen: modifier < 3
  dozen = ConstrainLtIf(2, 3);
  dozen.enabled <== isType[8].out;
  dozen.in <== modifier;

  // 9 - Even/Odd: modifier < 2
  evenOdd = ConstrainLtIf(2, 2);
  evenOdd.enabled <== isType[9].out;
  evenOdd.in <== modifier;

  // 10 - Red/Black: modifier < 2
  redBlack = ConstrainLtIf(2, 2);
  redBlack.enabled <== isType[10].out;
  redBlack.in <== modifier;

  // 11 - Half: modifier < 2
  half = ConstrainLtIf(2, 2);
  half.enabled <== isType[11].out;
  half.in <== modifier;
}

// European 37-pocket wheel (0-36). Types 0,2..11 (no row / 00).
template ConstrainBetEU() {
  signal input type;
  signal input modifier;

  component typeBound;
  component notRow;
  component isType[12];
  component straightUp;
  component split;
  component street;
  component corner;
  component topLine;
  component doubleStreet;
  component column;
  component dozen;
  component evenOdd;
  component redBlack;
  component half;

  // type ∈ [0, 11]
  typeBound = ConstrainLt(4, 12);
  typeBound.in <== type;

  // Row (type 1) is US/38-only — forbid on European 37.
  notRow = IsEqual();
  notRow.in <== [type, 1];
  notRow.out === 0;

  for (var i = 0; i < 12; i++) {
    isType[i] = IsEqual();
    isType[i].in <== [type, i];
  }

  // 0 - Straight up: modifier < 37
  straightUp = ConstrainLtIf(6, 37);
  straightUp.enabled <== isType[0].out;
  straightUp.in <== modifier;

  // 2 - Split: modifier < 57
  split = ConstrainLtIf(6, 57);
  split.enabled <== isType[2].out;
  split.in <== modifier;

  // 3 - Street: modifier < 12
  street = ConstrainLtIf(4, 12);
  street.enabled <== isType[3].out;
  street.in <== modifier;

  // 4 - Corner: modifier < 22
  corner = ConstrainLtIf(5, 22);
  corner.enabled <== isType[4].out;
  corner.in <== modifier;

  // 5 - Top line: no modifier
  topLine = ConstrainZeroIf();
  topLine.enabled <== isType[5].out;
  topLine.in <== modifier;

  // 6 - Double street: modifier < 11
  doubleStreet = ConstrainLtIf(4, 11);
  doubleStreet.enabled <== isType[6].out;
  doubleStreet.in <== modifier;

  // 7 - Column: modifier < 3
  column = ConstrainLtIf(2, 3);
  column.enabled <== isType[7].out;
  column.in <== modifier;

  // 8 - Dozen: modifier < 3
  dozen = ConstrainLtIf(2, 3);
  dozen.enabled <== isType[8].out;
  dozen.in <== modifier;

  // 9 - Even/Odd: modifier < 2
  evenOdd = ConstrainLtIf(2, 2);
  evenOdd.enabled <== isType[9].out;
  evenOdd.in <== modifier;

  // 10 - Red/Black: modifier < 2
  redBlack = ConstrainLtIf(2, 2);
  redBlack.enabled <== isType[10].out;
  redBlack.in <== modifier;

  // 11 - Half: modifier < 2
  half = ConstrainLtIf(2, 2);
  half.enabled <== isType[11].out;
  half.in <== modifier;
}

template CommitBet(deckSize) {
  assert(deckSize == 37 || deckSize == 38);

  signal input type;
  signal input modifier;
  signal input packedBet;
  signal input publicKey[2];
  signal input randomness;

  signal output out[4];

  component babyPbk;
  component encrypt;

  if (deckSize == 37) {
    component constrainBetEU;
    constrainBetEU = ConstrainBetEU();
    constrainBetEU.type <== type;
    constrainBetEU.modifier <== modifier;
  } else {
    component constrainBetUS;
    constrainBetUS = ConstrainBetUS();
    constrainBetUS.type <== type;
    constrainBetUS.modifier <== modifier;
  }

  babyPbk = BabyPbk();
  babyPbk.in <== packedBet + 1;

  encrypt = Encrypt();
  encrypt.plaintext <== [babyPbk.Ax, babyPbk.Ay];
  encrypt.publicKey <== publicKey;
  encrypt.randomness <== randomness;

  out <== encrypt.ciphertext;
}

template CommitBets(nPlayers, deckSize, nBets) {
  assert(nPlayers >= 2 && nPlayers <= 12);
  assert(nBets >= 1 && nBets <= 12);
  assert(deckSize == 37 || deckSize == 38);

  signal input publicKeys[nPlayers][2];
  signal input nActualBets;
  signal input plaintextBets[nBets][2];
  signal input randomness[nPlayers][nBets];

  signal output out[nPlayers][nBets][4];

  component lt;
  component uniqueBets;
  component commitBet[nPlayers][nBets];

  // 0 <= nActualBets <= nBets
  lt = ConstrainLt(4, nBets + 1);
  lt.in <== nActualBets;

  // (type, modifier) pairs must be unique among the actual bets.
  uniqueBets = parallel UniqueActualBets(nBets);
  uniqueBets.nActualBets <== nActualBets;
  uniqueBets.plaintextBets <== plaintextBets;

  for (var p = 0; p < nPlayers; p++) {
    for (var i = 0; i < nBets; i++) {
      commitBet[p][i] = parallel CommitBet(deckSize);
      commitBet[p][i].type <== plaintextBets[i][0];
      commitBet[p][i].modifier <== plaintextBets[i][1];
      commitBet[p][i].packedBet <== uniqueBets.packedBets[i];
      commitBet[p][i].publicKey <== publicKeys[p];
      commitBet[p][i].randomness <== randomness[p][i];

      out[p][i] <== commitBet[p][i].out;
    }
  }
}

// Player + house only — placements are not sealed to the rest of the table.
template RouletteBet(nPlayers, deckSize, nBets) {
  assert(nPlayers == 2);
  assert(deckSize == 37 || deckSize == 38);
  assert(nBets >= 1 && nBets <= 12);

  var nOthers = nPlayers - 1;

  signal input hash;

  signal input publicKey[2];
  signal input publicKeys[nOthers][2];
  signal input nActualBets;

  signal input plaintextBets[nBets][2];
  signal input randomness[nPlayers][nBets];

  signal output out[nPlayers][nBets][4];

  signal allPublicKeys[nPlayers][2];

  component hashPublicKeys;
  component finalHash;
  component commitBets;

  allPublicKeys[0] <== publicKey;
  for (var i = 0; i < nOthers; i++) {
    allPublicKeys[i + 1] <== publicKeys[i];
  }

  hashPublicKeys = HashPublicKeys(nPlayers);
  hashPublicKeys.publicKeys <== allPublicKeys;

  finalHash = Poseidon(2);
  finalHash.inputs <== [hashPublicKeys.out, nActualBets];
  hash === finalHash.out;

  commitBets = CommitBets(nPlayers, deckSize, nBets);
  commitBets.publicKeys <== allPublicKeys;
  commitBets.plaintextBets <== plaintextBets;
  commitBets.nActualBets <== nActualBets;
  commitBets.randomness <== randomness;

  out <== commitBets.out;
}
