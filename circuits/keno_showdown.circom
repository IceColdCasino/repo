/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./partials.circom";
include "./showdown.circom";
include "./hash.circom";
include "./keno_bet.circom";
include "./keno_eval.circom";

template KenoShowdownHashMain(nPlayers, nSelection, nBets) {
  var nOthers = nPlayers - 1;

  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nSelection][4];
  signal input ciphertextPartials[nOthers][nSelection][4];
  signal input ciphertextBets[nBets][4];
  signal input nActualBets;

  signal output out;

  component h1;
  component _h2[nPlayers];
  component h2;
  component betHash;
  component finalHash;

  h1 = HashPublicKeys(nPlayers);
  h1.publicKeys <== publicKeys;

  h2 = Poseidon(nPlayers);
  for (var p = 0; p < nPlayers; p++) {
    _h2[p] = parallel HashCiphertexts(nSelection);
    if (p == 0) {
      _h2[p].ciphertext <== ciphertextCards;
    } else {
      _h2[p].ciphertext <== ciphertextPartials[p - 1];
    }
    h2.inputs[p] <== _h2[p].out;
  }

  betHash = HashCiphertexts(nBets);
  betHash.ciphertext <== ciphertextBets;

  finalHash = Poseidon(5);
  finalHash.inputs <== [
    h1.out,
    playerIndex,
    h2.out,
    betHash.out,
    nActualBets
  ];

  out <== finalHash.out;
}

template Showdown(nPlayers, nSelection, nBets) {
  assert(nSelection >= 1 && nSelection <= 20);
  assert(nBets >= 1 && nBets <= 20);

  var nOthers = nPlayers - 1;

  signal input hash;

  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nSelection][4];
  signal input ciphertextPartials[nOthers][nSelection][4];
  signal input ciphertextBets[nBets][4];
  signal input nActualBets;

  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nSelection];
  signal input plaintextBets[nBets];

  signal output out;

  component publicKeyCheck;
  component verifyKey;
  component hashMain;
  component decryptPartials;
  component decryptBets;
  component createOwnPartials;
  component aggregatePartials;
  component verifyDecryptedCards;
  component verifyDecryptedBets;
  component eval;

  publicKeyCheck = PublicKeyCheck(nPlayers);
  publicKeyCheck.publicKeys <== publicKeys;
  publicKeyCheck.playerIndex <== playerIndex;
  publicKeyCheck.publicKey <== publicKey;

  verifyKey = VerifyKey();
  verifyKey.privateKey <== privateKey;
  verifyKey.publicKey <== publicKey;

  hashMain = KenoShowdownHashMain(nPlayers, nSelection, nBets);
  hashMain.publicKeys <== publicKeys;
  hashMain.playerIndex <== playerIndex;
  hashMain.ciphertextCards <== ciphertextCards;
  hashMain.ciphertextPartials <== ciphertextPartials;
  hashMain.ciphertextBets <== ciphertextBets;
  hashMain.nActualBets <== nActualBets;
  hash === hashMain.out;

  decryptPartials = parallel DecryptPartials(nPlayers, nSelection);
  decryptPartials.ciphertextPartials <== ciphertextPartials;
  decryptPartials.privateKey <== privateKey;

  decryptBets = parallel DecryptBets(nBets);
  decryptBets.ciphertextBets <== ciphertextBets;
  decryptBets.privateKey <== privateKey;

  createOwnPartials = parallel CreateOwnPartials(nSelection);
  createOwnPartials.ciphertextCards <== ciphertextCards;
  createOwnPartials.privateKey <== privateKey;

  aggregatePartials = AggregatePartials(nPlayers, nSelection);
  aggregatePartials.ownPartials <== createOwnPartials.ownPartials;
  aggregatePartials.otherPartials <== decryptPartials.partials;
  aggregatePartials.ciphertextCards <== ciphertextCards;

  verifyDecryptedCards = VerifyDecryptedCards(nSelection, 1, 80);
  verifyDecryptedCards.plaintextCards <== plaintextCards;
  verifyDecryptedCards.decryptedCards <== aggregatePartials.decryptedCards;

  verifyDecryptedBets = VerifyDecryptedBets(nBets);
  verifyDecryptedBets.decryptedBets <== decryptBets.decryptedBets;
  verifyDecryptedBets.plaintextBets <== plaintextBets;

  eval = Evaluate(nBets, nSelection);
  eval.plaintextValues <== plaintextCards;
  eval.plaintextBets <== plaintextBets;
  eval.nActualBets <== nActualBets;

  out <== eval.out;
}

template ShowdownHashOut(nPlayers, nSelection, nBets) {
  var nOthers = nPlayers - 1;

  signal input hash;

  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nSelection][4];
  signal input ciphertextPartials[nOthers][nSelection][4];
  signal input ciphertextBets[nBets][4];
  signal input nActualBets;

  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nSelection];
  signal input plaintextBets[nBets];
  signal input coefficients[1];

  signal output out;

  component showdown;
  component hashOut;

  showdown = Showdown(nPlayers, nSelection, nBets);
  showdown.hash <== hash;
  showdown.publicKeys <== publicKeys;
  showdown.playerIndex <== playerIndex;
  showdown.ciphertextCards <== ciphertextCards;
  showdown.ciphertextPartials <== ciphertextPartials;
  showdown.ciphertextBets <== ciphertextBets;
  showdown.nActualBets <== nActualBets;
  showdown.privateKey <== privateKey;
  showdown.publicKey <== publicKey;
  showdown.plaintextCards <== plaintextCards;
  showdown.plaintextBets <== plaintextBets;

  hashOut = ShowdownPolynomialHash(1);
  hashOut.results <== [showdown.out];
  hashOut.coefficients <== coefficients;

  out <== hashOut.out;
}
