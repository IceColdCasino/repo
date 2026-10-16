/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./partials.circom";
include "./showdown.circom";
include "./showdown_seal.circom";
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
  }

  for (var i = 0; i < nMax; i++) {
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
  signal input sealCommitment;

  signal output out;

  component h1;
  component _h2[nPlayers];
  component h2;
  component cardHash;
  component finalHash;

  h1 = parallel HashPublicKeys(nPlayers);
  h1.publicKeys <== publicKeys;

  cardHash = parallel HashCiphertexts(nCells);
  cardHash.ciphertext <== ciphertextCardCells;

  h2 = parallel Poseidon(nPlayers);
  for (var p = 0; p < nPlayers; p++) {
    _h2[p] = parallel HashCiphertexts(nMax);
    if (p == 0) {
      _h2[p].ciphertext <== ciphertextCards;
    } else {
      _h2[p].ciphertext <== ciphertextPartials[p - 1];
    }
  }
  for (var p = 0; p < nPlayers; p++) {
    h2.inputs[p] <== _h2[p].out;
  }

  finalHash = Poseidon(7);
  finalHash.inputs <== [h1.out, playerIndex, h2.out, cardHash.out, patternId, nCalled, sealCommitment];
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
  signal input sealCommitment;

  signal output out;

  component h1;
  component _h2[nPlayers];
  component h2;
  component cardHash;
  component finalHash;

  h1 = parallel HashPublicKeys(nPlayers);
  h1.publicKeys <== publicKeys;

  cardHash = parallel HashCiphertexts(nCells);
  cardHash.ciphertext <== ciphertextCardCells;

  h2 = parallel Poseidon(nPlayers);
  for (var p = 0; p < nPlayers; p++) {
    _h2[p] = parallel HashCiphertexts(nMax);
    if (p == 0) {
      _h2[p].ciphertext <== ciphertextCards;
    } else {
      _h2[p].ciphertext <== ciphertextPartials[p - 1];
    }
  }
  for (var p = 0; p < nPlayers; p++) {
    h2.inputs[p] <== _h2[p].out;
  }

  finalHash = Poseidon(6);
  finalHash.inputs <== [h1.out, playerIndex, h2.out, cardHash.out, nCalled, sealCommitment];
  out <== finalHash.out;
}

template Showdown75(nPlayers, nMax) {
  var nOthers = nPlayers - 1;
  var nCells = 25;

  // Public input
  signal input hash;

  // Hashed Private inputs
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nMax][4];
  signal input ciphertextPartials[nOthers][nMax][4];
  signal input ciphertextCardCells[nCells][4];
  signal input patternId;
  signal input nCalled;
  signal input sealCommitment;

  // Non-hashed Private inputs
  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nMax];
  signal input plaintextCells[nCells];

  signal output out;

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

  publicKeyCheck = parallel PublicKeyCheck(nPlayers);
  publicKeyCheck.publicKeys <== publicKeys;
  publicKeyCheck.playerIndex <== playerIndex;
  publicKeyCheck.publicKey <== publicKey;

  verifyKey = parallel VerifyKey();
  verifyKey.privateKey <== privateKey;
  verifyKey.publicKey <== publicKey;

  patternLt = ConstrainLt(3, 3);
  patternLt.in <== patternId;
  nCalledGt = ConstrainGt(8, 0);
  nCalledGt.in <== nCalled;
  nCalledLt = ConstrainLt(8, nMax + 1);
  nCalledLt.in <== nCalled;

  hashMain = parallel BingoShowdownHashMain75(nPlayers, nMax, nCells);
  hashMain.publicKeys <== publicKeys;
  hashMain.playerIndex <== playerIndex;
  hashMain.ciphertextCards <== ciphertextCards;
  hashMain.ciphertextPartials <== ciphertextPartials;
  hashMain.ciphertextCardCells <== ciphertextCardCells;
  hashMain.patternId <== patternId;
  hashMain.nCalled <== nCalled;

  decryptPartials = parallel DecryptPartials(nPlayers, nMax);
  decryptPartials.ciphertextPartials <== ciphertextPartials;
  decryptPartials.privateKey <== privateKey;

  decryptCells = parallel DecryptBets(nCells);
  decryptCells.ciphertextBets <== ciphertextCardCells;
  decryptCells.privateKey <== privateKey;

  createOwnPartials = parallel CreateOwnPartials(nMax);
  createOwnPartials.ciphertextCards <== ciphertextCards;
  createOwnPartials.privateKey <== privateKey;

  eval = parallel Evaluate75(nMax);
  eval.cells <== plaintextCells;
  eval.balls <== plaintextCards;
  eval.nCalled <== nCalled;
  eval.patternId <== patternId;

  hashMain.sealCommitment <== sealCommitment;
  hash === hashMain.out;

  aggregatePartials = AggregatePartials(nPlayers, nMax);
  aggregatePartials.ownPartials <== createOwnPartials.ownPartials;
  aggregatePartials.otherPartials <== decryptPartials.partials;
  aggregatePartials.ciphertextCards <== ciphertextCards;

  verifyBalls = parallel VerifyCalledBalls(nMax, 75);
  verifyBalls.plaintextCards <== plaintextCards;
  verifyBalls.decryptedCards <== aggregatePartials.decryptedCards;
  verifyBalls.nCalled <== nCalled;

  verifyCells = parallel VerifyDecryptedBets(nCells);
  verifyCells.decryptedBets <== decryptCells.decryptedBets;
  verifyCells.plaintextBets <== plaintextCells;

  out <== eval.packed;
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
  signal input sealCommitment;

  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nMax];
  signal input plaintextCells[nCells];

  signal output out[3];

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

  publicKeyCheck = parallel PublicKeyCheck(nPlayers);
  publicKeyCheck.publicKeys <== publicKeys;
  publicKeyCheck.playerIndex <== playerIndex;
  publicKeyCheck.publicKey <== publicKey;

  verifyKey = parallel VerifyKey();
  verifyKey.privateKey <== privateKey;
  verifyKey.publicKey <== publicKey;

  nCalledGt = ConstrainGt(8, 0);
  nCalledGt.in <== nCalled;
  nCalledLt = ConstrainLt(8, nMax + 1);
  nCalledLt.in <== nCalled;

  hashMain = parallel BingoShowdownHashMain90(nPlayers, nMax, nCells);
  hashMain.publicKeys <== publicKeys;
  hashMain.playerIndex <== playerIndex;
  hashMain.ciphertextCards <== ciphertextCards;
  hashMain.ciphertextPartials <== ciphertextPartials;
  hashMain.ciphertextCardCells <== ciphertextCardCells;
  hashMain.nCalled <== nCalled;

  decryptPartials = parallel DecryptPartials(nPlayers, nMax);
  decryptPartials.ciphertextPartials <== ciphertextPartials;
  decryptPartials.privateKey <== privateKey;

  decryptCells = parallel DecryptBets(nCells);
  decryptCells.ciphertextBets <== ciphertextCardCells;
  decryptCells.privateKey <== privateKey;

  createOwnPartials = parallel CreateOwnPartials(nMax);
  createOwnPartials.ciphertextCards <== ciphertextCards;
  createOwnPartials.privateKey <== privateKey;

  eval = parallel Evaluate90(nMax);
  eval.cells <== plaintextCells;
  eval.balls <== plaintextCards;
  eval.nCalled <== nCalled;

  hashMain.sealCommitment <== sealCommitment;
  hash === hashMain.out;

  aggregatePartials = AggregatePartials(nPlayers, nMax);
  aggregatePartials.ownPartials <== createOwnPartials.ownPartials;
  aggregatePartials.otherPartials <== decryptPartials.partials;
  aggregatePartials.ciphertextCards <== ciphertextCards;

  verifyBalls = parallel VerifyCalledBalls(nMax, 90);
  verifyBalls.plaintextCards <== plaintextCards;
  verifyBalls.decryptedCards <== aggregatePartials.decryptedCards;
  verifyBalls.nCalled <== nCalled;

  verifyCells = parallel VerifyDecryptedBets(nCells);
  verifyCells.decryptedBets <== decryptCells.decryptedBets;
  verifyCells.plaintextBets <== plaintextCells;

  out <== eval.packed;
}

template Showdown75HashOut(nPlayers, nMax) {
  var nOthers = nPlayers - 1;
  var nCells = 25;

  // Poseidon of the hashed inputs, including the seal commitment.
  signal input hash;

  // Hashed Private inputs
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nMax][4];
  signal input ciphertextPartials[nOthers][nMax][4];
  signal input ciphertextCardCells[nCells][4];
  signal input patternId;
  signal input nCalled;
  signal input sealCommitment;

  // Non-hashed private inputs
  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nMax];
  signal input plaintextCells[nCells];
  signal input coefficients[2];

  signal output out;

  component showdown;
  component hashOut;

  showdown = Showdown75(nPlayers, nMax);
  showdown.hash <== hash;
  showdown.sealCommitment <== sealCommitment;
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

  hashOut = SealedShowdownHash(2);
  hashOut.sealCommitment <== sealCommitment;
  hashOut.results <== [showdown.out, 0];
  hashOut.coefficients <== coefficients;

  out <== hashOut.out;
}

template Showdown90HashOut(nPlayers, nMax) {
  var nOthers = nPlayers - 1;
  var nCells = 27;

  // Poseidon of the hashed inputs, including the seal commitment.
  signal input hash;

  // Hashed Private inputs
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nMax][4];
  signal input ciphertextPartials[nOthers][nMax][4];
  signal input ciphertextCardCells[nCells][4];
  signal input nCalled;
  signal input sealCommitment;

  // Non-hashed private inputs
  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nMax];
  signal input plaintextCells[nCells];
  signal input coefficients[2];

  signal output out;

  component showdown;
  component hashOut;

  showdown = Showdown90(nPlayers, nMax);
  showdown.hash <== hash;
  showdown.sealCommitment <== sealCommitment;
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

  // Each prize is 0 or 256 + call (call is 1..90), so at most 346.
  // 512 is above that, so one line + two lines * 512 + full house * 512^2
  // is one coefficient. The second limb stays 0.
  signal packedPrize;
  packedPrize <== showdown.out[0] + showdown.out[1] * 512 + showdown.out[2] * 262144;

  hashOut = SealedShowdownHash(2);
  hashOut.sealCommitment <== sealCommitment;
  hashOut.results <== [packedPrize, 0];
  hashOut.coefficients <== coefficients;
  out <== hashOut.out;
}
