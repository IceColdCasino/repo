/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./partials.circom";
include "./showdown.circom";
include "./hash.circom";
include "./bingo_card.circom";
include "./bingo_eval.circom";
include "./keno_bet.circom";
include "./helpers.circom";

template VerifyCalledBalls(nMax, shoeSize) {
  signal input plaintextCards[nMax];
  signal input decryptedCards[nMax][2];
  signal input nCalled;

  signal bothEq[nMax];

  component lt[nMax];
  component babyPbk[nMax];
  component eq[nMax][2];
  component range[nMax];

  for (var i = 0; i < nMax; i++) {
    lt[i] = LessThan(8);
    lt[i].in <== [i, nCalled];

    range[i] = ConstrainLtIf(8, shoeSize);
    range[i].enabled <== lt[i].out;
    range[i].in <== plaintextCards[i];

    babyPbk[i] = parallel BabyPbk();
    babyPbk[i].in <== plaintextCards[i] + 1;

    eq[i][0] = IsEqual();
    eq[i][0].in <== [decryptedCards[i][0], babyPbk[i].Ax];
    eq[i][1] = IsEqual();
    eq[i][1].in <== [decryptedCards[i][1], babyPbk[i].Ay];
    bothEq[i] <== eq[i][0].out * eq[i][1].out;
    lt[i].out * (1 - bothEq[i]) === 0;
  }
}

template BingoShowdownHashMain75(nPlayers, nMax, nCells) {
  var nOthers = nPlayers - 1;

  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nMax][4];
  signal input ciphertextPartials[nOthers][nMax][4];
  signal input ciphertextCardCells[nCells][4];
  signal input patternId;
  signal input nCalled;

  signal output out;

  component h1;
  component _h2[nPlayers];
  component h2;
  component cardHash;
  component finalHash;

  h1 = HashPublicKeys(nPlayers);
  h1.publicKeys <== publicKeys;

  h2 = Poseidon(nPlayers);
  for (var p = 0; p < nPlayers; p++) {
    _h2[p] = parallel HashCiphertexts(nMax);
    if (p == 0) {
      _h2[p].ciphertext <== ciphertextCards;
    } else {
      _h2[p].ciphertext <== ciphertextPartials[p - 1];
    }
    h2.inputs[p] <== _h2[p].out;
  }

  cardHash = HashCiphertexts(nCells);
  cardHash.ciphertext <== ciphertextCardCells;

  finalHash = Poseidon(6);
  finalHash.inputs <== [h1.out, playerIndex, h2.out, cardHash.out, patternId, nCalled];
  out <== finalHash.out;
}

template BingoShowdownHashMain90(nPlayers, nMax, nCells) {
  var nOthers = nPlayers - 1;

  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nMax][4];
  signal input ciphertextPartials[nOthers][nMax][4];
  signal input ciphertextCardCells[nCells][4];
  signal input nCalled;

  signal output out;

  component h1;
  component _h2[nPlayers];
  component h2;
  component cardHash;
  component finalHash;

  h1 = HashPublicKeys(nPlayers);
  h1.publicKeys <== publicKeys;

  h2 = Poseidon(nPlayers);
  for (var p = 0; p < nPlayers; p++) {
    _h2[p] = parallel HashCiphertexts(nMax);
    if (p == 0) {
      _h2[p].ciphertext <== ciphertextCards;
    } else {
      _h2[p].ciphertext <== ciphertextPartials[p - 1];
    }
    h2.inputs[p] <== _h2[p].out;
  }

  cardHash = HashCiphertexts(nCells);
  cardHash.ciphertext <== ciphertextCardCells;

  finalHash = Poseidon(5);
  finalHash.inputs <== [h1.out, playerIndex, h2.out, cardHash.out, nCalled];
  out <== finalHash.out;
}

template Showdown75(nPlayers, nMax) {
  var nOthers = nPlayers - 1;
  var nCells = 25;

  signal input hash;
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nMax][4];
  signal input ciphertextPartials[nOthers][nMax][4];
  signal input ciphertextCardCells[nCells][4];
  signal input patternId;
  signal input nCalled;

  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nMax];
  signal input plaintextCells[nCells];

  signal output packed;

  component publicKeyCheck;
  component verifyKey;
  component hashMain;
  component decryptPartials;
  component decryptCells;
  component createOwnPartials;
  component aggregatePartials;
  component verifyBalls;
  component verifyCells;
  component eval;
  component patternLt;
  component nCalledLt;
  component nCalledGt;

  publicKeyCheck = PublicKeyCheck(nPlayers);
  publicKeyCheck.publicKeys <== publicKeys;
  publicKeyCheck.playerIndex <== playerIndex;
  publicKeyCheck.publicKey <== publicKey;

  verifyKey = VerifyKey();
  verifyKey.privateKey <== privateKey;
  verifyKey.publicKey <== publicKey;

  patternLt = ConstrainLt(3, 3);
  patternLt.in <== patternId;
  nCalledGt = ConstrainGt(8, 0);
  nCalledGt.in <== nCalled;
  nCalledLt = ConstrainLt(8, nMax + 1);
  nCalledLt.in <== nCalled;

  hashMain = BingoShowdownHashMain75(nPlayers, nMax, nCells);
  hashMain.publicKeys <== publicKeys;
  hashMain.playerIndex <== playerIndex;
  hashMain.ciphertextCards <== ciphertextCards;
  hashMain.ciphertextPartials <== ciphertextPartials;
  hashMain.ciphertextCardCells <== ciphertextCardCells;
  hashMain.patternId <== patternId;
  hashMain.nCalled <== nCalled;
  hash === hashMain.out;

  decryptPartials = parallel DecryptPartials(nPlayers, nMax);
  decryptPartials.ciphertextPartials <== ciphertextPartials;
  decryptPartials.privateKey <== privateKey;

  decryptCells = parallel DecryptBets(nCells);
  decryptCells.ciphertextBets <== ciphertextCardCells;
  decryptCells.privateKey <== privateKey;

  createOwnPartials = parallel CreateOwnPartials(nMax);
  createOwnPartials.ciphertextCards <== ciphertextCards;
  createOwnPartials.privateKey <== privateKey;

  aggregatePartials = AggregatePartials(nPlayers, nMax);
  aggregatePartials.ownPartials <== createOwnPartials.ownPartials;
  aggregatePartials.otherPartials <== decryptPartials.partials;
  aggregatePartials.ciphertextCards <== ciphertextCards;

  verifyBalls = VerifyCalledBalls(nMax, 75);
  verifyBalls.plaintextCards <== plaintextCards;
  verifyBalls.decryptedCards <== aggregatePartials.decryptedCards;
  verifyBalls.nCalled <== nCalled;

  verifyCells = VerifyDecryptedBets(nCells);
  verifyCells.decryptedBets <== decryptCells.decryptedBets;
  verifyCells.plaintextBets <== plaintextCells;

  eval = Evaluate75(nMax);
  eval.cells <== plaintextCells;
  eval.balls <== plaintextCards;
  eval.nCalled <== nCalled;
  eval.patternId <== patternId;
  packed <== eval.packed;
}

template Showdown90(nPlayers, nMax) {
  var nOthers = nPlayers - 1;
  var nCells = 27;

  signal input hash;
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nMax][4];
  signal input ciphertextPartials[nOthers][nMax][4];
  signal input ciphertextCardCells[nCells][4];
  signal input nCalled;

  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nMax];
  signal input plaintextCells[nCells];

  signal output packed[3];

  component publicKeyCheck;
  component verifyKey;
  component hashMain;
  component decryptPartials;
  component decryptCells;
  component createOwnPartials;
  component aggregatePartials;
  component verifyBalls;
  component verifyCells;
  component eval;
  component nCalledLt;
  component nCalledGt;

  publicKeyCheck = PublicKeyCheck(nPlayers);
  publicKeyCheck.publicKeys <== publicKeys;
  publicKeyCheck.playerIndex <== playerIndex;
  publicKeyCheck.publicKey <== publicKey;

  verifyKey = VerifyKey();
  verifyKey.privateKey <== privateKey;
  verifyKey.publicKey <== publicKey;

  nCalledGt = ConstrainGt(8, 0);
  nCalledGt.in <== nCalled;
  nCalledLt = ConstrainLt(8, nMax + 1);
  nCalledLt.in <== nCalled;

  hashMain = BingoShowdownHashMain90(nPlayers, nMax, nCells);
  hashMain.publicKeys <== publicKeys;
  hashMain.playerIndex <== playerIndex;
  hashMain.ciphertextCards <== ciphertextCards;
  hashMain.ciphertextPartials <== ciphertextPartials;
  hashMain.ciphertextCardCells <== ciphertextCardCells;
  hashMain.nCalled <== nCalled;
  hash === hashMain.out;

  decryptPartials = parallel DecryptPartials(nPlayers, nMax);
  decryptPartials.ciphertextPartials <== ciphertextPartials;
  decryptPartials.privateKey <== privateKey;

  decryptCells = parallel DecryptBets(nCells);
  decryptCells.ciphertextBets <== ciphertextCardCells;
  decryptCells.privateKey <== privateKey;

  createOwnPartials = parallel CreateOwnPartials(nMax);
  createOwnPartials.ciphertextCards <== ciphertextCards;
  createOwnPartials.privateKey <== privateKey;

  aggregatePartials = AggregatePartials(nPlayers, nMax);
  aggregatePartials.ownPartials <== createOwnPartials.ownPartials;
  aggregatePartials.otherPartials <== decryptPartials.partials;
  aggregatePartials.ciphertextCards <== ciphertextCards;

  verifyBalls = VerifyCalledBalls(nMax, 90);
  verifyBalls.plaintextCards <== plaintextCards;
  verifyBalls.decryptedCards <== aggregatePartials.decryptedCards;
  verifyBalls.nCalled <== nCalled;

  verifyCells = VerifyDecryptedBets(nCells);
  verifyCells.decryptedBets <== decryptCells.decryptedBets;
  verifyCells.plaintextBets <== plaintextCells;

  eval = Evaluate90(nMax);
  eval.cells <== plaintextCells;
  eval.balls <== plaintextCards;
  eval.nCalled <== nCalled;
  packed <== eval.packed;
}

template Showdown75HashOut(nPlayers, nMax) {
  var nOthers = nPlayers - 1;
  var nCells = 25;

  signal input hash;
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nMax][4];
  signal input ciphertextPartials[nOthers][nMax][4];
  signal input ciphertextCardCells[nCells][4];
  signal input patternId;
  signal input nCalled;
  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nMax];
  signal input plaintextCells[nCells];
  signal input coefficients[1];

  signal output out;

  component showdown;
  component hashOut;

  showdown = Showdown75(nPlayers, nMax);
  showdown.hash <== hash;
  showdown.publicKeys <== publicKeys;
  showdown.playerIndex <== playerIndex;
  showdown.ciphertextCards <== ciphertextCards;
  showdown.ciphertextPartials <== ciphertextPartials;
  showdown.ciphertextCardCells <== ciphertextCardCells;
  showdown.patternId <== patternId;
  showdown.nCalled <== nCalled;
  showdown.privateKey <== privateKey;
  showdown.publicKey <== publicKey;
  showdown.plaintextCards <== plaintextCards;
  showdown.plaintextCells <== plaintextCells;

  hashOut = ShowdownPolynomialHash(1);
  hashOut.results <== [showdown.packed];
  hashOut.coefficients <== coefficients;
  out <== hashOut.out;
}

template Showdown90HashOut(nPlayers, nMax) {
  var nOthers = nPlayers - 1;
  var nCells = 27;

  signal input hash;
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nMax][4];
  signal input ciphertextPartials[nOthers][nMax][4];
  signal input ciphertextCardCells[nCells][4];
  signal input nCalled;
  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nMax];
  signal input plaintextCells[nCells];
  signal input coefficients[3];

  signal output out;

  component showdown;
  component hashOut;

  showdown = Showdown90(nPlayers, nMax);
  showdown.hash <== hash;
  showdown.publicKeys <== publicKeys;
  showdown.playerIndex <== playerIndex;
  showdown.ciphertextCards <== ciphertextCards;
  showdown.ciphertextPartials <== ciphertextPartials;
  showdown.ciphertextCardCells <== ciphertextCardCells;
  showdown.nCalled <== nCalled;
  showdown.privateKey <== privateKey;
  showdown.publicKey <== publicKey;
  showdown.plaintextCards <== plaintextCards;
  showdown.plaintextCells <== plaintextCells;

  hashOut = ShowdownPolynomialHash(3);
  hashOut.results <== showdown.packed;
  hashOut.coefficients <== coefficients;
  out <== hashOut.out;
}
