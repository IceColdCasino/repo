/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./hash.circom";
include "./elgamal.circom";
include "./partials.circom";
include "./deck.circom";
include "./showdown.circom";
include "./showdown_seal.circom";
include "./blackjack_constants.circom";
include "./blackjack_hand_eval.circom";

template VerifyShoeDecryptedCards(nTotalCards) {
  signal input plaintextCards[nTotalCards];
  signal input decryptedCards[nTotalCards][2];
  signal input nUsedCards;
  
  signal match[nTotalCards];

  component deck;
  component isEqual[nTotalCards][2];
  component ltUsed[nTotalCards];

  deck = InstantiateDeck(nTotalCards, 52);
  deck.cards <== plaintextCards;

  for (var c = 0; c < nTotalCards; c++) {
    for (var i = 0; i < 2; i++) {
      isEqual[c][i] = IsEqual();
      isEqual[c][i].in <== [
        decryptedCards[c][i],
        deck.out[c][i]
      ];
    }

    match[c] <== isEqual[c][0].out * isEqual[c][1].out;

    // Constrain decrypt≡plaintext only for used slots (c < nUsedCards).
    ltUsed[c] = LessThan(5);
    ltUsed[c].in[0] <== c;
    ltUsed[c].in[1] <== nUsedCards;
    ltUsed[c].out * (1 - match[c]) === 0;
  }
}

template BlackjackShowdownHashMain(nPlayers, nTotalCards) {
  var nOthers = nPlayers - 1;

  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nOthers][nTotalCards][4];
  signal input playerCardCount;
  signal input dealerCardCount;
  signal input sealCommitment;

  signal output out;

  component h1;
  component _h2[nPlayers];
  component h2;
  component finalHash;

  h1 = parallel HashPublicKeys(nPlayers);
  h1.publicKeys <== publicKeys;

  h2 = parallel Poseidon(nPlayers);

  for (var p = 0; p < nPlayers; p++) {
    _h2[p] = parallel HashCiphertexts(nTotalCards);
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
  finalHash.inputs <== [
    playerCardCount,
    dealerCardCount,
    h1.out,
    playerIndex,
    h2.out,
    sealCommitment
  ];

  out <== finalHash.out;
}

// One-hand showdown: decrypts THIS hand + dealer only (24 cards).
// Bust hands settle via action proof and must not use this circuit.
template Showdown(nPlayers) {
  var nTotalCards = maxOneHandShowdownCards();
  var nOthers = nPlayers - 1;

  // Public input
  signal input hash;

  // Hashed Private inputs
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nOthers][nTotalCards][4];
  signal input playerCardCount;
  signal input dealerCardCount;
  signal input sealCommitment;

  // Non-hashed Private inputs
  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nTotalCards];

  signal output out;

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

  hashMain = parallel BlackjackShowdownHashMain(nPlayers, nTotalCards);
  hashMain.publicKeys <== publicKeys;
  hashMain.playerIndex <== playerIndex;
  hashMain.ciphertextCards <== ciphertextCards;
  hashMain.ciphertextPartials <== ciphertextPartials;
  hashMain.playerCardCount <== playerCardCount;
  hashMain.dealerCardCount <== dealerCardCount;
  hashMain.sealCommitment <== sealCommitment;
  hash === hashMain.out;

  decryptPartials = parallel DecryptPartials(nPlayers, nTotalCards);
  decryptPartials.ciphertextPartials <== ciphertextPartials;
  decryptPartials.privateKey <== privateKey;

  createOwnPartials = parallel CreateOwnPartials(nTotalCards);
  createOwnPartials.ciphertextCards <== ciphertextCards;
  createOwnPartials.privateKey <== privateKey;

  handEval = parallel EvaluateHand();
  handEval.cards <== plaintextCards;
  handEval.playerCardCount <== playerCardCount;
  handEval.dealerCardCount <== dealerCardCount;

  aggregatePartials = AggregatePartials(nPlayers, nTotalCards);
  aggregatePartials.ownPartials <== createOwnPartials.ownPartials;
  aggregatePartials.otherPartials <== decryptPartials.partials;
  aggregatePartials.ciphertextCards <== ciphertextCards;

  verifyDecryptedCards = parallel VerifyShoeDecryptedCards(nTotalCards);
  verifyDecryptedCards.plaintextCards <== plaintextCards;
  verifyDecryptedCards.decryptedCards <== aggregatePartials.decryptedCards;
  verifyDecryptedCards.nUsedCards <== playerCardCount + dealerCardCount;

  out <== handEval.out;
}

template ShowdownHashOut(nPlayers) {
  var nTotalCards = maxOneHandShowdownCards();

  // Poseidon of the hashed inputs, including the seal commitment.
  signal input hash;

  // Hashed Private inputs
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nPlayers - 1][nTotalCards][4];
  signal input playerCardCount;
  signal input dealerCardCount;
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
  showdown.publicKey <== publicKey;
  showdown.privateKey <== privateKey;
  showdown.ciphertextCards <== ciphertextCards;
  showdown.ciphertextPartials <== ciphertextPartials;
  showdown.plaintextCards <== plaintextCards;
  showdown.playerCardCount <== playerCardCount;
  showdown.dealerCardCount <== dealerCardCount;

  hashOut = SealedShowdownHash(2);
  hashOut.sealCommitment <== sealCommitment;
  hashOut.results <== [showdown.out, 0];
  hashOut.coefficients <== coefficients;

  out <== hashOut.out;
}
