/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./partials.circom";
include "./deck.circom";
include "./showdown.circom";
include "./showdown_seal.circom";
include "./war_hand_eval.circom";

template Showdown(nPlayers) {
  var nOthers = nPlayers - 1;
  var nTotalCards = 4;

  // Public input
  signal input hash;

  // Hashed Private inputs
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nOthers][nTotalCards][4];
  signal input sealCommitment;

  // Non-hashed Private inputs
  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nTotalCards];

  signal output out; // 0 = player, 1 = dealer, 2 = tie

  component publicKeyCheck;
  component verifyKey;
  component hashMain;
  component decryptPartials;
  component createOwnPartials;
  component aggregatePartials;
  component verifyDecryptedCards;
  component handEval;

  publicKeyCheck = parallel PublicKeyCheck(nPlayers);
  publicKeyCheck.publicKeys <== publicKeys;
  publicKeyCheck.playerIndex <== playerIndex;
  publicKeyCheck.publicKey <== publicKey;

  verifyKey = parallel VerifyKey();
  verifyKey.privateKey <== privateKey;
  verifyKey.publicKey <== publicKey;

  hashMain = parallel HashMain(nPlayers, nTotalCards);
  hashMain.publicKeys <== publicKeys;
  hashMain.playerIndex <== playerIndex;
  hashMain.ciphertextCards <== ciphertextCards;
  hashMain.ciphertextPartials <== ciphertextPartials;

  decryptPartials = parallel DecryptPartials(nPlayers, nTotalCards);
  decryptPartials.ciphertextPartials <== ciphertextPartials;
  decryptPartials.privateKey <== privateKey;

  createOwnPartials = parallel CreateOwnPartials(nTotalCards);
  createOwnPartials.ciphertextCards <== ciphertextCards;
  createOwnPartials.privateKey <== privateKey;

  handEval = parallel EvaluateHands();
  handEval.cards <== plaintextCards;

  hashMain.sealCommitment <== sealCommitment;
  hash === hashMain.out;

  aggregatePartials = AggregatePartials(nPlayers, nTotalCards);
  aggregatePartials.ownPartials <== createOwnPartials.ownPartials;
  aggregatePartials.otherPartials <== decryptPartials.partials;
  aggregatePartials.ciphertextCards <== ciphertextCards;

  verifyDecryptedCards = parallel VerifyDecryptedCards(nTotalCards, 52);
  verifyDecryptedCards.plaintextCards <== plaintextCards;
  verifyDecryptedCards.decryptedCards <== aggregatePartials.decryptedCards;

  out <== handEval.winner;
}

template ShowdownHashOut(nPlayers) {
  var nOthers = nPlayers - 1;
  var nTotalCards = 4;

  // Poseidon of the hashed inputs, including the seal commitment.
  signal input hash;

  // Hashed Private inputs
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nOthers][nTotalCards][4];
  signal input sealCommitment;

  // Non-hashed Private inputs
  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nTotalCards];
  signal input coefficients[2];

  signal output out;

  component showdown;
  component hashOut;

  showdown = Showdown(nPlayers);
  showdown.hash <== hash;
  showdown.sealCommitment <== sealCommitment;
  showdown.publicKeys <== publicKeys;
  showdown.playerIndex <== playerIndex;
  showdown.ciphertextCards <== ciphertextCards;
  showdown.publicKey <== publicKey;
  showdown.ciphertextPartials <== ciphertextPartials;
  showdown.privateKey <== privateKey;
  showdown.plaintextCards <== plaintextCards;

  hashOut = SealedShowdownHash(2);
  hashOut.sealCommitment <== sealCommitment;
  hashOut.results <== [showdown.out, 0];
  hashOut.coefficients <== coefficients;

  out <== hashOut.out;
}
