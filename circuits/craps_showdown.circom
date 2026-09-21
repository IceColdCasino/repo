/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./partials.circom";
include "./showdown.circom";
include "./hash.circom";
include "./craps_eval.circom";
include "./craps_bet.circom";
include "./craps_bet_eval.circom";

template CrapsShowdownHashMain(nPlayers, nDice, nBets) {
  var nOthers = nPlayers - 1;

  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nDice][4];
  signal input ciphertextPartials[nOthers][nDice][4];
  signal input ciphertextBets[nBets][4];
  signal input nActualBets;
  signal input phase;
  signal input point;

  signal output out;

  component h1;
  component _h2[nPlayers];
  component h2;
  component betHash;
  component tableBind;
  component finalHash;

  h1 = HashPublicKeys(nPlayers);
  h1.publicKeys <== publicKeys;

  h2 = Poseidon(nPlayers);
  for (var p = 0; p < nPlayers; p++) {
    _h2[p] = parallel HashCiphertexts(nDice);
    if (p == 0) {
      _h2[p].ciphertext <== ciphertextCards;
    } else {
      _h2[p].ciphertext <== ciphertextPartials[p - 1];
    }
    h2.inputs[p] <== _h2[p].out;
  }

  betHash = HashCiphertexts(nBets);
  betHash.ciphertext <== ciphertextBets;

  tableBind = Poseidon(3);
  tableBind.inputs <== [nActualBets, phase, point];

  finalHash = Poseidon(5);
  finalHash.inputs <== [
    h1.out,
    playerIndex,
    h2.out,
    betHash.out,
    tableBind.out
  ];

  out <== finalHash.out;
}

template Showdown(nPlayers, nDice, nFaces, nBets) {
  assert(nBets >= 1 && nBets <= 12);

  var nOthers = nPlayers - 1;

  signal input hash;

  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nDice][4];
  signal input ciphertextPartials[nOthers][nDice][4];
  signal input ciphertextBets[nBets][4];
  signal input nActualBets;
  signal input phase;
  signal input point;

  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nDice];
  signal input plaintextBets[nBets][2];

  // 12 bet codes, then table action + pointOut (14 poly-hash terms).
  signal output out[nBets + 2];

  component publicKeyCheck;
  component verifyKey;
  component hashMain;
  component decryptPartials;
  component decryptBets;
  component createOwnPartials;
  component aggregatePartials;
  component verifyDecryptedCards;
  component verifyDecryptedBets;
  component tableEval;
  component betEval;

  phase * (phase - 1) === 0;

  publicKeyCheck = PublicKeyCheck(nPlayers);
  publicKeyCheck.publicKeys <== publicKeys;
  publicKeyCheck.playerIndex <== playerIndex;
  publicKeyCheck.publicKey <== publicKey;

  verifyKey = VerifyKey();
  verifyKey.privateKey <== privateKey;
  verifyKey.publicKey <== publicKey;

  hashMain = CrapsShowdownHashMain(nPlayers, nDice, nBets);
  hashMain.publicKeys <== publicKeys;
  hashMain.playerIndex <== playerIndex;
  hashMain.ciphertextCards <== ciphertextCards;
  hashMain.ciphertextPartials <== ciphertextPartials;
  hashMain.ciphertextBets <== ciphertextBets;
  hashMain.nActualBets <== nActualBets;
  hashMain.phase <== phase;
  hashMain.point <== point;
  hash === hashMain.out;

  decryptPartials = parallel DecryptPartials(nPlayers, nDice);
  decryptPartials.ciphertextPartials <== ciphertextPartials;
  decryptPartials.privateKey <== privateKey;

  decryptBets = parallel DecryptBets(nBets);
  decryptBets.ciphertextBets <== ciphertextBets;
  decryptBets.privateKey <== privateKey;

  createOwnPartials = parallel CreateOwnPartials(nDice);
  createOwnPartials.ciphertextCards <== ciphertextCards;
  createOwnPartials.privateKey <== privateKey;

  aggregatePartials = AggregatePartials(nPlayers, nDice);
  aggregatePartials.ownPartials <== createOwnPartials.ownPartials;
  aggregatePartials.otherPartials <== decryptPartials.partials;
  aggregatePartials.ciphertextCards <== ciphertextCards;

  verifyDecryptedCards = VerifyDecryptedCards(nDice, 1, nFaces);
  verifyDecryptedCards.plaintextCards <== plaintextCards;
  verifyDecryptedCards.decryptedCards <== aggregatePartials.decryptedCards;

  verifyDecryptedBets = VerifyDecryptedBets(nBets);
  verifyDecryptedBets.decryptedBets <== decryptBets.decryptedBets;
  verifyDecryptedBets.plaintextBets <== plaintextBets;

  tableEval = CrapsEval();
  tableEval.diceValues <== plaintextCards;
  tableEval.phase <== phase;
  tableEval.point <== point;

  betEval = EvaluateCrapsBets(nBets);
  betEval.diceValues <== plaintextCards;
  betEval.phase <== phase;
  betEval.point <== point;
  betEval.in <== plaintextBets;
  betEval.nActualBets <== nActualBets;

  for (var i = 0; i < nBets; i++) {
    out[i] <== betEval.out[i];
  }
  out[nBets] <== tableEval.action;
  out[nBets + 1] <== tableEval.pointOut;
}

template ShowdownHashOut(nPlayers, nDice, nFaces, nBets) {
  var nOthers = nPlayers - 1;

  signal input hash;

  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nDice][4];
  signal input ciphertextPartials[nOthers][nDice][4];
  signal input ciphertextBets[nBets][4];
  signal input nActualBets;
  signal input phase;
  signal input point;

  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nDice];
  signal input plaintextBets[nBets][2];
  signal input coefficients[nBets + 2];

  signal output out;

  component showdown;
  component hashOut;

  showdown = Showdown(nPlayers, nDice, nFaces, nBets);
  showdown.hash <== hash;
  showdown.publicKeys <== publicKeys;
  showdown.playerIndex <== playerIndex;
  showdown.ciphertextCards <== ciphertextCards;
  showdown.ciphertextPartials <== ciphertextPartials;
  showdown.ciphertextBets <== ciphertextBets;
  showdown.nActualBets <== nActualBets;
  showdown.phase <== phase;
  showdown.point <== point;
  showdown.privateKey <== privateKey;
  showdown.publicKey <== publicKey;
  showdown.plaintextCards <== plaintextCards;
  showdown.plaintextBets <== plaintextBets;

  hashOut = ShowdownPolynomialHash(nBets + 2);
  hashOut.results <== showdown.out;
  hashOut.coefficients <== coefficients;

  out <== hashOut.out;
}
