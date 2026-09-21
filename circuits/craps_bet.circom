/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./bet.circom";
include "./hash.circom";

// Placement constraints for a single craps bet (type + modifier).
// Wikipedia bank-craps families, 12 types (same slot count as roulette):
// 0 Pass           modifier 0
// 1 Don't Pass     modifier 0 (Bar-12)
// 2 Come           0 = new this roll; 1..6 = working 4,5,6,8,9,10
// 3 Don't Come     same as Come
// 4 Odds           0..23 = line*6 + pointIndex
//                    line 0 Pass / 1 Don't Pass / 2 Come / 3 Don't Come
//                    pointIndex 0..5 → 4,5,6,8,9,10
// 5 Place          0..5 → 4,5,6,8,9,10
// 6 Buy            0..5 → 4,5,6,8,9,10
// 7 Lay            0..5 → 4,5,6,8,9,10
// 8 Field          modifier 0
// 9 Proposition    0 Any 7 / 1 Any craps / 2 Yo / 3 Ace-deuce
//                  4 Aces / 5 Twelve / 6 Hi-Lo
// 10 Hardway       0..3 → 4,6,8,10
// 11 Big 6/8       0 = 6, 1 = 8

template ConstrainCrapsBet() {
  signal input type;
  signal input modifier;

  component typeBound;
  component isType[12];
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

  typeBound = ConstrainLt(4, 12);
  typeBound.in <== type;

  for (var i = 0; i < 12; i++) {
    isType[i] = IsEqual();
    isType[i].in <== [type, i];
  }

  pass = ConstrainZeroIf();
  pass.enabled <== isType[0].out;
  pass.in <== modifier;

  dontPass = ConstrainZeroIf();
  dontPass.enabled <== isType[1].out;
  dontPass.in <== modifier;

  come = ConstrainLtIf(3, 7);
  come.enabled <== isType[2].out;
  come.in <== modifier;

  dontCome = ConstrainLtIf(3, 7);
  dontCome.enabled <== isType[3].out;
  dontCome.in <== modifier;

  odds = ConstrainLtIf(5, 24);
  odds.enabled <== isType[4].out;
  odds.in <== modifier;

  place = ConstrainLtIf(3, 6);
  place.enabled <== isType[5].out;
  place.in <== modifier;

  buy = ConstrainLtIf(3, 6);
  buy.enabled <== isType[6].out;
  buy.in <== modifier;

  lay = ConstrainLtIf(3, 6);
  lay.enabled <== isType[7].out;
  lay.in <== modifier;

  field = ConstrainZeroIf();
  field.enabled <== isType[8].out;
  field.in <== modifier;

  proposition = ConstrainLtIf(3, 7);
  proposition.enabled <== isType[9].out;
  proposition.in <== modifier;

  hardway = ConstrainLtIf(3, 4);
  hardway.enabled <== isType[10].out;
  hardway.in <== modifier;

  big = ConstrainLtIf(2, 2);
  big.enabled <== isType[11].out;
  big.in <== modifier;
}

template CommitCrapsBet() {
  signal input type;
  signal input modifier;
  signal input packedBet;
  signal input publicKey[2];
  signal input randomness;

  signal output out[4];

  component constrainBet;
  component babyPbk;
  component encrypt;

  constrainBet = ConstrainCrapsBet();
  constrainBet.type <== type;
  constrainBet.modifier <== modifier;

  babyPbk = BabyPbk();
  babyPbk.in <== packedBet + 1;

  encrypt = Encrypt();
  encrypt.plaintext <== [babyPbk.Ax, babyPbk.Ay];
  encrypt.publicKey <== publicKey;
  encrypt.randomness <== randomness;

  out <== encrypt.ciphertext;
}

template CommitCrapsBets(nPlayers, nBets) {
  assert(nPlayers >= 2 && nPlayers <= 12);
  assert(nBets >= 1 && nBets <= 12);

  signal input publicKeys[nPlayers][2];
  signal input nActualBets;
  signal input plaintextBets[nBets][2];
  signal input randomness[nPlayers][nBets];

  signal output out[nPlayers][nBets][4];

  component lt;
  component uniqueBets;
  component commitBet[nPlayers][nBets];

  lt = ConstrainLt(4, nBets + 1);
  lt.in <== nActualBets;

  uniqueBets = parallel UniqueActualBets(nBets);
  uniqueBets.nActualBets <== nActualBets;
  uniqueBets.plaintextBets <== plaintextBets;

  for (var p = 0; p < nPlayers; p++) {
    for (var i = 0; i < nBets; i++) {
      commitBet[p][i] = parallel CommitCrapsBet();
      commitBet[p][i].type <== plaintextBets[i][0];
      commitBet[p][i].modifier <== plaintextBets[i][1];
      commitBet[p][i].packedBet <== uniqueBets.packedBets[i];
      commitBet[p][i].publicKey <== publicKeys[p];
      commitBet[p][i].randomness <== randomness[p][i];

      out[p][i] <== commitBet[p][i].out;
    }
  }
}

template DecryptBets(nBets) {
  signal input ciphertextBets[nBets][4];
  signal input privateKey;

  signal output decryptedBets[nBets][2];

  component decrypt[nBets];

  for (var i = 0; i < nBets; i++) {
    decrypt[i] = parallel Decrypt();
    decrypt[i].ciphertext <== ciphertextBets[i];
    decrypt[i].privateKey <== privateKey;

    decryptedBets[i] <== decrypt[i].plaintext;
  }
}

// Encoding check: BabyPbk(PackBet(type, modifier) + 1). Bounds enforced at share/commit.
template VerifyDecryptedBets(nBets) {
  signal input decryptedBets[nBets][2];
  signal input plaintextBets[nBets][2];

  component pack[nBets];
  component babyPbk[nBets];
  component isEqual[nBets][2];

  for (var i = 0; i < nBets; i++) {
    pack[i] = PackBet();
    pack[i].type <== plaintextBets[i][0];
    pack[i].modifier <== plaintextBets[i][1];

    babyPbk[i] = parallel BabyPbk();
    babyPbk[i].in <== pack[i].out + 1;

    for (var j = 0; j < 2; j++) {
      isEqual[i][j] = IsEqual();
    }
    isEqual[i][0].in <== [decryptedBets[i][0], babyPbk[i].Ax];
    isEqual[i][1].in <== [decryptedBets[i][1], babyPbk[i].Ay];
    isEqual[i][0].out * isEqual[i][1].out === 1;
  }
}

// Player + house only — the 12-slot book is not sealed to other seats.
template CrapsBet(nPlayers, nBets) {
  assert(nPlayers == 2);
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

  commitBets = CommitCrapsBets(nPlayers, nBets);
  commitBets.publicKeys <== allPublicKeys;
  commitBets.plaintextBets <== plaintextBets;
  commitBets.nActualBets <== nActualBets;
  commitBets.randomness <== randomness;

  out <== commitBets.out;
}
